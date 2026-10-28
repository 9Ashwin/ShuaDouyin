import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { type Event, type Receipt, Store } from "../src/store.ts";

test("report sources include the day's local evidence with stable paging and no private text", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-sources-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const make = (id: string, at: string, bot: string, operation: string, data: unknown): Event => ({
		id,
		at,
		bot_id: bot,
		operation,
		data,
	});
	const events = [
		make("before", "2026-01-01T15:59:59.000Z", "default", "video.info", {
			video: { id: "111", title: "before" },
		}),
		make("work", "2026-01-01T16:00:00.000Z", "default", "video.info", {
			video: { id: "123", title: "public title", author: "author" },
		}),
		make("private", "2026-01-02T02:00:00.000Z", "default", "chat.read", {
			id: "native:123",
			messages: [{ text: "PRIVATE-MESSAGE" }],
		}),
		// Records written before the single-workspace change may name another
		// identity; they must not be attributed to this installation.
		make("other", "2026-01-02T03:00:00.000Z", "other", "video.info", { video: { id: "999" } }),
		make("after", "2026-01-02T16:00:00.000Z", "default", "video.info", { video: { id: "222" } }),
	];
	await store.withLock(async () => {
		await store.write("placeholder.json", {});
		await appendFile(store.path("history.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
	});
	const receipt: Receipt = {
		request_id: "request:one",
		fingerprint: "fixture",
		bot_id: "default",
		operation: "chat.send",
		status: "dispatching",
		created_at: "2026-01-02T03:00:00.000Z",
		updated_at: "2026-01-02T03:00:00.000Z",
	};
	await store.saveReceipt(receipt);
	const selected = new App({ state_dir: base });
	const first = (await selected.execute("report.prepare", {
		resource: "2026-01-02",
		timezone: "Asia/Shanghai",
		limit: 2,
	})) as { items: unknown[]; total: number; revision: string; next_offset: number; account: string };
	assert.equal(first.total, 3);
	assert.equal(first.account, "default");
	assert.equal(first.next_offset, 2);
	assert.equal(JSON.stringify(first).includes("PRIVATE-MESSAGE"), false);
	const second = (await selected.execute("report.prepare", {
		resource: "2026-01-02",
		timezone: "Asia/Shanghai",
		limit: 2,
		offset: first.next_offset,
		if_match: first.revision,
	})) as {
		items: { source: string; status: string; target: unknown; delivery_verified: boolean }[];
		next_offset: number | null;
	};
	assert.equal(second.items[0].source, "receipt:default:request:one");
	assert.equal(second.items[0].status, "dispatching");
	assert.equal(second.items[0].target, null);
	assert.equal(second.items[0].delivery_verified, false);
	assert.equal(second.next_offset, null);
	await assert.rejects(selected.execute("report.prepare", { resource: "2026-01-02", offset: 2 }), {
		code: "revision_required",
		hint: "Read the first page, then pass its revision and next_offset.",
	});
	await store.saveReceipt({ ...receipt, status: "confirmed" });
	await assert.rejects(
		selected.execute("report.prepare", { resource: "2026-01-02", offset: 2, if_match: first.revision }),
		{
			code: "revision_conflict",
			hint: "Run report prepare again without --offset or --if-match, then continue with its new revision.",
		},
	);
	const utc = (await selected.execute("report.prepare", { resource: "2026-01-01", timezone: "UTC" })) as {
		total: number;
	};
	assert.equal(utc.total, 2);
	await assert.rejects(selected.execute("report.prepare", { resource: "2026-01-02", timezone: "Invalid/Zone" }), {
		code: "invalid_argument",
	});
});

test("daily preparation includes events already acknowledged for growth", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-ack-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const event = await store.withLock(() => store.append("video.info", { video: { id: "123", title: "observed" } }));
	const selected = new App({ state_dir: base });
	await selected.execute("growth.ack", { event_id: event.id });
	const report = (await selected.execute("report.prepare", { resource: event.at.slice(0, 10), timezone: "UTC" })) as {
		items: { source: string }[];
	};
	assert.ok(report.items.some((item) => item.source === `event:default:${event.id}`));
});

