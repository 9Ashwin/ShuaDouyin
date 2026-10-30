import assert from "node:assert/strict";
import test from "node:test";
import { samplePositions, samplesFor } from "../src/operations/digest.ts";

// Where a work gets sampled decides what a reader learns from it. The fractions
// avoid the opening (a title card) and the end (a call to follow), which are the
// two least informative parts.

test("a work under fifteen seconds is its own summary", () => {
	assert.deepEqual(samplePositions(9, 3), []);
	assert.deepEqual(samplePositions(14.9, 3), []);
});

test("a work between fifteen and forty-five seconds samples its middle", () => {
	// The bug this guards: passing --frames 2 took the second element of a
	// one-element list, so these works sampled nothing at all and reported an
	// empty array with no error.
	assert.deepEqual(samplePositions(25), [12.5]);
	assert.deepEqual(samplePositions(30, 1), [15]);
});

test("a longer work earns more samples, because three stills of half an hour is nothing", () => {
	// 3 to 20 minutes went from "three frames" to a count that follows the length.
	assert.equal(samplesFor(180), 3);
	assert.equal(samplesFor(600), 6);
	assert.equal(samplesFor(1200), 8);
	// An explicit count is honoured: asking for two is two.
	assert.equal(samplePositions(1200, 2).length, 2);
	// And asking for nothing is one frame, never zero.
	assert.equal(samplePositions(1200, 0).length, 1);
});

test("samples stay inside the middle, away from the title card and the sign-off", () => {
	const long = samplePositions(240, 3);
	assert.equal(long.length, 3);
	for (const at of long) {
		assert.ok(at >= 24, "the opening is a title card, not content");
		assert.ok(at <= 216, "the end is a call to follow");
	}
	// Ordered, and no duplicates.
	assert.deepEqual(
		[...long].sort((a, b) => a - b),
		long,
	);
	assert.equal(new Set(long).size, long.length);
});

test("asking for one frame on a long work still yields the middle", () => {
	// One frame is the exception: there is no spread to place, so it goes in the
	// centre rather than at 10%.
	assert.deepEqual(samplePositions(240, 1), [120]);
});

test("an unknown duration samples nothing rather than guessing", () => {
	assert.deepEqual(samplePositions(0, 3), []);
	assert.deepEqual(samplePositions(Number.NaN, 3), []);
	assert.deepEqual(samplePositions(-5, 3), []);
});
