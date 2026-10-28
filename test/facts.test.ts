import assert from "node:assert/strict";
import test from "node:test";
import { factsComparison } from "../src/operations/facts.ts";

test("a selector used by code but absent from the page is reported", () => {
	const comparison = factsComparison({ markers: ["feed-active-video", "video-player-digg"] }, [
		"feed-active-video",
		"comment-item",
	]);
	assert.deepEqual(comparison.matched, ["feed-active-video"]);
	assert.deepEqual(comparison.absent_here, ["comment-item"]);
});

test("a marker the page offers but nothing uses is reported too", () => {
	// The page having something this adapter does not read is the other half of
	// the gap: a capability that exists and is ignored.
	const comparison = factsComparison({ markers: ["feed-item", "feed-active-video"] }, ["feed-active-video"]);
	assert.deepEqual(comparison.unused_by_code, ["feed-item"]);
});

test("an empty page reports every code selector as absent, not as matched", () => {
	const comparison = factsComparison({ markers: [] }, ["comment-item", "video-player-digg"]);
	assert.deepEqual(comparison.matched, []);
	assert.deepEqual(comparison.absent_here, ["comment-item", "video-player-digg"]);
});
