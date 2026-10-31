import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { Session } from "../src/browser.ts";
import { verifySearchFilters } from "../src/operations/navigation.ts";
import { fixture } from "./fixture.ts";
import { liveFixture } from "./live-fixture.ts";
import { AdapterCoverage } from "./support/adapter-coverage.ts";

test(
	"isolated Chrome: sessions, reads, guarded writes and receipts",
	{ skip: process.env.DY_TEST_BROWSER !== "1", timeout: 120000 },
	async (t) => {
		const directory = await mkdtemp(join(tmpdir(), "dy-browser-"));
		const app = new App({ state_dir: directory, timeout: 15000 });
		const signal = AbortSignal.timeout(110000);
		let witness: Session | undefined;
		t.after(async () => {
			await app.chrome.stop(AbortSignal.timeout(5000)).catch(() => undefined);
			await witness?.close();
			// Chrome keeps a few profile files open briefly after the process is
			// gone, so the first unlink can race with a write and fail with
			// ENOTEMPTY. Retry rather than let cleanup fail the whole test: the
			// tests inside it already passed, and a leftover temp directory is not
			// a product defect.
			await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }).catch(() => undefined);
		});
		await app.execute("browser.start", { headless: true }, signal);
		witness = await app.chrome.connect(signal);
		// Coverage for src/page/ is opt-in: it costs a CDP session per measured
		// call, and the ordinary run should not pay for a report nobody reads.
		// DY_COVER_PAGE=1 writes it to dist/page-coverage.json.
		let coverage: AdapterCoverage | undefined;
		if (process.env.DY_COVER_PAGE === "1") {
			coverage = new AdapterCoverage(await readFile(new URL("../dist/page-adapter.js", import.meta.url), "utf8"));
			const context = witness.tab.context();
			const covering = coverage;
			await covering.start({ newCDPSession: (page) => context.newCDPSession(page) }, witness.tab);
			// Every operation goes through Session.call, so sampling there catches
			// all of them without each test having to remember to report.
			const original = Session.prototype.call;
			Session.prototype.call = async function instrumented(this: Session, operation: string, args: object = {}) {
				try {
					return await original.call(this, operation, args);
				} finally {
					await covering.collect();
				}
			} as typeof Session.prototype.call;
			void original;
			t.after(() => {
				Session.prototype.call = original;
				covering.writeReport(new URL("../dist/page-coverage.json", import.meta.url).pathname);
			});
		}

		await witness.tab.route("**/*", async (route) => {
			const origin = new URL(route.request().url()).origin;
			if (origin === "https://www.douyin.com") await route.fulfill({ contentType: "text/html", body: fixture });
			// Live rooms are a different host, so they cannot be a route inside the
			// works fixture. The room id decides which state is served.
			else if (origin === "https://live.douyin.com")
				await route.fulfill({
					contentType: "text/html",
					body: liveFixture(new URL(route.request().url()).pathname.includes("88888") ? "ended" : "live"),
				});
			else if (route.request().url() === "https://media.example/tainted.svg")
				await route.fulfill({
					contentType: "image/svg+xml",
					body: '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>',
				});
			else await route.abort();
		});

		await t.test("navigation and session persistence between independent connections", async () => {
			const opened = (await app.execute("video.open", { resource: "12345" }, signal)) as { video: { id: string } };
			assert.equal(opened.video.id, "12345");
			const status = (await app.execute("video.info", {}, signal)) as { video: { id: string } };
			assert.equal(status.video.id, "12345");
			const next = (await app.execute("feed.next", {}, signal)) as { video: { id: string } };
			assert.equal(next.video.id, "67890");
			await app.execute("feed.previous", {}, signal);
		});

		await t.test("a seek moves playback and refuses a position past the end", async () => {
			// The fixture's video has no media, so a real duration cannot be seeked.
			// What can be checked is that the position reaches the element and that
			// a request the work cannot satisfy is refused rather than clamped.
			await app.execute("video.open", { resource: "12345" }, signal);
			await witness?.tab.evaluate(() => {
				const video = document.querySelector("video") as HTMLVideoElement & { __duration?: number };
				Object.defineProperty(video, "duration", { get: () => 120, configurable: true });
			});
			await assert.rejects(app.execute("video.seek", { position: 500 }, signal), {
				code: "invalid_argument",
			});
			await assert.rejects(app.execute("video.seek", { position: -1 }, signal), {
				code: "invalid_argument",
			});
		});

		await t.test("a press swallowed on an unchanged slide is retried once", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			// The first press is ignored and the page stays put. Retrying is safe
			// here precisely because the page is still on the work it started from.
			await witness?.tab.evaluate(() => Reflect.set(window, "swallowOnce", true));
			const next = (await app.execute("feed.next", {}, signal)) as { video: { id: string } };
			assert.equal(next.video.id, "67890");
			assert.equal(await witness?.tab.evaluate("window.swallowed"), 1);
			await app.execute("feed.previous", {}, signal);
		});

		await t.test("reading a work closes the chat panel, but not over a draft", async () => {
			// The panel is an overlay, not a different page: a read does not need it.
			// Closing is refused while the composer holds a draft, and that refusal
			// is the point — a read must never discard an unsent message.
			await app.execute("video.open", { resource: "12345" }, signal);
			await app.execute("chat.list", {}, signal);
			await witness?.tab.evaluate(() => {
				const im = document.querySelector("#im");
				if (im instanceof HTMLElement) im.style.display = "block";
			});
			const editor = witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]');
			await editor?.fill("还没写完的话");
			await assert.rejects(app.execute("video.info", {}, signal), (error: unknown) => {
				assert.equal((error as { code: string }).code, "identity_mismatch");
				return true;
			});
			// The draft survived, and the panel is still open.
			assert.equal(
				await witness?.tab.locator("#im").evaluate((element) => (element as HTMLElement).style.display),
				"block",
			);
			await editor?.fill("");
			const read = (await app.execute("video.info", {}, signal)) as { video: { id: string } };
			assert.equal(read.video.id, "12345");
			assert.equal(
				await witness?.tab.locator("#im").evaluate((element) => (element as HTMLElement).style.display),
				"none",
			);
		});

		await t.test("the feed moves off a live slide, which has no work identity", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			await app.execute("feed.next", {}, signal);
			// The next press lands on the live slide, which carries no work id at
			// all. The one after that is swallowed by the live player overlay, so
			// the second attempt is what actually moves the feed.
			const live = (await app.execute("feed.next", {}, signal)) as {
				page_kind: string;
				slide: { kind: string; id: string };
			};
			assert.equal(live.page_kind, "live");
			assert.equal(live.slide.kind, "live");
			assert.equal(live.slide.id, "live_host_two");
			const off = (await app.execute("feed.next", {}, signal)) as { page_kind: string; video: { id: string } };
			assert.equal(off.page_kind, "video");
			assert.equal(off.video.id, "67890");
			await app.execute("feed.previous", {}, signal);
		});

		await t.test("two connections to one workspace share the tab and attribute operation facts", async () => {
			// One installation, one browser session: a second connection reads the
			// same tab and writes to the same log, and the lease still keeps them
			// from interleaving.
			await app.execute("init", { name: "小抖" }, signal);
			const first = new App({ state_dir: directory });
			const second = new App({ state_dir: directory });
			const left = (await first.execute("video.info", {}, signal)) as { video: { id: string } };
			const right = (await second.execute("video.info", {}, signal)) as { video: { id: string } };
			assert.equal(left.video.id, right.video.id);
			assert.equal(first.store.directory, second.store.directory);
			assert.ok((await first.store.events()).some((event) => event.bot_id === "default"));
			await first.store.withLock(async () => {
				await assert.rejects(second.execute("video.info", {}, signal), { code: "busy" });
			});
		});

		await t.test("reads and screenshots return actual fixture evidence", async () => {
			const comments = (await app.execute("comment.list", {}, signal)) as {
				items: {
					id: string;
					text: string;
					author: string;
					kind: string;
					voice?: { transcript: string | null; duration: number | null };
				}[];
			};
			assert.equal(comments.items[0].id, "10001");
			assert.equal(comments.items[0].text, "原始评论");
			// A row shaped like the live page: no content attribute, author in an
			// ALink, body indistinguishable from chrome except by structure.
			const live = comments.items.find((item) => item.id === "10002");
			assert.equal(live?.text, "这是没有标记属性的评论正文");
			assert.equal(live?.author, "真实作者");
			// A comment can @ people, and every mention is a /user/ link inside the
			// body. Counting them as author candidates made the author ambiguous, so
			// the field came back empty on any comment that mentioned someone.
			const mentions = comments.items.find((item) => item.id === "10007");
			assert.equal(mentions?.author, "提人作者");
			assert.match(mentions?.text ?? "", /@朋友一/);
			// An image-only comment has no body. The fallback that picks the longest
			// free text found the author's name in the header and reported the name
			// as the comment, so every image comment read as if the author had
			// written their own nickname.
			const imageOnly = comments.items.find((item) => item.id === "10008");
			assert.equal(imageOnly?.author, "图片作者");
			assert.equal(imageOnly?.text, "");
			assert.equal(imageOnly?.kind, "image");
			// An emoji inside a comment is an inline image. The body must come back
			// with the character the reader sees, and must never be the timestamp:
			// the paragraph is not childless, so picking childless leaves alone
			// skipped the sentence and fell through to "1周前·广东".
			const emoji = comments.items.find((item) => item.id === "10004");
			assert.equal(emoji?.text, "夏天会收尾，青春和歌声不会✨");
			assert.equal(emoji?.author, "第三作者");
			// A voice comment is a player, not text. One with a transcript reads it;
			// one without is still listed, marked as voice, with its duration.
			const voice = comments.items.find((item) => item.id === "10006");
			assert.equal(voice?.kind, "voice");
			assert.equal(voice?.voice?.transcript, "这段我觉得很有味道");
			assert.equal(voice?.voice?.duration, 12);
			const silent = comments.items.find((item) => item.id === "10005");
			assert.equal(silent?.kind, "voice");
			assert.equal(silent?.voice?.transcript, null);
			assert.equal(silent?.voice?.duration, 3);
			assert.equal(comments.items[0].kind, "text");
			const capture = (await app.execute("video.screenshot", {}, signal)) as { path: string };
			assert.deepEqual((await readFile(capture.path)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			const search = (await app.execute("search", { query: "测试" }, signal)) as { items: { id: string }[] };
			assert.deepEqual(
				search.items.map((item) => item.id),
				["12345", "67890"],
			);
			await app.execute("video.open", { resource: "12345" }, signal);
		});

		await t.test("search filters verify controls without claiming results refreshed", async () => {
			const result = (await app.execute("search", { query: "测试", sort: "newest", published: "week" }, signal)) as {
				filters: { selected: { sort: string; published: string }; results_verified: boolean };
			};
			assert.deepEqual(result.filters.selected, { sort: "newest", published: "week" });
			assert.equal(result.filters.results_verified, false);
			await witness?.tab.locator('[data-index1="0"][data-index2="0"]').evaluate((element: HTMLElement) => {
				element.click();
			});
			if (!witness) throw new Error("Missing browser session");
			await assert.rejects(verifySearchFilters(witness, { query: "测试", sort: "newest", published: "week" }, signal), {
				code: "identity_mismatch",
			});
			await witness.tab.locator('[data-index1="0"][data-index2="1"]').evaluate((element: HTMLElement) => {
				element.click();
			});
			const baseline = await witness.call<{ selected: number[]; marker: string }>("search.filters.state", {
				query: "测试",
			});
			await witness.tab.locator('[data-index1="2"][data-index2="1"]').evaluate((element: HTMLElement) => {
				element.click();
			});
			await assert.rejects(
				verifySearchFilters(
					witness,
					{ query: "测试", sort: "newest", published: "week" },
					signal,
					baseline.selected,
					baseline.marker,
				),
				{ code: "identity_mismatch" },
			);
			await witness?.tab.evaluate(() => {
				document.querySelectorAll(".sDNqBVWH").forEach((element) => {
					element.classList.remove("sDNqBVWH");
					element.classList.add("first-only");
				});
			});
			await assert.rejects(witness?.call("search.filters.state", { query: "测试" }) ?? Promise.resolve(), {
				code: "selector_changed",
			});
			await witness?.tab.evaluate(() => {
				document.querySelectorAll(".first-only").forEach((element) => {
					element.classList.remove("first-only");
					element.classList.add("sDNqBVWH");
				});
			});
			await witness?.tab.evaluate(() => {
				const option = document.querySelector('[data-index1="0"][data-index2="0"]');
				if (!option) throw new Error("Missing fixture option");
				option.parentElement?.append(option.cloneNode(true));
			});
			await assert.rejects(witness?.call("search.filters.state", { query: "测试" }) ?? Promise.resolve(), {
				code: "selector_changed",
			});
			await app.execute("video.open", { resource: "12345" }, signal);
		});

		await t.test("reply expansion is bounded, asynchronous and rejects ambiguous controls", async () => {
			await witness?.tab.evaluate(() => {
				const parent = document.querySelector('[data-comment-id="10001"]');
				if (!parent) throw new Error("Missing parent");
				const button = document.createElement("button");
				button.textContent = "展开2条回复";
				button.id = "test-expand";
				let page = 0;
				button.onclick = () => {
					page++;
					setTimeout(() => {
						const row = document.createElement("div");
						row.dataset.e2e = "comment-item";
						row.dataset.commentId = String(10100 + page);
						row.innerHTML = '<span data-e2e="comment-content">测试回复</span>';
						parent.append(row);
						if (page === 1) button.textContent = "查看更多回复";
						else button.remove();
					}, 100);
				};
				parent.append(button);
			});
			const result = (await app.execute(
				"comment.replies",
				{ video_id: "12345", comment_id: "10001", steps: 3 },
				signal,
			)) as {
				items: { id: string; parent_id: string }[];
				clicks: number;
				stop: string;
				complete: boolean;
			};
			assert.deepEqual(
				result.items.map((row) => row.id),
				["10101", "10102"],
			);
			assert.ok(result.items.every((row) => row.parent_id === "10001"));
			assert.equal(result.clicks, 2);
			assert.equal(result.stop, "no_control");
			assert.equal(result.complete, false);
			await witness?.tab.evaluate(() => {
				const parent = document.querySelector('[data-comment-id="10001"]');
				for (let index = 0; index < 2; index++) {
					const button = document.createElement("button");
					button.className = "test-duplicate-expand";
					button.textContent = "展开1条回复";
					parent?.append(button);
				}
			});
			await assert.rejects(app.execute("comment.replies", { video_id: "12345", comment_id: "10001" }, signal), {
				code: "selector_changed",
			});
			await witness?.tab.evaluate(() => {
				document
					.querySelectorAll('.test-duplicate-expand,[data-comment-id="10101"],[data-comment-id="10102"]')
					.forEach((element) => {
						element.remove();
					});
			});
			await witness?.tab.evaluate(() => {
				const button = document.createElement("button");
				button.id = "test-no-progress";
				button.textContent = "展开1条回复";
				document.querySelector('[data-comment-id="10001"]')?.append(button);
			});
			const stalled = (await app.execute(
				"comment.replies",
				{ video_id: "12345", comment_id: "10001", steps: 3 },
				signal,
			)) as { clicks: number; stop: string };
			assert.equal(stalled.clicks, 1);
			assert.equal(stalled.stop, "no_progress");
			await assert.rejects(app.execute("comment.replies", { video_id: "67890", comment_id: "10001" }, signal), {
				code: "identity_mismatch",
			});
			await witness?.tab.evaluate(() => {
				document.querySelector("#test-no-progress")?.remove();
			});
			await witness?.tab.evaluate(() => {
				const button = document.createElement("button");
				button.id = "test-changed-work";
				button.textContent = "展开1条回复";
				button.onclick = () => {
					button.dataset.clicked = "true";
				};
				document.querySelector('[data-comment-id="10001"]')?.append(button);
			});
			const point = await witness?.call<{ x: number; y: number }>("comment.expand", {
				video_id: "12345",
				comment_id: "10001",
				token: "test-change-work",
			});
			await witness?.tab.evaluate(() => {
				document.querySelector("#player")?.setAttribute("data-video-id", "67890");
				const player = document.querySelector('[data-e2e="player-container"]');
				if (player) player.className = "video_67890";
				history.replaceState({}, "", "/video/67890");
			});
			if (!point) throw new Error("Missing expansion point");
			await witness?.tab.mouse.click(point.x, point.y);
			assert.equal(await witness?.tab.locator("#test-changed-work").getAttribute("data-clicked"), null);
			await app.execute("video.open", { resource: "12345" }, signal);
		});

		await t.test("observation reports when the video is outside the viewport", async () => {
			await witness?.tab.evaluate(() => {
				const spacer = document.createElement("div");
				spacer.id = "viewport-spacer-test";
				spacer.style.height = "3000px";
				document.body.append(spacer);
				window.scrollTo(0, 2000);
			});
			const observation = (await app.execute("video.observe", { seconds: 1, frames: 2 }, signal)) as {
				frames: { state: { video: { viewport_intersects: boolean } } }[];
			};
			assert.equal(observation.frames.length, 2);
			assert.ok(observation.frames.every((frame) => frame.state.video.viewport_intersects === false));
			await witness?.tab.evaluate(() => {
				document.querySelector("#viewport-spacer-test")?.remove();
				window.scrollTo(0, 0);
			});
		});

		await t.test("comment author identity accepts duplicate links only when IDs agree", async () => {
			await witness?.tab.evaluate(() => {
				const list = document.querySelector('[data-e2e="comment-list"]');
				for (const [id, second] of [
					["10020", "self_123"],
					["10021", "other_123"],
				]) {
					const row = document.createElement("div");
					row.dataset.e2e = "comment-item";
					row.dataset.commentId = id;
					row.innerHTML = `<a class="ALink-a" href="/user/self_123">作者</a><a class="ALink-a" href="/user/${second}">作者</a><span data-e2e="comment-content">测试评论</span>`;
					list?.append(row);
				}
			});
			const rows = await witness?.call<{ id: string; mine: boolean }[]>("comment.list", {
				video_id: "12345",
				self_id: "self_123",
			});
			assert.equal(rows?.find((row) => row.id === "10020")?.mine, true);
			assert.equal(rows?.find((row) => row.id === "10021")?.mine, false);
			await witness?.tab.evaluate(() => {
				document.querySelector('[data-comment-id="10020"]')?.remove();
				document.querySelector('[data-comment-id="10021"]')?.remove();
			});
		});

		await t.test("comment image selection checks work and draft before the file event", async () => {
			const bytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
				"base64",
			);
			const args = {
				video_id: "12345",
				token: "comment-image-test",
				file_name: "image.png",
				file_size: bytes.length,
				file_mime: "image/png",
			};
			await witness?.call("comment.image.prepare", { ...args, token: "old-comment-image-guard" });
			const prepared = await witness?.call<{ selector: string }>("comment.image.prepare", args);
			assert.equal(await witness?.tab.locator(prepared?.selector ?? "#missing").count(), 1);
			await witness?.call("comment.image.preflight", args);
			await witness?.tab
				.locator('[data-e2e="comment-image-input"]')
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			const state = await witness?.call<{ accepted: boolean; blocked: boolean }>("comment.image.state", args);
			assert.equal(state?.accepted, true);
			assert.equal(state?.blocked, false);
			assert.equal(await witness?.tab.evaluate("window.commentImageUploads"), 1);
			await witness?.call("comment.image.cleanup", args);
			await witness?.tab.locator("#comment-image-preview-fixture").waitFor();
			await witness?.tab.locator("#comment-image-preview-fixture").evaluate((element) => {
				element.remove();
			});
			await witness?.tab.locator('[data-e2e="comment-image-input"]').setInputFiles([]);
			await witness?.tab.locator("textarea").fill("已有评论草稿");
			await assert.rejects(witness?.call("comment.image.prepare", args) ?? Promise.resolve(), {
				code: "draft_conflict",
			});
			assert.equal(await witness?.tab.locator("textarea").inputValue(), "已有评论草稿");
			await witness?.tab.locator("textarea").fill("");
			await witness?.call("comment.image.prepare", { ...args, token: "comment-image-reply-race" });
			await witness?.tab.evaluate(() => {
				const marker = document.createElement("span");
				marker.id = "reply-marker-race";
				marker.dataset.e2e = "comment-reply-target";
				document.querySelector('[data-e2e="comment-composer"]')?.append(marker);
			});
			await witness?.tab
				.locator('[data-e2e="comment-image-input"]')
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			const changed = await witness?.call<{ blocked: boolean }>("comment.image.state", {
				...args,
				token: "comment-image-reply-race",
			});
			assert.equal(changed?.blocked, true);
			assert.equal(await witness?.tab.evaluate("window.commentImageUploads"), 1);
			await witness?.call("comment.image.cleanup", { token: "comment-image-reply-race" });
			await witness?.tab.evaluate(() => {
				document.querySelector("#reply-marker-race")?.remove();
			});
			await witness?.tab.locator('[data-e2e="comment-image-input"]').setInputFiles([]);
			await witness?.call("comment.image.prepare", { ...args, token: "comment-image-draft-race" });
			await witness?.call("comment.image.preflight", { token: "comment-image-draft-race" });
			await witness?.tab.evaluate(() => {
				const image = document.createElement("img");
				image.id = "comment-draft-race";
				document.querySelector('[data-e2e="comment-composer"]')?.append(image);
			});
			await witness?.tab
				.locator('[data-e2e="comment-image-input"]')
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			const draftChanged = await witness?.call<{ blocked: boolean }>("comment.image.state", {
				...args,
				token: "comment-image-draft-race",
			});
			assert.equal(draftChanged?.blocked, true);
			assert.equal(await witness?.tab.evaluate("window.commentImageUploads"), 1);
			await witness?.call("comment.image.cleanup", { token: "comment-image-draft-race" });
			await witness?.tab.evaluate(() => {
				document.querySelector("#comment-draft-race")?.remove();
			});
			await witness?.tab.locator('[data-e2e="comment-image-input"]').setInputFiles([]);
		});

		await t.test("image-only comments can be posted once and read from loaded rows", async () => {
			const path = join(directory, "comment-image-test.png");
			await writeFile(
				path,
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
					"base64",
				),
			);
			const input = { video_id: "12345", image: path, request_id: "fixture-comment-image" };
			await assert.rejects(app.execute("comment.image", input, signal), { code: "delivery_uncertain" });
			const receipt = (await app.store.receipts())[input.request_id];
			assert.equal(receipt.status, "dispatching");
			assert.equal(receipt.media_stage, "send_dispatched");
			assert.deepEqual(receipt.comment_observation, {
				preview_verified: true,
				publish_dispatched: true,
				delivery_verified: false,
			});
			assert.equal(await witness?.tab.evaluate("window.commentImagePosts"), 1);
			await assert.rejects(app.execute("comment.image", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.commentImagePosts"), 1);
			await witness?.tab.evaluate(() => {
				const row = document.createElement("div");
				row.id = "image-only-comment";
				row.dataset.e2e = "comment-item";
				row.dataset.commentId = "10088";
				row.innerHTML =
					'<img data-e2e="comment-image" width="40" height="40" src="data:image/svg+xml,%3Csvg xmlns=\'http://www.w3.org/2000/svg\' width=\'40\' height=\'40\'%3E%3C/svg%3E">';
				document.querySelector('[data-e2e="comment-list"]')?.prepend(row);
			});
			const list = (await app.execute("comment.list", { video_id: "12345" }, signal)) as {
				items: { id: string; text: string; images: unknown[] }[];
			};
			const row = list.items.find((item) => item.id === "10088");
			assert.equal(row?.text, "");
			assert.equal(row?.images.length, 1);
			await witness?.tab.evaluate(() => {
				document.querySelector("#image-only-comment")?.remove();
			});
		});

		await t.test("comment image confirmation refuses user intervention and changed previews", async () => {
			const bytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
				"base64",
			);
			const args = {
				video_id: "12345",
				token: "comment-confirm-interference",
				file_name: "image.png",
				file_size: bytes.length,
				file_mime: "image/png",
				file_sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			await witness?.call("comment.image.prepare", args);
			await witness?.tab
				.locator('[data-e2e="comment-image-input"]')
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			await witness?.tab.locator("#comment-image-preview-fixture").waitFor();
			await assert.rejects(
				witness?.call("comment.image.confirm.prepare", { ...args, file_sha256: "0".repeat(64) }) ?? Promise.resolve(),
				{ code: "identity_mismatch" },
			);
			const point = await witness?.call<{ selector: string }>("comment.image.confirm.prepare", args);
			if (!point) throw new Error("Missing publish control");
			const before = await witness?.tab.evaluate("window.commentImagePosts");
			await witness?.tab.locator("textarea").click();
			await witness?.tab.locator(point.selector).click();
			assert.equal(await witness?.tab.evaluate("window.commentImagePosts"), before);
			const state = await witness?.call<{ blocked: boolean }>("comment.image.confirm.state", args);
			assert.equal(state?.blocked, true);
			await witness?.call("comment.image.cleanup", args);
			await witness?.tab.locator("#comment-image-preview-fixture").evaluate((element) => {
				element.remove();
			});
			await witness?.tab.locator('[data-e2e="comment-image-input"]').setInputFiles([]);
		});

		await t.test("a matching reply is not evidence of a top-level comment", async () => {
			const args = { action: "comment.post", video_id: "12345", text: "相同正文", token: "comment-parent-check" };
			await witness?.call("prepare-write", args);
			await witness?.tab.evaluate(() => {
				const row = document.createElement("div");
				row.id = "other-parent-comment";
				row.dataset.e2e = "comment-item";
				row.dataset.commentId = "76543";
				row.dataset.parentCommentId = "10001";
				row.dataset.isSelf = "true";
				row.innerHTML = '<span data-e2e="comment-content">相同正文</span>';
				document.querySelector('[data-e2e="comment-list"]')?.append(row);
				const state = Reflect.get(window, "__douyinCLI");
				if (state) Object.assign(state, { dispatched: true });
			});
			const result = await witness?.call<{ record: unknown; loaded_matching_rows: number }>("write-result", args);
			assert.equal(result?.record, null);
			assert.equal(result?.loaded_matching_rows, 0);
			await witness?.tab.evaluate(() => {
				document.querySelector("#other-parent-comment")?.remove();
			});
			await witness?.call("cleanup");
		});

		await t.test("desired-state toggles do not blindly toggle twice", async () => {
			await app.execute("video.like", { video_id: "12345", enabled: true }, signal);
			const replay = (await app.execute("video.like", { video_id: "12345", enabled: true }, signal)) as {
				changed: boolean;
			};
			assert.equal(replay.changed, false);
			assert.equal(await witness?.tab.locator('[data-e2e="video-player-digg"]').getAttribute("aria-pressed"), "true");
		});

		await t.test("comments preserve text and repeated request IDs never click again", async () => {
			const input = { video_id: "12345", text: "精确的一条评论", request_id: "fixture-comment-01" };
			// The fixture marks its own comment rows, so ownership is provable and the
			// send confirms. A page that marks nothing still reports uncertainty; that
			// case is covered by the self-alias test below.
			const posted = (await app.execute("comment.post", input, signal)) as {
				confirmed: boolean;
				result: { record: { id: string; text: string } };
			};
			assert.equal(posted.confirmed, true);
			assert.equal(posted.result.record.id, "20001");
			assert.equal(posted.result.record.text, "精确的一条评论");
			// The write reaches the work's author, so the event carries that account
			// and the relationship card built from events can name the person.
			const events = await app.store.events();
			const written = events.filter((event) => event.operation === "comment.post").at(-1);
			assert.equal((written?.data as { user_id?: string })?.user_id, "author_123");
			const reply = (await app.execute("comment.post", input, signal)) as { replayed: boolean };
			assert.equal(reply.replayed, true);
			assert.equal(await witness?.tab.evaluate("window.commentSends"), 1);
			await assert.rejects(app.execute("comment.post", { ...input, text: "different" }, signal), {
				code: "idempotency_conflict",
			});
			await witness?.tab.evaluate(() => {
				const button = document.createElement("button");
				button.textContent = "展开1条回复";
				button.onclick = () => button.remove();
				document.querySelector('[data-comment-id="10001"]')?.append(button);
			});
			// A reply lands under its parent, and the fixture marks it as its own, so
			// this send is provable the same way a top-level comment is.
			const replyPosted = (await app.execute(
				"comment.reply",
				{ video_id: "12345", comment_id: "10001", text: "回复内容", request_id: "fixture-reply-01" },
				signal,
			)) as { confirmed: boolean; result: { record: { parent_id: string } } };
			assert.equal(replyPosted.confirmed, true);
			assert.equal(replyPosted.result.record.parent_id, "10001");
			assert.equal(await witness?.tab.evaluate("window.commentSends"), 2);
			// The reply reached the comment's author, not the work's. The fixture
			// makes them different ids precisely so this cannot pass by accident.
			const afterReply = (await app.store.events()).filter((event) => event.operation === "comment.reply").at(-1);
			assert.equal((afterReply?.data as { user_id?: string })?.user_id, "guest_456");
			assert.equal((afterReply?.data as { work_author_id?: string })?.work_author_id, "author_123");
		});

		await t.test("comment self alias returns an explicit uncertainty without resending", async () => {
			await witness?.tab.evaluate(() => {
				const self = document.querySelector<HTMLAnchorElement>(".tab-user_self a");
				if (self) self.href = "/user/self";
				const list = document.querySelector('[data-e2e="comment-list"]');
				if (!list) throw new Error("Missing comment list");
				const observer = new MutationObserver((records) => {
					for (const record of records)
						for (const node of record.addedNodes) {
							if (node instanceof HTMLElement) delete node.dataset.isSelf;
						}
				});
				observer.observe(list, { childList: true });
				Reflect.set(window, "dySelfObserver", observer);
			});
			const input = { video_id: "12345", text: "评论身份待核对", request_id: "fixture-self-uncertain" };
			await assert.rejects(app.execute("comment.post", input, signal), (error: unknown) => {
				assert.equal((error as { code: string }).code, "delivery_uncertain");
				assert.equal((error as { details?: { reason?: string } }).details?.reason, "comment_self_identity_unavailable");
				return true;
			});
			const sent = await witness?.tab.evaluate("window.commentSends");
			await assert.rejects(app.execute("comment.post", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.commentSends"), sent);
			await witness?.tab.evaluate(() => {
				const observer = Reflect.get(window, "dySelfObserver");
				if (observer instanceof MutationObserver) observer.disconnect();
				const self = document.querySelector<HTMLAnchorElement>(".tab-user_self a");
				if (self) self.href = "/user/self_123";
			});
		});

		await t.test("the composer avatar identifies the signed-in account when the nav says self", async () => {
			// On the work page the nav link is the literal /user/self, which no row
			// carries. The composer's own avatar is the signed-in profile link, and
			// that is what makes a delivered comment provable.
			await witness?.tab.evaluate(() => {
				const self = document.querySelector<HTMLAnchorElement>(".tab-user_self a");
				if (self) self.href = "/user/self";
				const composer = document.querySelector('[data-e2e="comment-composer"]');
				const avatar = document.createElement("a");
				avatar.id = "composer-self";
				avatar.href = "/user/self_123";
				composer?.prepend(avatar);
			});
			const posted = (await app.execute(
				"comment.post",
				{ video_id: "12345", text: "身份来自输入框头像", request_id: "fixture-composer-self" },
				signal,
			)) as { confirmed: boolean };
			assert.equal(posted.confirmed, true);
			await witness?.tab.evaluate(() => {
				document.querySelector("#composer-self")?.remove();
				const self = document.querySelector<HTMLAnchorElement>(".tab-user_self a");
				if (self) self.href = "/user/self_123";
			});
		});

		await t.test("reply binding never treats matching or truncated names as comment identity", async () => {
			await witness?.tab.evaluate(() => {
				const composer = document.querySelector('[data-e2e="comment-composer"]');
				const marker = document.createElement("span");
				marker.id = "placeholder-test";
				marker.textContent = "回复@真实作者";
				composer?.append(marker);
				const list = document.querySelector('[data-e2e="comment-list"]');
				const duplicate = document.createElement("div");
				duplicate.dataset.e2e = "comment-item";
				duplicate.dataset.commentId = "10003";
				duplicate.innerHTML = '<a class="ALink-a" href="/user/other">真实作者</a>';
				list?.append(duplicate);
			});
			assert.equal(
				(await witness?.call<{ bound_to: string | null }>("comment.reply.state", { comment_id: "10002" }))?.bound_to,
				null,
			);
			await witness?.tab.locator("#placeholder-test").evaluate((element) => {
				element.textContent = "回复@真实";
			});
			assert.equal(
				(await witness?.call<{ bound_to: string | null }>("comment.reply.state", { comment_id: "10002" }))?.bound_to,
				null,
			);
			await witness?.tab.evaluate(() => {
				const row = document.querySelector("#tooltip_10002")?.closest('[data-e2e="comment-item"]');
				const active = document.createElement("span");
				active.id = "reply-active-test";
				active.textContent = "回复中";
				row?.append(active);
			});
			assert.equal(
				(await witness?.call<{ bound_to: string | null }>("comment.reply.state", { comment_id: "10002" }))?.bound_to,
				"10002",
			);
			await witness?.tab.evaluate(() => {
				document.querySelector("#placeholder-test")?.remove();
				document.querySelector("#reply-active-test")?.remove();
				document.querySelector('[data-comment-id="10003"]')?.remove();
			});
		});

		await t.test("mismatched targets and existing drafts cannot dispatch", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			await assert.rejects(
				app.execute("comment.post", { video_id: "99999", text: "wrong", request_id: "fixture-wrong-01" }, signal),
				{ code: "identity_mismatch" },
			);
			await witness?.tab.locator("textarea").fill("existing draft");
			await assert.rejects(
				app.execute("comment.post", { video_id: "12345", text: "new", request_id: "fixture-draft-01" }, signal),
				{ code: "draft_conflict" },
			);
			assert.equal(await witness?.tab.locator("textarea").inputValue(), "existing draft");
			await witness?.tab.locator("textarea").fill("");
		});

		await t.test("private messages bind the conversation and preserve an unverified receipt", async () => {
			const contacts = (await app.execute("chat.list", {}, signal)) as { id: string }[];
			assert.equal(contacts[0].id, "native:30001");
			const read = (await app.execute("chat.read", { conversation_id: contacts[0].id }, signal)) as {
				messages: { id: string }[];
				scope: string;
				complete: boolean;
			};
			assert.equal(read.messages[0].id, "30001");
			assert.equal(read.scope, "loaded_dom");
			assert.equal(read.complete, false);
			await witness?.tab.evaluate(() => {
				const list = document.querySelector('[data-e2e="message-list"]');
				const row = document.createElement("div");
				row.id = "media-privacy-test";
				row.dataset.e2e = "message-row";
				row.dataset.messageId = "88888";
				row.innerHTML =
					'<div data-e2e="message-content"><div data-e2e="message-image"><img src="https://cdn.example/image?token=private-token" alt="fixture"></div></div>';
				list?.append(row);
				const share = document.createElement("div");
				share.id = "note-share-test";
				share.dataset.e2e = "message-row";
				share.dataset.messageId = "88889";
				share.innerHTML =
					'<div data-e2e="message-content"><div data-e2e="shared-video-card"><a href="https://www.douyin.com/note/70001?secret=private-token">图文</a></div></div>';
				list?.append(share);
				const voice = document.createElement("div");
				voice.id = "voice-fixture";
				voice.dataset.e2e = "message-row";
				voice.dataset.messageId = "88891";
				voice.innerHTML =
					'<div data-e2e="message-content"><div data-e2e="message-voice"><span data-e2e="voice-transcript">页面转写</span></div></div>';
				list?.append(voice);
			});
			const media = (await app.execute("chat.read", { conversation_id: contacts[0].id }, signal)) as {
				messages: {
					id: string;
					image?: { images: { src: null; source_available: boolean }[] };
					share?: { url: string; is_image_post: boolean };
					voice?: { native_audio_present: boolean; source_available: boolean | null; transcript: string | null };
				}[];
			};
			assert.equal(JSON.stringify(media).includes("private-token"), false);
			assert.deepEqual(media.messages.find((row) => row.id === "88888")?.image?.images[0]?.src, null);
			assert.equal(media.messages.find((row) => row.id === "88888")?.image?.images[0]?.source_available, true);
			assert.equal(media.messages.find((row) => row.id === "88889")?.share?.url, "https://www.douyin.com/note/70001");
			assert.equal(media.messages.find((row) => row.id === "88889")?.share?.is_image_post, true);
			assert.deepEqual(media.messages.find((row) => row.id === "88891")?.voice, {
				native_audio_present: false,
				duration_seconds: null,
				ready_state: null,
				source_available: null,
				transcript: "页面转写",
			});
			assert.equal(JSON.stringify(await app.store.events()).includes("private-token"), false);
			await witness?.tab.evaluate(() => {
				const row = document.createElement("div");
				row.id = "capture-image-test";
				row.dataset.e2e = "message-row";
				row.dataset.messageId = "88890";
				row.innerHTML =
					"<div data-e2e=\"message-content\"><div data-e2e=\"message-image\"><img width=\"40\" height=\"40\" src=\"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='40' height='40'%3E%3Crect width='40' height='40' fill='red'/%3E%3C/svg%3E\"></div></div>";
				document.querySelector('[data-e2e="message-list"]')?.append(row);
			});
			await witness?.tab.locator("#capture-image-test img").evaluate((image: HTMLImageElement) => image.decode());
			await witness?.tab.evaluate(() => {
				const list = document.querySelector<HTMLElement>('[data-e2e="message-list"]');
				const row = document.querySelector("#capture-image-test");
				if (!list || !row) throw new Error("Missing image fixture");
				list.style.height = "120px";
				list.style.overflow = "auto";
				const spacer = document.createElement("div");
				spacer.id = "capture-spacer-test";
				spacer.style.height = "600px";
				list.insertBefore(spacer, row);
				list.scrollTop = 0;
			});
			await witness?.tab.evaluate(() => {
				const row = document.querySelector<HTMLElement>("#capture-image-test");
				const content = row?.querySelector<HTMLElement>('[data-e2e="message-content"]');
				if (row && content) {
					delete row.dataset.messageId;
					content.dataset.messageId = "88890";
				}
			});
			await witness?.call("chat.capture.prepare", {
				conversation_id: contacts[0].id,
				message_id: "88890",
				index: 1,
				token: "content-id-test",
			});
			await witness?.call("chat.capture.verify", { token: "content-id-test" });
			await witness?.call("chat.capture.cleanup", { token: "content-id-test" });
			await witness?.call("chat.capture.prepare", {
				conversation_id: contacts[0].id,
				message_id: "88890",
				index: 1,
				token: "covered-image-test",
			});
			const beforeOverlay = await witness?.call<{ base64: string }>("chat.capture.pixels", {
				token: "covered-image-test",
			});
			await witness?.tab.evaluate(() => {
				const rect = document.querySelector("#capture-image-test img")?.getBoundingClientRect();
				if (!rect) throw new Error("Missing image");
				const overlay = document.createElement("div");
				overlay.id = "capture-overlay-test";
				Object.assign(overlay.style, {
					position: "fixed",
					left: `${rect.left}px`,
					top: `${rect.top}px`,
					width: `${rect.width}px`,
					height: `${rect.height}px`,
					zIndex: "9999",
					background: "black",
					pointerEvents: "none",
				});
				document.body.append(overlay);
			});
			const withOverlay = await witness?.call<{ base64: string }>("chat.capture.pixels", {
				token: "covered-image-test",
			});
			assert.equal(withOverlay?.base64, beforeOverlay?.base64);
			await witness?.tab.evaluate(() => {
				document.querySelector("#capture-overlay-test")?.remove();
			});
			await witness?.call("chat.capture.cleanup", { token: "covered-image-test" });
			const output = join(directory, "chat-capture.png");
			const captured = (await app.execute(
				"chat.capture",
				{ conversation_id: contacts[0].id, message_id: "88890", output },
				signal,
			)) as { scope: string };
			assert.equal(captured.scope, "decoded_image");
			assert.deepEqual((await readFile(output)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			await assert.rejects(
				app.execute("chat.capture", { conversation_id: contacts[0].id, message_id: "88890", output }, signal),
				{ code: "revision_conflict" },
			);
			await assert.rejects(
				app.execute("chat.capture", { conversation_id: contacts[0].id, message_id: "no-such-message" }, signal),
				{ code: "selector_changed" },
			);
			await witness?.tab.locator("#capture-image-test img").evaluate((image: HTMLImageElement) => {
				image.src = "https://media.example/tainted.svg";
			});
			await witness?.tab.locator("#capture-image-test img").evaluate((image: HTMLImageElement) => image.decode());
			const blockedOutput = join(directory, "blocked-capture.png");
			await assert.rejects(
				app.execute(
					"chat.capture",
					{ conversation_id: contacts[0].id, message_id: "88890", output: blockedOutput },
					signal,
				),
				{ code: "unsupported_media" },
			);
			await assert.rejects(readFile(blockedOutput), { code: "ENOENT" });
			await witness?.call("chat.capture.prepare", {
				conversation_id: contacts[0].id,
				message_id: "88890",
				index: 1,
				token: "changed-image-test",
			});
			await witness?.tab.locator("#capture-image-test img").evaluate((image: HTMLImageElement) => {
				image.src = "data:image/png;base64,broken";
			});
			await assert.rejects(witness?.call("chat.capture.verify", { token: "changed-image-test" }) ?? Promise.resolve(), {
				code: "identity_mismatch",
			});
			await witness?.call("chat.capture.cleanup", { token: "changed-image-test" });
			await witness?.tab.evaluate(() => {
				document.querySelector("#media-privacy-test")?.remove();
				document.querySelector("#note-share-test")?.remove();
				document.querySelector("#voice-fixture")?.remove();
				document.querySelector("#capture-image-test")?.remove();
				document.querySelector("#capture-spacer-test")?.remove();
				const list = document.querySelector<HTMLElement>('[data-e2e="message-list"]');
				if (list) {
					list.style.height = "";
					list.style.overflow = "";
				}
			});
			const input = {
				conversation_id: contacts[0].id,
				text: "回复好友",
				reply_to: "30001",
				request_id: "fixture-message-01",
			};
			await assert.rejects(app.execute("chat.send", input, signal), (error: unknown) => {
				assert.equal((error as { code: string }).code, "delivery_uncertain");
				assert.equal((error as { details?: { reason?: string } }).details?.reason, "message_latest_end_unverified");
				return true;
			});
			await assert.rejects(app.execute("chat.send", input, signal), { code: "delivery_uncertain" });
			const messageReceipt = (await app.store.receipts())[input.request_id];
			assert.deepEqual(messageReceipt.observation, {
				candidate_id: "40001",
				kind: "matching_loaded_row",
				loaded_matching_rows: 1,
				baseline_matching_text_rows: 0,
				delivery_verified: false,
			});
			assert.equal(messageReceipt.status, "dispatching");
			assert.equal(await witness?.tab.evaluate("window.sends"), 1);
		});

		await t.test("a sticker is sent from the smiley grid and its result never repeats", async () => {
			const sends = Number(await witness?.tab.evaluate("window.stickerSends"));
			const input = { conversation_id: "native:30001", emoji: "比心", request_id: "fixture-sticker-01" };
			// A sticker's own click is the send, and the platform's row carries no
			// text to match it against. The honest answer is therefore uncertain:
			// the sticker is in the conversation, but this command cannot prove
			// which row it became.
			await assert.rejects(app.execute("chat.send", input, signal), { code: "delivery_uncertain" });
			assert.equal(Number(await witness?.tab.evaluate("window.stickerSends")), sends + 1);
			const rows = await witness?.tab.evaluate(() =>
				[...document.querySelectorAll('[data-e2e="message-row"]')].map((row) => row.getAttribute("data-message-id")),
			);
			assert.ok(Array.isArray(rows) && rows.length === sends + 1 + 2, JSON.stringify(rows));
			const receipt = (await app.store.receipts())[input.request_id];
			assert.equal(receipt.status, "dispatching");
			// The same request ID answers from the receipt instead of clicking again.
			await assert.rejects(app.execute("chat.send", input, signal), { code: "delivery_uncertain" });
			assert.equal(Number(await witness?.tab.evaluate("window.stickerSends")), sends + 1);
		});

		await t.test("a sticker the grid does not offer is refused before anything is sent", async () => {
			const sends = Number(await witness?.tab.evaluate("window.stickerSends"));
			await assert.rejects(
				app.execute(
					"chat.send",
					{ conversation_id: "native:30001", emoji: "不存在的表情", request_id: "fixture-sticker-02" },
					signal,
				),
				{ code: "invalid_argument" },
			);
			assert.equal(await witness?.tab.evaluate("window.stickerSends"), sends);
		});

		await t.test("a sticker cannot be combined with text", async () => {
			await assert.rejects(
				app.execute(
					"chat.send",
					{
						conversation_id: "native:30001",
						emoji: "比心",
						text: "一起发",
						request_id: "fixture-sticker-03",
					},
					signal,
				),
				{ code: "invalid_argument" },
			);
		});

		await t.test("image upload persists an uncertain receipt and never repeats", async () => {
			const path = join(directory, "image-test.png");
			await writeFile(
				path,
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
					"base64",
				),
			);
			const input = { conversation_id: "native:30001", image: path, request_id: "fixture-image-001" };
			await assert.rejects(app.execute("chat.image", input, signal), { code: "delivery_uncertain" });
			const receipt = (await app.store.receipts())[input.request_id];
			assert.equal(receipt.status, "dispatching");
			assert.equal(receipt.media?.mime, "image/png");
			assert.equal(receipt.uncertainty_reason, "image_delivery_unverified");
			assert.equal(receipt.media_stage, "send_dispatched");
			assert.deepEqual(receipt.media_observation, {
				preview_verified: true,
				confirm_dispatched: true,
				dialog_closed: true,
				// The fixture's upload never renders a message row, so nothing new
				// appears in the conversation and delivery stays unverified — which is
				// the honest answer, not a failure of the check.
				new_media: 0,
				delivery_verified: false,
			});
			assert.equal(await witness?.tab.evaluate("window.imageUploads"), 1);
			assert.equal(await witness?.tab.evaluate("window.imageSends"), 1);
			await assert.rejects(app.execute("chat.image", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.imageUploads"), 1);
			await writeFile(path, Buffer.concat([await readFile(path), Buffer.from([1])]));
			await assert.rejects(app.execute("chat.image", input, signal), { code: "idempotency_conflict" });
			await witness?.tab.locator("input.semi-upload-hidden-input").setInputFiles([]);
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("已有草稿");
			await assert.rejects(app.execute("chat.image", { ...input, request_id: "fixture-image-draft" }, signal), {
				code: "draft_conflict",
			});
			assert.equal(
				await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').innerText(),
				"已有草稿",
			);
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("");
			await witness?.call("chat.image.prepare", {
				conversation_id: "native:30001",
				token: "draft-race",
				file_name: "image.png",
				file_size: 10,
				file_mime: "image/png",
			});
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("并发草稿");
			await assert.rejects(witness?.call("chat.image.preflight", { token: "draft-race" }) ?? Promise.resolve(), {
				code: "draft_conflict",
			});
			assert.equal(
				await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').innerText(),
				"并发草稿",
			);
			await witness?.call("chat.image.cleanup", { token: "draft-race" });
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("");
			await witness?.call("chat.image.prepare", {
				conversation_id: "native:30001",
				token: "file-race",
				file_name: "image.png",
				file_size: 10,
				file_mime: "image/png",
			});
			await witness?.tab
				.locator("input.semi-upload-hidden-input")
				.setInputFiles({ name: "user.png", mimeType: "image/png", buffer: Buffer.from([1, 2, 3]) });
			await assert.rejects(witness?.call("chat.image.preflight", { token: "file-race" }) ?? Promise.resolve(), {
				code: "draft_conflict",
			});
			assert.equal(
				await witness?.tab
					.locator("input.semi-upload-hidden-input")
					.evaluate((element: HTMLInputElement) => element.files?.[0]?.name),
				"user.png",
			);
			await witness?.call("chat.image.cleanup", { token: "file-race" });
			await witness?.tab.locator('[role="dialog"] .MsgInputSendFileModalbox').waitFor();
			await witness?.tab.locator('[role="dialog"]').evaluate((element) => {
				element.remove();
			});
			await witness?.tab.locator("input.semi-upload-hidden-input").setInputFiles([]);
		});

		await t.test("image confirmation rejects identity and draft changes", async () => {
			const bytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
				"base64",
			);
			const args = {
				conversation_id: "native:30001",
				token: "image-confirm-check",
				file_name: "image.png",
				file_size: bytes.length,
				file_mime: "image/png",
				file_sha256: createHash("sha256").update(bytes).digest("hex"),
			};
			await witness?.call("chat.image.prepare", { ...args, token: "old-chat-image-guard" });
			const prepared = await witness?.call<{ selector: string }>("chat.image.prepare", args);
			assert.equal(await witness?.tab.locator(prepared?.selector ?? "#missing").count(), 1);
			await witness?.tab
				.locator("input.semi-upload-hidden-input")
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			await witness?.tab.locator('[role="dialog"] .MsgInputSendFileModalbox').waitFor();
			await witness?.tab.evaluate(() => {
				const box = document.querySelector(".MsgInputSendFileModalbox");
				const fiber = box && Object.getOwnPropertyDescriptor(box, "__reactFiber$fixture")?.value;
				if (fiber) fiber.memoizedProps.curConversation.conversationId = "different";
			});
			await assert.rejects(witness?.call("chat.image.confirm.prepare", args) ?? Promise.resolve(), {
				code: "identity_mismatch",
			});
			await witness?.tab.evaluate(() => {
				const box = document.querySelector(".MsgInputSendFileModalbox");
				const fiber = box && Object.getOwnPropertyDescriptor(box, "__reactFiber$fixture")?.value;
				if (fiber) fiber.memoizedProps.curConversation.conversationId = "30001";
			});
			await assert.rejects(
				witness?.call("chat.image.confirm.prepare", { ...args, file_sha256: "0".repeat(64) }) ?? Promise.resolve(),
				{ code: "identity_mismatch" },
			);
			const before = await witness?.tab.evaluate("window.imageSends");
			const point = await witness?.call<{ selector: string }>("chat.image.confirm.prepare", args);
			await witness?.tab.evaluate(() => {
				const original = document.querySelector(".MsgInputSendFileModalbox textarea");
				const replacement = original?.cloneNode(true) as HTMLTextAreaElement | undefined;
				if (original && replacement) {
					replacement.value = "new draft";
					original.replaceWith(replacement);
				}
			});
			if (!point) throw new Error("Missing confirmation control");
			await witness?.tab.locator(point.selector).click();
			assert.equal(await witness?.tab.evaluate("window.imageSends"), before);
			const state = await witness?.call<{ blocked: boolean }>("chat.image.confirm.state", args);
			assert.equal(state?.blocked, true);
			await witness?.tab.locator(".MsgInputSendFileModalbox textarea").fill("");
			await witness?.tab.evaluate(() => {
				const button = document.querySelector<HTMLButtonElement>(".MsgInputSendFileModalbtnSure");
				if (button)
					button.onclick = () => {
						Reflect.set(window, "imageSends", Number(Reflect.get(window, "imageSends")) + 1);
					};
			});
			const repeat = await witness?.call<{ selector: string }>("chat.image.confirm.prepare", args);
			if (!repeat) throw new Error("Missing confirmation control");
			await witness?.tab.locator(repeat.selector).click();
			await witness?.tab.locator(repeat.selector).click();
			assert.equal(await witness?.tab.evaluate("window.imageSends"), Number(before) + 1);
			await witness?.call("chat.image.cleanup", args);
			await witness?.tab.locator('[role="dialog"]').evaluate((element) => {
				element.remove();
			});
			await witness?.tab.locator("input.semi-upload-hidden-input").setInputFiles([]);
		});

		await t.test("expired upload guards block a previously resolved file input", async () => {
			const bytes = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
				"base64",
			);
			await witness?.tab.evaluate(() => {
				const original = window.setTimeout;
				Reflect.set(window, "dyOriginalTimeout", original);
				window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
					if (timeout === 12000 && typeof handler === "function") {
						Reflect.set(window, "dyExpireUpload", handler);
						return 123456;
					}
					return original(handler, timeout, ...args);
				}) as typeof window.setTimeout;
			});
			const args = {
				conversation_id: "native:30001",
				token: "expire-image-test",
				file_name: "image.png",
				file_size: bytes.length,
				file_mime: "image/png",
			};
			await witness?.call("chat.image.prepare", args);
			const before = await witness?.tab.evaluate("window.imageUploads");
			await witness?.tab.evaluate(() => {
				const expire = Reflect.get(window, "dyExpireUpload");
				if (typeof expire === "function") expire();
			});
			await witness?.tab
				.locator("input.semi-upload-hidden-input")
				.setInputFiles({ name: "image.png", mimeType: "image/png", buffer: bytes });
			const state = await witness?.call<{ blocked: boolean; accepted: boolean }>("chat.image.state", args);
			assert.equal(state?.blocked, true);
			assert.equal(state?.accepted, false);
			assert.equal(await witness?.tab.evaluate("window.imageUploads"), before);
			await witness?.call("chat.image.cleanup", args);
			await witness?.tab.evaluate(() => {
				window.setTimeout = Reflect.get(window, "dyOriginalTimeout");
			});
			await witness?.tab.locator("input.semi-upload-hidden-input").setInputFiles([]);
		});

		await t.test("a blocked upload after a window listener remains uncertain", async () => {
			const path = join(directory, "image-guard-test.png");
			await writeFile(
				path,
				Buffer.from(
					"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/aU0AAAAASUVORK5CYII=",
					"base64",
				),
			);
			await witness?.tab.evaluate(() => {
				window.addEventListener(
					"input",
					(event) => {
						if (event.target instanceof HTMLInputElement && event.target.type === "file") {
							Reflect.set(window, "imageWindowObserved", true);
							document.querySelector('[data-e2e="chat-header"]')?.setAttribute("data-conversation-id", "changed");
						}
					},
					{ capture: true, once: true },
				);
			});
			const input = { conversation_id: "native:30001", image: path, request_id: "fixture-image-blocked" };
			await assert.rejects(app.execute("chat.image", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.imageWindowObserved"), true);
			assert.equal((await app.store.receipts())[input.request_id].status, "dispatching");
			await witness?.tab.evaluate(() => {
				document.querySelector('[data-e2e="chat-header"]')?.setAttribute("data-conversation-id", "30001");
			});
			await assert.rejects(app.execute("chat.image", input, signal), { code: "delivery_uncertain" });
			await witness?.tab.locator("input.semi-upload-hidden-input").setInputFiles([]);
		});

		await t.test("an ID-less visible message remains unverified evidence", async () => {
			await witness?.tab.evaluate(() => {
				const list = document.querySelector('[data-e2e="message-list"]');
				if (!list) throw new Error("Missing message list");
				const observer = new MutationObserver((records) => {
					for (const record of records)
						for (const node of record.addedNodes)
							if (node instanceof HTMLElement) node.removeAttribute("data-message-id");
				});
				observer.observe(list, { childList: true });
				Reflect.set(window, "dyMissingIdObserver", observer);
			});
			const input = { conversation_id: "native:30001", text: "没有稳定消息标识", request_id: "fixture-no-id-message" };
			await assert.rejects(app.execute("chat.send", input, signal), { code: "delivery_uncertain" });
			const receipt = (await app.store.receipts())[input.request_id];
			assert.deepEqual(receipt.observation, {
				candidate_id: null,
				kind: "matching_loaded_row",
				loaded_matching_rows: 1,
				baseline_matching_text_rows: 0,
				delivery_verified: false,
			});
			await witness?.tab.evaluate(() => {
				const observer = Reflect.get(window, "dyMissingIdObserver");
				if (observer instanceof MutationObserver) observer.disconnect();
			});
		});

		await t.test("conversation back accepts empty sentinel and preserves an existing draft", async () => {
			await witness?.tab.evaluate(() => {
				const button = document.createElement("button");
				button.dataset.e2e = "chat-back";
				button.textContent = "返回";
				button.addEventListener("click", () => {
					button.dataset.clicked = "yes";
				});
				document.querySelector('[data-e2e="im-dialog"]')?.append(button);
				const editor = document.querySelector('[data-e2e="msg-input"] [contenteditable="true"]');
				if (editor) editor.textContent = "\u200b";
			});
			const prepared = await witness?.call<{ x: number; y: number }>("prepare-control", {
				control: "chat.back",
				token: "empty-back",
			});
			assert.ok(prepared?.x !== undefined);
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("未发送草稿");
			if (prepared) await witness?.click(prepared);
			assert.equal(await witness?.tab.locator('[data-e2e="chat-back"]').getAttribute("data-clicked"), null);
			await assert.rejects(
				witness?.call("prepare-control", { control: "chat.back", token: "draft-back" }) ?? Promise.resolve(),
				{ code: "draft_conflict" },
			);
			assert.equal(
				await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').innerText(),
				"未发送草稿",
			);
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("");
			await witness?.tab.locator('[data-e2e="chat-back"]').evaluate((element) => element.remove());
		});

		await t.test("older history loading does not refuse a send, a new message does", async () => {
			// The real page loads history for a second or two after a conversation
			// opens. Comparing the whole loaded window meant that arriving history
			// looked exactly like someone speaking, and every first send after
			// switching conversations was refused. Both halves are checked here so
			// the fix cannot be "accept everything": a message that really arrives
			// must still stop the send.
			const args = { action: "chat.send", conversation_id: "native:30001", text: "历史测试", token: "watermark-check" };
			const prepared = await witness?.call<{ selector: string }>("prepare-write", args);
			if (!prepared) throw new Error("Missing chat editor");
			// arm-write compares the composer against the requested text, so the
			// fixture has to hold that text before the history change is checked.
			await witness?.tab.locator(prepared.selector).evaluate((element, text) => {
				const block = document.createElement("div");
				const value = document.createElement("span");
				value.dataset.string = "true";
				value.dataset.leaf = "true";
				value.textContent = text;
				const sentinel = document.createElement("span");
				sentinel.dataset.string = "true";
				sentinel.dataset.enter = "true";
				sentinel.dataset.leaf = "true";
				sentinel.textContent = "​";
				block.append(value, sentinel);
				element.replaceChildren(block);
			}, args.text);
			const list = witness?.tab.locator('[data-e2e="message-list"]');
			await list?.evaluate((element) => {
				// An older message, prepended below the newest end the way the page
				// loads it: more rows, newest one untouched.
				const row = document.createElement("div");
				row.dataset.e2e = "message-row";
				row.dataset.messageId = "29990";
				row.dataset.direction = "incoming";
				row.innerHTML = '<div data-e2e="message-content"><span data-e2e="message-text">更早的消息</span></div>';
				element.append(row);
			});
			assert.ok(await witness?.call("arm-write", args), "history loading must not refuse the send");
			await list?.evaluate((element) => {
				const row = document.createElement("div");
				row.dataset.e2e = "message-row";
				row.dataset.messageId = "30999";
				row.dataset.direction = "incoming";
				row.innerHTML = '<div data-e2e="message-content"><span data-e2e="message-text">新来的消息</span></div>';
				element.prepend(row);
			});
			await assert.rejects(witness?.call("arm-write", args) ?? Promise.resolve(), { code: "identity_mismatch" });
			await witness?.tab.locator('[data-e2e="message-list"] [data-message-id="29990"]').evaluate((e) => e.remove());
			await witness?.tab.locator('[data-e2e="message-list"] [data-message-id="30999"]').evaluate((e) => e.remove());
			await witness?.tab.locator('[data-e2e="msg-input"] [contenteditable="true"]').fill("");
			await witness?.call("cleanup");
		});

		await t.test("chat editor accepts marked placeholders but rejects unmarked changes", async () => {
			const args = { action: "chat.send", conversation_id: "native:30001", text: "测试消息", token: "sentinel-check" };
			const prepared = await witness?.call<{ selector: string }>("prepare-write", args);
			assert.ok(prepared?.selector);
			const editor = witness?.tab.locator(prepared.selector);
			await editor?.fill("测试消息\u200b");
			await assert.rejects(witness?.call("arm-write", args) ?? Promise.resolve(), { code: "draft_conflict" });
			await editor?.evaluate((element) => {
				const block = document.createElement("div");
				const text = document.createElement("span");
				text.dataset.string = "true";
				text.dataset.leaf = "true";
				text.textContent = "测试消息";
				const sentinel = document.createElement("span");
				sentinel.dataset.string = "true";
				sentinel.dataset.enter = "true";
				sentinel.dataset.leaf = "true";
				sentinel.textContent = "\u200b";
				block.append(text, sentinel);
				element.replaceChildren(block);
			});
			assert.ok(await witness?.call("arm-write", args));
			await editor?.fill("测试消息额外文字\u200b");
			await assert.rejects(witness?.call("arm-write", args) ?? Promise.resolve(), { code: "draft_conflict" });
			await editor?.fill("");
			await witness?.call("cleanup");
		});

		await t.test("chat editor validates multiline text without dropping literal zero-width characters", async () => {
			const requested = "第一行\n\n中间\u200b字符\n最后一行";
			const args = { action: "chat.send", conversation_id: "native:30001", text: requested, token: "multiline-check" };
			const prepared = await witness?.call<{ selector: string }>("prepare-write", args);
			if (!prepared) throw new Error("Missing chat editor");
			const editor = witness?.tab.locator(prepared.selector);
			await editor?.evaluate((element, requested) => {
				element.replaceChildren(
					...requested.split("\n").map((line) => {
						const block = document.createElement("div");
						const value = document.createElement("span");
						value.dataset.string = "true";
						value.dataset.leaf = "true";
						value.textContent = line;
						const sentinel = document.createElement("span");
						sentinel.dataset.string = "true";
						sentinel.dataset.enter = "true";
						sentinel.dataset.leaf = "true";
						sentinel.textContent = "\u200b";
						block.append(value, sentinel);
						return block;
					}),
				);
			}, requested);
			assert.ok(await witness?.call("arm-write", args));
			await editor?.evaluate((element) => {
				element.querySelector('[data-enter="true"]')?.removeAttribute("data-enter");
			});
			await assert.rejects(witness?.call("arm-write", args) ?? Promise.resolve(), { code: "draft_conflict" });
			await editor?.fill("");
			await witness?.call("cleanup");
		});

		await t.test("missing baseline IDs return an explicit uncertainty without resending", async () => {
			await witness?.tab.evaluate(() => {
				const row = document.createElement("div");
				row.id = "anonymous-baseline-test";
				row.dataset.e2e = "message-row";
				row.dataset.direction = "incoming";
				row.innerHTML = '<div data-e2e="message-content"><span data-e2e="message-text">没有 ID 的旧消息</span></div>';
				document.querySelector('[data-e2e="message-list"]')?.append(row);
			});
			const input = { conversation_id: "native:30001", text: "新消息", request_id: "fixture-anonymous-01" };
			await assert.rejects(app.execute("chat.send", input, signal), (error: unknown) => {
				assert.equal((error as { code: string }).code, "delivery_uncertain");
				assert.equal((error as { details?: { reason?: string } }).details?.reason, "message_history_missing_ids");
				return true;
			});
			const count = await witness?.tab.evaluate("window.sends");
			const receipt = (await app.store.receipts())[input.request_id];
			assert.equal(receipt.status, "dispatching");
			assert.equal(receipt.uncertainty_reason, "message_history_missing_ids");
			await assert.rejects(app.execute("chat.send", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.sends"), count);
			await witness?.tab.locator("#anonymous-baseline-test").evaluate((element) => element.remove());
		});

		await t.test("a delayed ID on a matching old message cannot confirm a send", async () => {
			await witness?.tab.evaluate(() => {
				const row = document.createElement("div");
				row.id = "old-message-test";
				row.dataset.e2e = "message-row";
				row.dataset.direction = "outgoing";
				row.innerHTML = '<div data-e2e="message-content"><span data-e2e="message-text">重复消息</span></div>';
				document.querySelector('[data-e2e="message-list"]')?.append(row);
			});
			const args = { action: "chat.send", conversation_id: "native:30001", text: "重复消息", token: "old-id-check" };
			await witness?.call("prepare-write", args);
			await witness?.tab.evaluate(() => {
				const row = document.querySelector<HTMLElement>("#old-message-test");
				if (row) row.dataset.messageId = "678901";
				const state = Reflect.get(window, "__douyinCLI");
				if (state) Object.assign(state, { dispatched: true });
			});
			const result = await witness?.call<{ confirmed: boolean }>("write-result", args);
			assert.equal(result?.confirmed, false);
			await witness?.tab.locator("#old-message-test").evaluate((element) => element.remove());
			await witness?.call("cleanup");
		});

		await t.test("user search returns stable IDs, de-duplicated, without the signed-in profile", async () => {
			const found = (await app.execute("user.search", { query: "旅行" }, signal)) as {
				items: { sec_uid: string; url: string; name: string; signature: string | null }[];
				complete: boolean;
				scope: string;
			};
			assert.deepEqual(
				found.items.map((row) => row.sec_uid),
				["MS4wLjABAAAAauthor01", "MS4wLjABAAAAauthor02"],
			);
			assert.equal(found.items[0].url, "https://www.douyin.com/user/MS4wLjABAAAAauthor01");
			assert.equal(found.items[0].name, "旅行作者甲");
			assert.equal(found.items[0].signature, "分享旅途");
			assert.equal(found.complete, false);
			assert.equal(found.scope, "loaded_dom");
			await app.execute("video.open", { resource: "12345" }, signal);
		});

		await t.test("image posts are read as notes, not as a broken video page", async () => {
			const opened = (await app.execute("video.open", { resource: "70001" }, signal)) as {
				video: unknown;
				note: { id: string; url: string; images: { ready: boolean }[]; slide: { index: number | null; count: number } };
				page_kind: string;
			};
			assert.equal(opened.page_kind, "note");
			assert.equal(opened.video, null);
			assert.equal(opened.note.id, "70001");
			assert.equal(opened.note.url, "https://www.douyin.com/note/70001");
			assert.equal(opened.note.images.length, 2);
			assert.deepEqual(
				opened.note.images.map((image) => image.ready),
				[true, true],
			);
			assert.equal(JSON.stringify(opened.note).includes("data:image"), false);
			assert.deepEqual(opened.note.slide, { index: 1, count: 2 });
			const nextSlide = (await app.execute("note.next", { video_id: "70001" }, signal)) as {
				index: number;
				moved: boolean;
			};
			assert.equal(nextSlide.index, 2);
			assert.equal(nextSlide.moved, true);
			await witness?.tab.locator('[data-e2e="note-next"]').evaluate((element: HTMLElement) => {
				element.style.display = "none";
			});
			const boundary = (await app.execute("note.next", { video_id: "70001" }, signal)) as {
				boundary: boolean;
				moved: boolean;
			};
			assert.equal(boundary.boundary, true);
			assert.equal(boundary.moved, false);
			await witness?.tab.locator('[data-e2e="note-next"]').evaluate((element: HTMLElement) => {
				element.style.display = "";
			});
			const previousSlide = (await app.execute("note.previous", { video_id: "70001" }, signal)) as { index: number };
			assert.equal(previousSlide.index, 1);
			await witness?.tab.locator('[data-e2e="note-next"]').click();
			assert.equal(await witness?.tab.locator("#note-index").textContent(), "2");
			await witness?.tab.locator('[data-e2e="note-previous"]').click();
			await witness?.tab.evaluate(() => {
				const bullets = document.querySelectorAll("#note .bullet");
				bullets[0]?.classList.remove("active");
				bullets[1]?.classList.add("active");
			});
			const disagree = (await app.execute("video.info", { video_id: "70001" }, signal)) as {
				note: { slide: { index: number | null; count: number | null } };
			};
			assert.deepEqual(disagree.note.slide, { index: null, count: null });
			await witness?.tab.evaluate(() => {
				const bullets = document.querySelectorAll("#note .bullet");
				bullets[1]?.classList.remove("active");
				bullets[0]?.classList.add("active");
			});
			await witness?.tab.evaluate(() => {
				document.querySelectorAll("#note .bullet")[1]?.classList.add("active");
			});
			const multiple = (await app.execute("video.info", { video_id: "70001" }, signal)) as {
				note: { slide: { index: number | null; count: number | null } };
			};
			assert.deepEqual(multiple.note.slide, { index: null, count: null });
			await witness?.tab.evaluate(() => {
				document.querySelectorAll("#note .bullet")[1]?.classList.remove("active");
			});
			await witness?.tab.evaluate(() => {
				const counter = document.createElement("div");
				counter.id = "conflicting-note-counter";
				counter.innerHTML = "<span>1</span><span>/</span><span>3</span>";
				document.querySelector('[data-e2e="note-detail"]')?.append(counter);
			});
			const conflicting = (await app.execute("video.info", { video_id: "70001" }, signal)) as {
				note: { slide: { index: number | null; count: number | null } };
			};
			assert.deepEqual(conflicting.note.slide, { index: null, count: null });
			await assert.rejects(app.execute("note.next", { video_id: "70001" }, signal), { code: "unsupported_media" });
			await witness?.tab.evaluate(() => {
				document.querySelector("#conflicting-note-counter")?.remove();
			});
			const notePath = join(directory, "note-capture.png");
			const image = (await app.execute("note.capture", { video_id: "70001", index: 2, output: notePath }, signal)) as {
				slide: { index: number };
				index: number;
				available_images: number;
			};
			assert.equal(image.index, 2);
			assert.equal(image.slide.index, 1);
			assert.equal(image.available_images, 2);
			assert.deepEqual((await readFile(notePath)).subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
			await assert.rejects(app.execute("note.capture", { video_id: "70001", index: 2, output: notePath }, signal), {
				code: "revision_conflict",
			});
			await assert.rejects(app.execute("note.capture", { video_id: "70001", index: 3 }, signal), { code: "not_found" });
			await assert.rejects(app.execute("note.capture", { video_id: "12345", index: 1 }, signal), {
				code: "identity_mismatch",
			});
			const comments = (await app.execute("comment.list", {}, signal)) as { items: { video_id: string }[] };
			assert.ok(comments.items.length > 0);
			assert.ok(comments.items.every((comment) => comment.video_id === "70001"));
			await witness?.tab.evaluate(() => {
				const parent = document.querySelector('[data-comment-id="10001"]');
				const button = document.createElement("button");
				button.textContent = "展开1条回复";
				button.onclick = () => {
					const row = document.createElement("div");
					row.dataset.e2e = "comment-item";
					row.dataset.commentId = "10201";
					row.innerHTML = '<span data-e2e="comment-content">图文回复</span>';
					parent?.append(row);
					button.remove();
				};
				parent?.append(button);
			});
			const replies = (await app.execute("comment.replies", { video_id: "70001", comment_id: "10001" }, signal)) as {
				items: { id: string; video_id: string; parent_id: string }[];
			};
			assert.deepEqual(
				replies.items.map(({ id, video_id, parent_id }) => ({ id, video_id, parent_id })),
				[{ id: "10201", video_id: "70001", parent_id: "10001" }],
			);
			await witness?.tab.evaluate(() => {
				document.querySelector('[data-e2e="note-slide-controls"]')?.remove();
				document.querySelector(".swiper-pagination")?.remove();
			});
			const withoutCounter = (await app.execute("video.info", { video_id: "70001" }, signal)) as {
				note: { slide: { index: number | null; count: number | null } };
			};
			assert.deepEqual(withoutCounter.note.slide, { index: null, count: null });
			// The same work ID is accepted in its /note/ form too.
			await app.execute("video.open", { resource: "https://www.douyin.com/note/70001" }, signal);
		});

		await t.test("the state marker is read as a whole, not by its suffix", async () => {
			// Both spellings end the same way: video-player-no-digged and
			// video-player-is-digged. Matching the suffix called an unliked work
			// liked, so a like reported no change and an unlike never confirmed.
			await app.execute("video.open", { resource: "12345" }, signal);
			const reading = async () =>
				witness?.tab.evaluate(() => {
					const el = document.querySelector('[data-e2e="video-player-digg"]');
					return el?.getAttribute("data-e2e-state") ?? "";
				});
			assert.equal(await reading(), "video-player-no-digged");
			const first = (await app.execute("video.like", { video_id: "12345", enabled: true }, signal)) as {
				confirmed: boolean;
				changed: boolean;
			};
			assert.equal(first.confirmed, true);
			assert.equal(first.changed, true);
			assert.equal(await reading(), "video-player-is-digged");
			// And back again: the two directions are different states, not one.
			const second = (await app.execute("video.like", { video_id: "12345", enabled: false }, signal)) as {
				confirmed: boolean;
				changed: boolean;
			};
			assert.equal(second.confirmed, true);
			assert.equal(second.changed, true);
			assert.equal(await reading(), "video-player-no-digged");
		});

		await t.test("image posts use their own like control and never the video one", async () => {
			await app.execute("video.open", { resource: "70001" }, signal);
			const liked = (await app.execute("video.like", { video_id: "70001", enabled: true }, signal)) as {
				confirmed: boolean;
			};
			assert.equal(liked.confirmed, true);
			assert.equal(
				await witness?.tab.locator('[data-e2e="note-digg"]').getAttribute("data-e2e-state"),
				"note-is-digged",
			);
			// The video control is on a different surface and must be untouched.
			assert.equal(
				await witness?.tab.locator('[data-e2e="video-player-digg"]').getAttribute("data-e2e-state"),
				"video-player-no-digged",
			);
		});

		await t.test("a note page without note controls fails closed", async () => {
			await app.execute("video.open", { resource: "70001" }, signal);
			await witness?.tab.evaluate(() => {
				document.querySelector('[data-e2e="note-collect"]')?.remove();
			});
			await assert.rejects(
				app.execute("video.favorite", { video_id: "70001", enabled: true, request_id: "fixture-note-01" }, signal),
				{ code: "selector_changed" },
			);
			await app.execute("video.open", { resource: "12345" }, signal);
		});

		await t.test("forwarding does not treat a disappearing row as a delivery receipt", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			const input = {
				recipient_id: "secuid:MS4wLjABAAAAshare01",
				video_id: "12345",
				request_id: "fixture-forward-01",
			};
			await assert.rejects(app.execute("chat.forward", input, signal), { code: "delivery_uncertain" });
			// The clicked row must be the requested recipient, not merely some row.
			assert.deepEqual(await witness?.tab.evaluate("window.forwardTargets"), ["30001"]);
			await assert.rejects(app.execute("chat.forward", input, signal), { code: "delivery_uncertain" });
			assert.equal(await witness?.tab.evaluate("window.forwardSends"), 1);
			const history = (await app.execute(
				"share.history",
				{ video_id: input.video_id, recipient_id: input.recipient_id },
				signal,
			)) as { items: { request_id: string; status: string; target: { video_id: string; recipient_id: string } }[] };
			assert.equal(history.items.length, 1);
			assert.equal(history.items[0].request_id, input.request_id);
			assert.equal(history.items[0].status, "dispatching");
			assert.deepEqual(history.items[0].target, { video_id: input.video_id, recipient_id: input.recipient_id });
		});

		await t.test("forwarding refuses an unknown recipient instead of picking one", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			await assert.rejects(
				app.execute(
					"chat.forward",
					{ recipient_id: "secuid:MS4wLjABAAAAnothere", video_id: "12345", request_id: "fixture-forward-02" },
					signal,
				),
				{ code: "identity_mismatch" },
			);
			await assert.rejects(
				app.execute(
					"chat.forward",
					{ recipient_id: "secuid:MS4wLjABAAAAshare01", video_id: "99999", request_id: "fixture-forward-03" },
					signal,
				),
				{ code: "identity_mismatch" },
			);
			// Neither refusal may click any row; the fixture records each click.
			assert.deepEqual(await witness?.tab.evaluate("window.forwardTargets"), []);
		});

		await t.test("a live room reports what it states and never what the picture shows", async () => {
			// The picture is a canvas with no text layer. Every field below comes
			// from something the room writes down; a reader that guessed at the
			// picture would have nothing to put here.
			await witness?.tab.goto("https://live.douyin.com/777777", { waitUntil: "domcontentloaded" });
			const state = (await app.execute("live.info", {}, signal)) as {
				room_id: string;
				status: string;
				host: string | null;
				viewers: number | null;
				can_comment: boolean;
				video_readable: boolean;
			};
			assert.equal(state.room_id, "777777");
			assert.equal(state.status, "live");
			// The host comes from the title, not from a nickname class: a viewer's
			// name in the chat list is not the host.
			assert.equal(state.host, "示例主播");
			assert.equal(state.viewers, 1284);
			assert.equal(state.can_comment, true);
			// This is the honest answer, not a failure to read.
			assert.equal(state.video_readable, false);
		});

		await t.test("an ended room says so instead of looking empty", async () => {
			// A finished broadcast keeps the page and states the fact. Reporting
			// "live" here would make a caller wait for messages that will not come.
			await witness?.tab.goto("https://live.douyin.com/88888", { waitUntil: "domcontentloaded" });
			const state = (await app.execute("live.info", {}, signal)) as { status: string; can_comment: boolean };
			assert.equal(state.status, "ended");
			assert.equal(state.can_comment, false);
		});

		await t.test("danmaku rows are separated from gifts, joins and system lines", async () => {
			// The room repeats each line in a wrapper and an inner element, and it
			// repeats a line again after a reconnect. One line is one item.
			await witness?.tab.goto("https://live.douyin.com/777777", { waitUntil: "domcontentloaded" });
			const result = (await app.execute("live.chat", { limit: 50 }, signal)) as {
				items: { author: string; text: string; kind: string }[];
				counts: { chat: number; gift: number; join: number; system: number };
				complete: boolean;
			};
			const said = result.items.filter((item) => item.kind === "chat");
			assert.equal(said.length, 1, "the wrapper copy and the repeat collapse to one row");
			assert.equal(said[0]?.author, "观众甲");
			assert.equal(said[0]?.text, "主播这个走位是怎么练的");
			// A gift is not a viewer talking, and a join has no author separator.
			assert.equal(result.items.filter((item) => item.kind === "gift").length, 1);
			assert.equal(result.items.filter((item) => item.kind === "join").length, 1);
			assert.equal(result.items.filter((item) => item.kind === "system").length, 1);
			// This is a window, not a history, and the answer says so.
			assert.equal(result.complete, false);
			assert.deepEqual(result.counts, { chat: 1, gift: 1, join: 1, system: 1 });
		});

		await t.test("a gift name is read from between the two prices", async () => {
			// The panel writes "<price>钻<name><price>钻赠送". Taking the whole label
			// as the name would never match what a caller asked for, and a near miss
			// resolved by position would spend money on the wrong item.
			const result = (await app.execute("live.gifts", {}, signal)) as {
				items: { name: string; price: number | null }[];
			};
			const names = result.items.map((item) => `${item.price}钻${item.name}`);
			assert.ok(names.includes("1钻人气票"), `got ${names.join(", ")}`);
			assert.ok(names.includes("99钻Thuglife"), `got ${names.join(", ")}`);
			// "更多查看" is a control, not an item, and carries no price at all.
			assert.ok(!names.some((name) => name.includes("更多")));
		});

		await t.test("a danmaku send leaves a receipt and is not repeated", async () => {
			// live.say is a write, so the same discipline as a comment applies: one
			// request id, one send, and a repeat returns the receipt.
			const input = { text: "这个走位确实好看", request_id: "live-say-fixture-01" };
			const sent = (await app.execute("live.say", input, signal)) as { receipt?: { status: string } };
			assert.ok(sent);
			const first = (await witness?.tab.evaluate("window.liveSays")) as number;
			assert.equal(first, 1);
			// A second call with the same id must not type again.
			await app.execute("live.say", input, signal).catch(() => undefined);
			assert.equal(await witness?.tab.evaluate("window.liveSays"), 1);
		});

		await t.test("an uncertain dispatch is persisted and never automatically retried", async () => {
			await app.execute("video.open", { resource: "12345" }, signal);
			await witness?.tab.evaluate(() => {
				document.querySelector('[data-e2e="comment-post"]')?.addEventListener(
					"click",
					(event) => {
						event.stopImmediatePropagation();
					},
					true,
				);
			});
			const bounded = AbortSignal.timeout(1000);
			const input = { video_id: "12345", text: "unconfirmed", request_id: "fixture-uncertain-01" };
			await assert.rejects(app.execute("comment.post", input, bounded), { code: "delivery_uncertain" });
			const receipt = (await app.execute("receipt.get", { request_id: input.request_id }, signal)) as {
				status: string;
			};
			assert.equal(receipt.status, "dispatching");
			await assert.rejects(app.execute("comment.post", input, signal), { code: "delivery_uncertain" });
		});
	},
);
