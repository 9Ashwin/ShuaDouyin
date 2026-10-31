import assert from "node:assert/strict";
import test from "node:test";
import { observations, uniqueObservations } from "../src/operations/observations.ts";
import type { Event } from "../src/store.ts";

// What a browsing command returned, read back out of the log.
//
// The bug this replaces is worth stating: a round counted only works the caller
// had explicitly marked with `browse watch`, so a sweep of twenty works left the
// round reporting zero works examined. The budget never approached, and the next
// round had no idea what had already been seen.
//
// These cases are built from events by hand. Going through the commands would
// test the write path instead of the counting rules, and the counting rules are
// where the answers were wrong.

const event = (id: number, operation: string, data: unknown, at: string): Event => ({
	id: `00000000-0000-4000-8000-${String(id).padStart(12, "0")}`,
	at,
	operation,
	data,
});

const start = (at: string, id = "round-1") => event(1, "browse.start", { id, budget: { works: 30 } }, at);
const end = (at: string, id = "round-1") => event(2, "browse.end", { id, reason: "done" }, at);

test("a sweep's works count as examined without any manual marking", () => {
	// The whole point: no browse.watch anywhere, and the round still knows.
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }, { id: "222" }, { id: "333" }] }, "2026-01-01T00:01:00Z"),
		end("2026-01-01T00:02:00Z"),
	];
	const found = uniqueObservations(observations(log));
	assert.equal(found.length, 3);
	assert.deepEqual(found.map((entry) => entry.entity).sort(), ["work:111", "work:222", "work:333"]);
	for (const entry of found) {
		assert.equal(entry.round_id, "round-1");
		assert.equal(entry.depth, "scan");
	}
});

test("a scan is a scan and reading it properly is an inspect", () => {
	// A sweep shows a work exists; a digest is what was looked at. The two are not
	// the same claim, and the budget records which happened.
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }, { id: "222" }] }, "2026-01-01T00:01:00Z"),
		event(4, "video.digest", { video_id: "111" }, "2026-01-01T00:02:00Z"),
	];
	const found = uniqueObservations(observations(log));
	assert.equal(found.length, 2, "one work seen twice is one work");
	assert.equal(found.find((entry) => entry.entity === "work:111")?.depth, "inspect");
	assert.equal(found.find((entry) => entry.entity === "work:222")?.depth, "scan");
});

test("a repeat sweep of the same works does not spend the budget twice", () => {
	// Sweeping the feed again re-shows the works that are still there. Counting
	// each sighting would let a caller exhaust a budget without seeing anything new.
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }, { id: "222" }] }, "2026-01-01T00:01:00Z"),
		event(4, "feed.sweep", { works: [{ id: "111" }, { id: "222" }, { id: "333" }] }, "2026-01-01T00:02:00Z"),
	];
	assert.equal(uniqueObservations(observations(log)).length, 3);
});

test("an event naming its round belongs to that round and no other", () => {
	// A long sweep can finish after its round closed. The clock would put it in
	// the next round; the event says which one it belongs to.
	const log = [
		start("2026-01-01T00:00:00Z"),
		end("2026-01-01T00:01:00Z"),
		start("2026-01-01T00:05:00Z", "round-2"),
		event(3, "feed.sweep", { works: [{ id: "111" }], _browse: { round_id: "round-1" } }, "2026-01-01T00:06:00Z"),
	];
	const found = observations(log);
	assert.equal(found[0]?.round_id, "round-1");
	assert.equal(found[0]?.attribution, "event");
});

test("an old event with no round is attributed by the window and labelled", () => {
	// Logs written before rounds were attached still have to be readable. The
	// attribution says the guess was a guess, so a caller can distrust it.
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T00:01:00Z"),
		end("2026-01-01T00:02:00Z"),
	];
	const found = observations(log);
	assert.equal(found[0]?.round_id, "round-1");
	assert.equal(found[0]?.attribution, "legacy_time_window");
});

test("an event outside every round belongs to none rather than the nearest one", () => {
	const log = [
		start("2026-01-01T00:00:00Z"),
		end("2026-01-01T00:01:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T01:00:00Z"),
	];
	const found = observations(log);
	assert.equal(found[0]?.round_id, null);
});

test("an event between two overlapping rounds is not assigned to either", () => {
	// Two rounds open at once should not happen, but a log that has them must not
	// get a confident answer from a coin flip.
	const log = [
		start("2026-01-01T00:00:00Z", "round-a"),
		start("2026-01-01T00:01:00Z", "round-b"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T00:02:00Z"),
	];
	assert.equal(observations(log)[0]?.round_id, null);
});

test("a work id is not invented from whatever id field an event has", () => {
	// A comment id, a conversation id and a lane id are all strings of digits.
	// Reading an arbitrary `id` is how a comment becomes a work.
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "comment.list", { items: [{ id: "999" }] }, "2026-01-01T00:01:00Z"),
		event(4, "chat.list", { id: "888" }, "2026-01-01T00:02:00Z"),
	];
	assert.deepEqual(observations(log), []);
});

test("a search contributes the works it returned", () => {
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "search", { items: [{ id: "111" }, { id: "222" }] }, "2026-01-01T00:01:00Z"),
	];
	assert.equal(uniqueObservations(observations(log)).length, 2);
});

test("each observation carries the event it came from", () => {
	// Provenance is the difference between "this was seen" and "something said so".
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T00:01:00Z"),
	];
	const found = observations(log, "bot-x");
	assert.match(found[0]?.source ?? "", /^event:bot-x:00000000-/);
});

test("the same work in two rounds is two observations, one per round", () => {
	// Seeing a work again in a later round is real: the caller is allowed to
	// decide it is worth another look. Only the same round deduplicates.
	const log = [
		start("2026-01-01T00:00:00Z", "round-1"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T00:01:00Z"),
		end("2026-01-01T00:02:00Z", "round-1"),
		start("2026-01-01T00:05:00Z", "round-2"),
		event(4, "feed.sweep", { works: [{ id: "111" }], _browse: { round_id: "round-2" } }, "2026-01-01T00:06:00Z"),
	];
	const found = uniqueObservations(observations(log));
	assert.equal(found.length, 2);
	assert.deepEqual(found.map((entry) => entry.round_id).sort(), ["round-1", "round-2"]);
});

test("a round that never ended still attributes its own events", () => {
	const log = [
		start("2026-01-01T00:00:00Z"),
		event(3, "feed.sweep", { works: [{ id: "111" }] }, "2026-01-01T00:01:00Z"),
	];
	assert.equal(observations(log)[0]?.round_id, "round-1");
});
