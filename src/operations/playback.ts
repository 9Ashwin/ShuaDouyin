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

// Endpoints describe observable advancement, not uninterrupted viewing or comprehension.
export function summarizePlayback(samples: PlaybackSample[]) {
	const intervals: PlaybackInterval[] = [];
	const ranges: [number, number][] = [];
	for (let index = 1; index < samples.length; index++) {
		const left = samples[index - 1];
		const right = samples[index];
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
		if (
			validClock &&
			a &&
			b &&
			a.id &&
			a.id === b.id &&
			Number.isFinite(a.time) &&
			Number.isFinite(b.time) &&
			a.time >= 0 &&
			b.time >= 0 &&
			(a.duration === null || a.time <= a.duration + 0.5) &&
			(b.duration === null || b.time <= b.duration + 0.5)
		) {
			advance = b.time - a.time;
			if (
				a.duration === null ||
				b.duration === null ||
				!Number.isFinite(a.duration) ||
				!Number.isFinite(b.duration) ||
				a.duration <= 0 ||
				b.duration <= 0 ||
				Math.abs(a.duration - b.duration) > 0.5
			)
				classification = "duration_changed";
			else if (a.paused || b.paused) classification = "paused";
			else if (a.ready_state < 2 || b.ready_state < 2) classification = "buffering";
			else if (advance < -0.05) classification = "backward_or_loop";
			else if (advance > wall * 1.25 + 0.25) classification = "jump_or_fast";
			else if (advance <= 0.05) classification = "stalled";
			else classification = "progress";
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
	let observed = 0;
	let rangeEnd = Number.NEGATIVE_INFINITY;
	for (const [start, end] of ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1])) {
		observed += Math.max(0, end - Math.max(start, rangeEnd));
		rangeEnd = Math.max(rangeEnd, end);
	}
	return {
		intervals,
		observed_advancement_seconds: observed,
		continuity_proven: false,
		limitations: ["Endpoint samples cannot prove uninterrupted playback, visibility, comprehension or preference."],
	};
}
