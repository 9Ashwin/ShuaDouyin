import assert from "node:assert/strict";
import test from "node:test";
import { samplePositions } from "../src/operations/digest.ts";

// Where a work gets sampled decides what a reader learns from it. The fractions
// avoid the opening (a title card) and the end (a call to follow), which are the
// two least informative parts.

test("a work under fifteen seconds is its own summary", () => {
	assert.deepEqual(samplePositions(9, 3), []);
	assert.deepEqual(samplePositions(14.9, 3), []);
});

test("a work between fifteen and forty-five seconds samples its middle, whatever count was asked for", () => {
	// The bug this guards: passing --frames 2 took the second element of a
	// one-element list, so these works sampled nothing at all and reported an
	// empty array with no error.
	assert.deepEqual(samplePositions(25, 1), [12.5]);
	assert.deepEqual(samplePositions(25, 2), [12.5]);
	assert.deepEqual(samplePositions(25, 3), [12.5]);
	assert.deepEqual(samplePositions(30, 2), [15]);
});

test("a longer work spreads its samples and never samples the first frame", () => {
	const long = samplePositions(240, 3);
	assert.deepEqual(long, [60, 120, 180]);
	for (const at of long) assert.ok(at > 0, "the opening is a title card, not content");
	assert.ok(long[long.length - 1] < 240, "the end is a call to follow");
});

test("asking for one frame on a long work still yields the middle", () => {
	assert.deepEqual(samplePositions(240, 1), [120]);
});

test("an unknown duration samples nothing rather than guessing", () => {
	assert.deepEqual(samplePositions(0, 3), []);
	assert.deepEqual(samplePositions(Number.NaN, 3), []);
	assert.deepEqual(samplePositions(-5, 3), []);
});
