import type { Snapshot } from "../browser.ts";

export interface PlaybackSample {
	elapsed_ms: number;
	state: Snapshot;
}

export type PlaybackInterval = {
	from: number;
	to: number;
	wall_seconds: number;
	advance_seconds: number | null;
	classification:
		| "progress"
		| "paused"
		| "buffering"
		| "stalled"
		| "backward_or_loop"
		| "jump_or_fast"
		| "duration_changed"
		| "unavailable";
	viewport_intersects: boolean;
};

type Video = NonNullable<Snapshot["video"]>;

// Whether two samples describe the same work at two trustworthy positions. A
// different id means the feed moved; a negative or NaN time means the element
// was mid-load; a time past the duration means the reading is not the work's
// own clock. Any of those and the pair says nothing about playback.
function comparable(a: Video | null | undefined, b: Video | null | undefined): boolean {
	if (!a || !b || !a.id || a.id !== b.id) return false;
	if (!Number.isFinite(a.time) || !Number.isFinite(b.time) || a.time < 0 || b.time < 0) return false;
	const within = (video: Video) => video.duration === null || video.time <= video.duration + 0.5;
	return within(a) && within(b);
}

// The two durations have to agree, because a changed duration means the element
// was replaced rather than advanced. A null or non-positive duration is unknown,
// not zero, so it is a change rather than a starting point.
function sameTimeline(a: Video, b: Video): boolean {
	if (a.duration === null || b.duration === null) return false;
	if (!Number.isFinite(a.duration) || !Number.isFinite(b.duration)) return false;
	if (a.duration <= 0 || b.duration <= 0) return false;
	return Math.abs(a.duration - b.duration) <= 0.5;
}

// The order matters: the first condition that holds is the answer, and a paused
// video that also looks stalled is paused.
function classifyPair(a: Video, b: Video, advance: number, wall: number): PlaybackInterval["classification"] {
	if (!sameTimeline(a, b)) return "duration_changed";
	if (a.paused || b.paused) return "paused";
	if (a.ready_state < 2 || b.ready_state < 2) return "buffering";
	if (advance < -0.05) return "backward_or_loop";
	// Faster than wall time is a seek or a loop, not watching.
	if (advance > wall * 1.25 + 0.25) return "jump_or_fast";
	if (advance <= 0.05) return "stalled";
	return "progress";
}

// Total advancement across the intervals that made progress, counting each second
// of the work at most once. A loop that replays a range must not add to the
// total: the work advanced once, however many times it was watched.
function mergedAdvancement(ranges: [number, number][]): number {
	let observed = 0;
	let rangeEnd = Number.NEGATIVE_INFINITY;
	for (const [start, end] of [...ranges].sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
		observed += Math.max(0, end - Math.max(start, rangeEnd));
		rangeEnd = Math.max(rangeEnd, end);
	}
	return observed;
}

// Endpoints describe observable advancement, not uninterrupted viewing or comprehension.
export function summarizePlayback(samples: PlaybackSample[]) {
	const intervals: PlaybackInterval[] = [];
	const ranges: [number, number][] = [];
	for (let index = 1; index < samples.length; index++) {
		const left = samples[index - 1];
		const right = samples[index];
		if (!left || !right) continue;
		const a = left.state.video;
		const b = right.state.video;
		const validClock =
			Number.isFinite(left.elapsed_ms) &&
			Number.isFinite(right.elapsed_ms) &&
			left.elapsed_ms >= 0 &&
			right.elapsed_ms >= left.elapsed_ms;
		const wall = validClock ? (right.elapsed_ms - left.elapsed_ms) / 1000 : 0;
		const viewport = a?.viewport_intersects === true && b?.viewport_intersects === true;
		let classification: PlaybackInterval["classification"] = "unavailable";
		let advance: number | null = null;
		if (validClock && a && b && comparable(a, b)) {
			advance = b.time - a.time;
			classification = classifyPair(a, b, advance, wall);
		}
		intervals.push({
			from: index - 1,
			to: index,
			wall_seconds: wall,
			advance_seconds: advance,
			classification,
			viewport_intersects: viewport,
		});
		if (classification === "progress" && a && b) ranges.push([a.time, b.time]);
	}
	return {
		intervals,
		observed_advancement_seconds: mergedAdvancement(ranges),
		continuity_proven: false,
		limitations: ["Endpoint samples cannot prove uninterrupted playback, visibility, comprehension or preference."],
	};
}
