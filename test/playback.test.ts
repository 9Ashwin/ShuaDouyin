import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { Session, Snapshot } from "../src/browser.ts";
import { observe } from "../src/operations/capture.ts";
import { summarizePlayback } from "../src/operations/playback.ts";

function snapshot(overrides: Partial<NonNullable<Snapshot["video"]>> = {}): Snapshot {
	return {
		url: "https://www.douyin.com/video/12345",
		title: "fixture",
		page_kind: "video",
		unsupported_page: false,
		login_required: false,
		verification_required: false,
		private_chat_visible: false,
		video_selection: { candidates: 1, ambiguous: false },
		slide: { kind: "video", id: "12345" },
		search_results: [],
		note: null,
		video: {
			id: "12345",
			url: "https://www.douyin.com/video/12345",
			title: "fixture",
			author: "",
			time: 0,
			duration: 100,
			paused: false,
			muted: true,
			ready_state: 4,
			viewport_intersects: true,
			...overrides,
		},
	};
}

function fakeSession(initial: Snapshot, states: Snapshot[], onScreenshot?: () => void): Session {
	return {
		call: async () => initial,
		status: async () => states.shift() ?? initial,
		tab: {
			screenshot: async () => {
				onScreenshot?.();
				return Buffer.from("fixture-png");
			},
		},
	} as unknown as Session;
}

test("playback evidence distinguishes advancement from ambiguous playback states", () => {
	const cases = [
		[{ time: 1 }, { time: 2 }, "progress"],
		[{ time: 1, paused: true }, { time: 2 }, "paused"],
		[{ time: 1, ready_state: 1 }, { time: 2 }, "buffering"],
		[{ time: 1 }, { time: 1 }, "stalled"],
		[{ time: 8 }, { time: 1 }, "backward_or_loop"],
		[{ time: 1 }, { time: 10 }, "jump_or_fast"],
		[{ time: 1 }, { time: 2, duration: 120 }, "duration_changed"],
	] as const;
	for (const [a, b, expected] of cases) {
		const result = summarizePlayback([
			{ elapsed_ms: 0, state: snapshot(a) },
			{ elapsed_ms: 1000, state: snapshot(b) },
		]);
		assert.equal(result.intervals[0].classification, expected);
		assert.equal(result.continuity_proven, false);
		assert.equal(result.observed_advancement_seconds, expected === "progress" ? 1 : 0);
	}
	const outside = summarizePlayback([
		{ elapsed_ms: 0, state: snapshot({ viewport_intersects: false }) },
		{ elapsed_ms: 1000, state: snapshot({ time: 1 }) },
	]);
	assert.equal(outside.intervals[0].viewport_intersects, false);
	assert.equal(summarizePlayback([{ elapsed_ms: 0, state: snapshot() }]).intervals.length, 0);
	const repeated = summarizePlayback([
		{ elapsed_ms: 0, state: snapshot({ time: 0 }) },
		{ elapsed_ms: 1000, state: snapshot({ time: 1 }) },
		{ elapsed_ms: 2000, state: snapshot({ time: 0 }) },
		{ elapsed_ms: 3000, state: snapshot({ time: 1 }) },
	]);
	assert.equal(repeated.observed_advancement_seconds, 1);
	assert.equal(repeated.intervals[1].classification, "backward_or_loop");
});

test("a video change between preflight and screenshot is rejected before capture", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-observe-race-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const first = snapshot();
	const next = snapshot({ id: "67890" });
	const session = fakeSession(first, [first, next]);
	await assert.rejects(
		observe(session, { path: (name) => join(base, name) }, { output: base, frames: 1 }, new AbortController().signal),
		(error: unknown) => {
			const result = error as { code: string; details: { frames: { state: Snapshot }[] } };
			assert.equal(result.code, "identity_mismatch");
			assert.equal(result.details.frames.length, 0);
			return true;
		},
	);
	await assert.rejects(readFile(join(base, "001.png")), { code: "ENOENT" });
});

test("a video change immediately after capture is not attributed to the previous work", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-observe-post-race-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const first = snapshot();
	const session = fakeSession(first, [first, first, snapshot({ id: "67890" })]);
	await assert.rejects(
		observe(session, { path: (name) => join(base, name) }, { output: base, frames: 1 }, new AbortController().signal),
		{ code: "identity_mismatch" },
	);
	await assert.rejects(readFile(join(base, "001.png")), { code: "ENOENT" });
});

test("observation never overwrites an existing frame and reports interrupted captures", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-observe-output-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const first = snapshot();
	await writeFile(join(base, "001.png"), "user image");
	await assert.rejects(
		observe(
			fakeSession(first, [first, first]),
			{ path: (name) => join(base, name) },
			{ output: base, frames: 1 },
			new AbortController().signal,
		),
		{ code: "revision_conflict" },
	);
	assert.equal(await readFile(join(base, "001.png"), "utf8"), "user image");
	await rm(join(base, "001.png"));
	const abort = new AbortController();
	const session = fakeSession(first, [first, first, first], () => abort.abort());
	await assert.rejects(
		observe(session, { path: (name) => join(base, name) }, { output: base, frames: 2, seconds: 1 }, abort.signal),
		(error: unknown) => {
			const result = error as { code: string; details: { frames: unknown[] } };
			assert.equal(result.code, "cancelled");
			assert.equal(result.details.frames.length, 1);
			return true;
		},
	);
	assert.equal(await readFile(join(base, "001.png"), "utf8"), "fixture-png");
});

test("private chat and image posts are not captured as video observations", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-observe-private-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const first = snapshot();
	for (const changed of [
		{ ...first, private_chat_visible: true },
		{ ...first, page_kind: "note", video: null, note: { id: "12345" } },
	] as Snapshot[]) {
		let captured = false;
		await assert.rejects(
			observe(
				fakeSession(first, [first, changed], () => {
					captured = true;
				}),
				{ path: (name) => join(base, name) },
				{ output: base, frames: 1 },
				new AbortController().signal,
			),
			{ code: "identity_mismatch" },
		);
		assert.equal(captured, false);
		await assert.rejects(readFile(join(base, "001.png")), { code: "ENOENT" });
	}
});

test("invalid playback endpoints never count as progress", () => {
	for (const invalid of [
		snapshot({ time: -1 }),
		snapshot({ time: 101 }),
		snapshot({ time: NaN }),
		snapshot({ duration: NaN }),
	]) {
		assert.notEqual(
			summarizePlayback([
				{ elapsed_ms: 0, state: invalid },
				{ elapsed_ms: 1000, state: snapshot({ time: 1 }) },
			]).intervals[0].classification,
			"progress",
		);
	}
	assert.equal(
		summarizePlayback([
			{ elapsed_ms: 2, state: snapshot() },
			{ elapsed_ms: 1, state: snapshot({ time: 1 }) },
		]).intervals[0].classification,
		"unavailable",
	);
});
