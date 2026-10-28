import type { Event } from "../store.ts";

// Recurring trouble is the only honest evidence that a command needs work. This
// reads the bot's own event log, groups failures by command and code, and reports
// what repeated. It never edits code: the calling agent decides what to fix and
// proves the fix on the real page.

interface Failure {
	operation: string;
	code: string;
	message: string;
	at: string;
	elapsed_ms: number;
	source: string;
}

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function failure(event: Event, account: string): Failure | null {
	const data = object(event.data);
	if (data.ok !== false) return null;
	const code = typeof data.error_code === "string" ? data.error_code : null;
	if (!code) return null;
	return {
		operation: event.operation,
		code,
		message: typeof data.error_message === "string" ? data.error_message : "",
		at: event.at,
		elapsed_ms: typeof data.elapsed_ms === "number" ? data.elapsed_ms : 0,
		source: `event:${account}:${event.id}`,
	};
}

// A code that reappears after a long gap is a new episode, not the same
// incident: only failures inside one window count toward one candidate.
const EPISODE_MS = 6 * 60 * 60 * 1000;

// A command that keeps succeeding but takes steadily longer is trouble too, and
// no error code ever records it. The first half of the recorded window is the
// baseline; the second half is compared against it, so a command that was
// always slow is not reported and only a real drift is.
const SLOWDOWN_RATIO = 1.5;
const SLOWDOWN_MIN_SAMPLES = 4;

interface Success {
	operation: string;
	at: string;
	elapsed_ms: number;
	source: string;
}

function success(event: Event, account: string): Success | null {
	const data = object(event.data);
	if (data.ok === false) return null;
	if (typeof data.elapsed_ms !== "number") return null;
	return {
		operation: event.operation,
		at: event.at,
		elapsed_ms: data.elapsed_ms,
		source: `event:${account}:${event.id}`,
	};
}

export function diagnostics(events: Event[], account: string, bot: string, since?: string) {
	const failures = events
		.filter((event) => event.bot_id === bot && (!since || event.at >= since))
		.map((event) => failure(event, account))
		.filter((value): value is Failure => value !== null);

	const groups = new Map<string, Failure[]>();
	for (const item of failures) {
		const key = `${item.operation}\u0000${item.code}`;
		const list = groups.get(key) ?? [];
		list.push(item);
		groups.set(key, list);
	}

	const candidates = [...groups.values()]
		.map((list) => {
			const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
			const episodes: Failure[][] = [];
			for (const item of sorted) {
				const current = episodes.at(-1);
				const previous = current?.at(-1);
				if (current && previous && Date.parse(item.at) - Date.parse(previous.at) < EPISODE_MS) current.push(item);
				else episodes.push([item]);
			}
			const messages = [...new Set(sorted.map((item) => item.message))].filter(Boolean);
			return {
				operation: sorted[0].operation,
				error_code: sorted[0].code,
				failures: sorted.length,
				episodes: episodes.length,
				first_failure: sorted[0].at,
				last_failure: sorted.at(-1)?.at ?? sorted[0].at,
				distinct_messages: messages.slice(0, 5),
				median_elapsed_ms: median(sorted.map((item) => item.elapsed_ms)),
				sources: sorted.slice(-5).map((item) => item.source),
			};
		})
		// One-off failures happen in normal use; repetition is the signal.
		.filter((item) => item.failures > 1 || item.episodes > 1)
		.sort((a, b) => b.failures - a.failures || a.operation.localeCompare(b.operation));

	const slow = slowdowns(
		events
			.filter((event) => event.bot_id === bot && (!since || event.at >= since))
			.map((event) => success(event, account))
			.filter((value): value is Success => value !== null),
	);
	// A round of review is worth opening only when there is something to review.
	// Naming that threshold here keeps the decision out of the caller's head:
	// one candidate is today's work, several is a pattern that compounds.
	const total = candidates.length + slow.length;
	return {
		scope: "local_failure_events",
		account,
		bot_id: bot,
		since: since ?? null,
		total_failures: failures.length,
		candidate_count: total,
		candidates,
		slowdowns: slow,
		review: reviewHint(total),
		limitations: [
			"Only failures recorded after this version are visible; older history has no error events.",
			"A repeated failure is a lead, not a diagnosis or proof of the cause.",
			"Fixing a command still requires a real-page check; a passing test is not evidence of platform behavior.",
			"A slowdown compares two halves of the recorded window, so a single fast or slow run can move it.",
			"An unresolved failure must not be recorded as experience; it is an open problem, not a lesson.",
		],
	};
}

