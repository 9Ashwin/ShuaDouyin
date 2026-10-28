import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { Store } from "../src/store.ts";

const failure = (operation: string, code: string, at: string, message = "same") => ({
	operation,
	at,
	failure: { code, message },
});

test("diagnostics groups repeated failures and ignores one-offs", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const recorded = [
		failure("video.info", "identity_mismatch", "2026-10-27T10:00:00.000Z"),
		failure("video.info", "identity_mismatch", "2026-10-27T10:05:00.000Z"),
		failure("feed.open", "selector_changed", "2026-10-27T11:00:00.000Z"),
	];
	for (const item of recorded)
		await store.withLock(() =>
			store.append(item.operation, {
				ok: false,
				error_code: item.failure.code,
				error_message: item.failure.message,
				elapsed_ms: 12,
			}),
		);
	const app = new App({ state_dir: base });
	const result = (await app.execute("diagnostics", {})) as {
		total_failures: number;
		candidate_count: number;
		candidates: { operation: string; error_code: string; failures: number; episodes: number }[];
	};
	assert.equal(result.total_failures, 3);
	assert.equal(result.candidate_count, 1);
	assert.equal(result.candidates[0].operation, "video.info");
	assert.equal(result.candidates[0].failures, 2);
	assert.equal(result.candidates[0].episodes, 1);
});

test("diagnostics separates a later recurrence into a new episode and honours --since", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-episode-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	// Two windows a day apart: the same code but separate incidents. Events are
	// written directly because the store always stamps the current time.
	const lines = ["2026-10-26T10:00:00.000Z", "2026-10-27T10:00:00.000Z"].map((at, index) =>
		JSON.stringify({
			id: `00000000-0000-4000-8000-00000000000${index}`,
			at,
			operation: "comment.list",
			bot_id: "default",
			data: { ok: false, error_code: "selector_changed", error_message: "", elapsed_ms: 5 },
		}),
	);
	await writeFile(store.path("history.jsonl"), `${lines.join("\n")}\n`);
	const app = new App({ state_dir: base });
	const all = (await app.execute("diagnostics", {})) as { candidates: { episodes: number }[] };
	assert.equal(all.candidates[0].episodes, 2);
	const recent = (await app.execute("diagnostics", { since: "2026-10-27T00:00:00.000Z" })) as {
		total_failures: number;
		candidate_count: number;
	};
	assert.equal(recent.total_failures, 1);
	assert.equal(recent.candidate_count, 0);
});

test("diagnostics reports a command that got slower without ever failing", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-slow-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	// Six successful runs: the first three set the baseline, the last three are
	// three times slower. Nothing failed, so only a timing comparison can see it.
	const elapsed = [200, 210, 220, 600, 620, 640];
	const lines = elapsed.map((ms, index) =>
		JSON.stringify({
			id: `00000000-0000-4000-8000-00000000001${index}`,
			at: `2026-10-27T10:0${index}:00.000Z`,
			operation: "comment.list",
			bot_id: "default",
			data: { ok: true, rows: 3, elapsed_ms: ms },
		}),
	);
	await writeFile(store.path("history.jsonl"), `${lines.join("\n")}\n`);
	const result = (await new App({ state_dir: base }).execute("diagnostics", {})) as {
		candidate_count: number;
		slowdowns: { operation: string; baseline_median_ms: number; recent_median_ms: number; ratio: number }[];
	};
	assert.equal(result.candidate_count, 1);
	assert.equal(result.slowdowns[0].operation, "comment.list");
	assert.equal(result.slowdowns[0].baseline_median_ms, 210);
	assert.equal(result.slowdowns[0].recent_median_ms, 620);
	assert.ok(result.slowdowns[0].ratio >= 1.5);
});