test("report dates respect DST and report cross-midnight receipt updates", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-dst-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const times = [
		"2026-03-08T04:59:00.000Z",
		"2026-03-08T05:00:00.000Z",
		"2026-03-09T03:59:00.000Z",
		"2026-03-09T04:00:00.000Z",
	];
	await store.withLock(async () => {
		await store.write("placeholder.json", {});
		await appendFile(
			store.path("history.jsonl"),
			`${times.map((at, i) => JSON.stringify({ id: `event-${i}`, at, bot_id: "default", operation: "video.info", data: {} })).join("\n")}\n`,
		);
	});
	await store.saveReceipt({
		request_id: "cross-midnight",
		fingerprint: "fixture",
		bot_id: "default",
		operation: "chat.send",
		status: "confirmed",
		created_at: "2026-03-08T04:59:00.000Z",
		updated_at: "2026-03-08T05:01:00.000Z",
	});
	const selected = new App({ state_dir: base });
	const result = (await selected.execute("report.prepare", {
		resource: "2026-03-08",
		timezone: "America/New_York",
	})) as { total: number; items: { kind: string; date_basis?: string; created_at?: string; updated_at?: string }[] };
	assert.equal(result.total, 3);
	const receipt = result.items.find((item) => item.kind === "receipt");
	assert.equal(receipt?.date_basis, "updated");
	assert.equal(receipt?.created_at, "2026-03-08T04:59:00.000Z");
	assert.equal(receipt?.updated_at, "2026-03-08T05:01:00.000Z");
});

test("report summaries bound long page titles and mark truncation", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-title-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const event = await store.withLock(() =>
		store.append("video.info", { video: { id: "123", title: "旅".repeat(300) } }),
	);
	const report = (await new App({ state_dir: base }).execute("report.prepare", {
		resource: event.at.slice(0, 10),
		timezone: "UTC",
	})) as { summary: { works: { title: string; title_truncated: boolean }[] } };
	assert.equal(Array.from(report.summary.works[0].title).length, 160);
	assert.equal(report.summary.works[0].title_truncated, true);
});

test("daily report reports image send stage without claiming delivery", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-image-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	await store.saveReceipt({
		request_id: "image-test-request",
		fingerprint: "fixture",
		bot_id: "default",
		operation: "chat.image",
		status: "dispatching",
		created_at: "2026-01-02T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		media: { sha256: "a".repeat(64), bytes: 123, mime: "image/png" },
		media_stage: "send_dispatched",
		media_observation: {
			preview_verified: true,
			confirm_dispatched: true,
			dialog_closed: true,
			delivery_verified: false,
		},
	});
	const result = (await new App({ state_dir: base }).execute("report.prepare", {
		resource: "2026-01-02",
		timezone: "UTC",
	})) as {
		items: { media_stage: string; media_observation: { delivery_verified: boolean }; delivery_verified: boolean }[];
	};
	assert.equal(result.items[0].media_stage, "send_dispatched");
	assert.equal(result.items[0].media_observation.delivery_verified, false);
	assert.equal(result.items[0].delivery_verified, false);
});

test("daily report exposes image comment observation without claiming delivery", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-report-image-comment-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	await store.saveReceipt({
		request_id: "comment-image-test",
		fingerprint: "fixture",
		bot_id: "default",
		operation: "comment.image",
		status: "dispatching",
		created_at: "2026-01-02T00:00:00.000Z",
		updated_at: "2026-01-02T00:00:00.000Z",
		target: { video_id: "123" },
		media: { sha256: "a".repeat(64), bytes: 123, mime: "image/png" },
		media_stage: "send_dispatched",
		comment_observation: { preview_verified: true, publish_dispatched: true, delivery_verified: false },
	});
	const result = (await new App({ state_dir: base }).execute("report.prepare", {
		resource: "2026-01-02",
		timezone: "UTC",
	})) as {
		items: { comment_observation: { publish_dispatched: boolean }; delivery_verified: boolean }[];
		summary: { work_count: number };
	};
	assert.equal(result.items[0].comment_observation.publish_dispatched, true);
	assert.equal(result.items[0].delivery_verified, false);
	assert.equal(result.summary.work_count, 1);
});