function median(values: number[]): number {
	if (!values.length) return 0;
	const sorted = [...values].sort((a, b) => a - b);
	return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

// Group successful runs by command and compare the later half of the window
// against the earlier half. Splitting by position rather than by clock keeps
// this working on sparse logs, where an uneven cadence would otherwise make
// two quiet runs look like a regression.
function slowdowns(items: Success[]) {
	const groups = new Map<string, Success[]>();
	for (const item of items) {
		const list = groups.get(item.operation) ?? [];
		list.push(item);
		groups.set(item.operation, list);
	}
	const result: {
		operation: string;
		samples: number;
		baseline_median_ms: number;
		recent_median_ms: number;
		ratio: number;
		sources: string[];
	}[] = [];
	for (const [operation, list] of groups) {
		if (list.length < SLOWDOWN_MIN_SAMPLES) continue;
		const sorted = [...list].sort((a, b) => a.at.localeCompare(b.at));
		const half = Math.floor(sorted.length / 2);
		const baseline = median(sorted.slice(0, half).map((item) => item.elapsed_ms));
		const recent = median(sorted.slice(half).map((item) => item.elapsed_ms));
		// A zero baseline cannot be compared by ratio, and an unmeasurably small
		// one would turn every later run into a false alarm.
		if (baseline < 50) continue;
		const ratio = Math.round((recent / baseline) * 100) / 100;
		if (ratio < SLOWDOWN_RATIO) continue;
		result.push({
			operation,
			samples: sorted.length,
			baseline_median_ms: baseline,
			recent_median_ms: recent,
			ratio,
			sources: sorted.slice(-3).map((item) => item.source),
		});
	}
	return result.sort((a, b) => b.ratio - a.ratio);
}

function reviewHint(total: number) {
	if (!total) return { suggested: false, reason: "No repeated trouble is recorded yet." };
	if (total < 2) return { suggested: false, reason: "One candidate is this round's work, not yet a pattern." };
	return {
		suggested: true,
		reason: `${total} candidates are recorded; a review round will do more than another single fix.`,
	};
}

// A fix is a claim about time: failures before it belong to the old behaviour.
// Recording it as an event, rather than deleting the failures, keeps the log as
// evidence while stopping a repaired command from heading the list forever.
export interface Acknowledgement {
	operation: string;
	error_code: string | null;
	at: string;
}

export function acknowledged(events: Event[]): Acknowledgement[] {
	return events
		.filter((event) => event.operation === "diagnostics-ack" || event.operation === "diagnostics.ack")
		.map((event) => {
			const data = object(event.data);
			return {
				operation: typeof data.operation === "string" ? data.operation : "",
				error_code: typeof data.error_code === "string" ? data.error_code : null,
				at: event.at,
			};
		})
		.filter((entry) => entry.operation);
}

export function splitByFix<C extends { operation: string; error_code: string; last_failure: string }>(
	candidates: C[],
	acknowledgements: Acknowledgement[],
) {
	const open: C[] = [];
	const resolved: C[] = [];
	for (const candidate of candidates) {
		// The latest acknowledgement for this command wins: a command fixed twice
		// is judged against the second fix, not the first.
		const marks = acknowledgements
			.filter(
				(entry) =>
					entry.operation === candidate.operation &&
					(entry.error_code === null || entry.error_code === candidate.error_code),
			)
			.sort((a, b) => a.at.localeCompare(b.at));
		const mark = marks.at(-1);
		// A failure after the mark is not covered by it. Comparing timestamps rather
		// than counting is what lets a command come back as a lead when it breaks
		// again, instead of being hidden by an old acknowledgement.
		if (mark && candidate.last_failure <= mark.at) resolved.push(candidate);
		else open.push(candidate);
	}
	return { open, resolved };
}