test("a command that was always slow is not reported as a slowdown", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-stable-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const lines = [900, 910, 920, 930, 940, 950].map((ms, index) =>
		JSON.stringify({
			id: `00000000-0000-4000-8000-00000000002${index}`,
			at: `2026-10-27T11:0${index}:00.000Z`,
			operation: "video.observe",
			bot_id: "default",
			data: { ok: true, frames: 3, elapsed_ms: ms },
		}),
	);
	await writeFile(store.path("history.jsonl"), `${lines.join("\n")}\n`);
	const result = (await new App({ state_dir: base }).execute("diagnostics", {})) as {
		slowdowns: unknown[];
		review: { suggested: boolean };
	};
	assert.deepEqual(result.slowdowns, []);
	assert.equal(result.review.suggested, false);
});

test("several candidates make a review round worth opening", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-review-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const lines = ["video.info", "comment.list"].flatMap((operation, operationIndex) =>
		[0, 1].map((index) =>
			JSON.stringify({
				id: `00000000-0000-4000-8000-00000000003${operationIndex}${index}`,
				at: `2026-10-27T12:0${index}:00.000Z`,
				operation,
				bot_id: "default",
				data: { ok: false, error_code: "selector_changed", error_message: "", elapsed_ms: 5 },
			}),
		),
	);
	await writeFile(store.path("history.jsonl"), `${lines.join("\n")}\n`);
	const result = (await new App({ state_dir: base }).execute("diagnostics", {})) as {
		candidate_count: number;
		review: { suggested: boolean; reason: string };
	};
	assert.equal(result.candidate_count, 2);
	assert.equal(result.review.suggested, true);
	assert.match(result.review.reason, /review round/);
});

test("a fix moves earlier failures to resolved until the command breaks again", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-ack-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const app = new App({ state_dir: base });
	const fail = async () =>
		store.append("video.info", {
			ok: false,
			error_code: "identity_mismatch",
			error_message: "blocked",
			elapsed_ms: 40,
		});
	// Two failures before the fix make the command a candidate.
	await fail();
	await fail();
	await app.execute("diagnostics-ack", { resource: "video.info", note: "fixed" });
	const after = (await app.execute("diagnostics", {})) as {
		candidates: { operation: string }[];
		resolved: { operation: string }[];
		candidate_count: number;
	};
	assert.equal(
		after.candidates.some((item) => item.operation === "video.info"),
		false,
	);
	assert.equal(
		after.resolved.some((item) => item.operation === "video.info"),
		true,
	);
	// The events are still there: a fix is a claim about time, not an erasure.
	assert.ok((await store.events()).filter((event) => event.operation === "video.info").length >= 2);
});

test("a failure after the fix brings the command back as a lead", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-regress-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const app = new App({ state_dir: base });
	const fail = async () =>
		store.append("video.info", {
			ok: false,
			error_code: "identity_mismatch",
			error_message: "blocked",
			elapsed_ms: 40,
		});
	await fail();
	await fail();
	await app.execute("diagnostics-ack", { resource: "video.info" });
	// A new failure lands after the mark; an acknowledgement must not hide it.
	await fail();
	await fail();
	const result = (await app.execute("diagnostics", {})) as {
		candidates: { operation: string }[];
		resolved: { operation: string }[];
	};
	assert.equal(
		result.candidates.some((item) => item.operation === "video.info"),
		true,
	);
	assert.equal(
		result.resolved.some((item) => item.operation === "video.info"),
		false,
	);
});

test("an acknowledgement can name one error code and leave the others open", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-diagnostics-code-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const app = new App({ state_dir: base });
	for (let index = 0; index < 2; index++) {
		await store.append("video.info", { ok: false, error_code: "identity_mismatch", error_message: "a", elapsed_ms: 1 });
		await store.append("video.info", { ok: false, error_code: "unsupported_page", error_message: "b", elapsed_ms: 1 });
	}
	await app.execute("diagnostics-ack", { resource: "video.info", error_code: "identity_mismatch" });
	const result = (await app.execute("diagnostics", {})) as {
		candidates: { operation: string; error_code: string }[];
		resolved: { operation: string; error_code: string }[];
	};
	assert.equal(
		result.resolved.some((item) => item.error_code === "identity_mismatch"),
		true,
	);
	assert.equal(
		result.candidates.some((item) => item.error_code === "unsupported_page"),
		true,
	);
});
