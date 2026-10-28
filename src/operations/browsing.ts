import { randomUUID } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";

// A browsing round is one stretch of looking. The CLI records its boundary and
// what happened inside it so that "how much did it watch, what did it skip, why
// did it stop" survives the session. It does not decide when to stop: that is
// the caller's judgement, and this only says the budget is spent.

export interface Round {
	id: string;
	started_at: string;
	ended_at: string | null;
	budget: { works: number; minutes: number; idle: number };
	// The goal this round served, when the caller named one.
	goal: string | null;
	status: "open" | "closed";
	end_reason: string | null;
}

// Why a work was passed over. Recorded because "how many did it skip" is only
// useful with the reasons attached; a bare count hides both a broken feed and a
// picky agent.
export const SKIP_REASONS = ["seen", "live", "uninteresting", "over_budget", "failed"] as const;

function record(event: Event): Record<string, unknown> {
	const data = event.data;
	return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

export async function startRound(
	store: Store,
	options: { works?: number; minutes?: number; idle?: number; goal?: string } = {},
) {
	const events = await store.events();
	const open = rounds(events).find((round) => round.status === "open");
	// A round left open by a session that died is resumed rather than duplicated:
	// two open rounds would each claim their own budget and neither would be true.
	if (open) return { ...open, resumed: true };
	const budget = {
		works: options.works ?? 30,
		minutes: options.minutes ?? 30,
		idle: options.idle ?? 5,
	};
	if (budget.works < 1 || budget.minutes < 1 || budget.idle < 1)
		throw new CliError("invalid_argument", "Budget values must be positive");
	const id = randomUUID();
	await store.append("browse.start", { id, budget, ...(options.goal ? { goal: options.goal } : {}) });
	return { id, started_at: new Date().toISOString(), budget, goal: options.goal ?? null, status: "open" as const };
}

export async function endRound(store: Store, id: string, reason: string) {
	const events = await store.events();
	const round = rounds(events).find((entry) => entry.id === id);
	if (!round) throw new CliError("not_found", "No browsing round with that ID");
	if (round.status === "closed") return { ...round, already_closed: true };
	const summary = roundSummary(events, id);
	// The candidates are computed before the closing event is written, so they
	// describe the round rather than the act of closing it.
	const candidates = roundCandidates(events, id);
	await store.append("browse.end", { id, reason, summary });
	return {
		...round,
		status: "closed",
		ended_at: new Date().toISOString(),
		end_reason: reason,
		summary,
		...(candidates ? { candidates: candidates.candidates, candidate_scope: candidates.limitations } : {}),
	};
}

export function rounds(events: Event[]): Round[] {
	const found = new Map<string, Round>();
	for (const event of events) {
		const data = record(event);
		if (event.operation === "browse.start") {
			const id = typeof data.id === "string" ? data.id : null;
			if (!id) continue;
			const budget = record({ data: data.budget } as Event);
			found.set(id, {
				id,
				started_at: event.at,
				ended_at: null,
				budget: {
					works: typeof budget.works === "number" ? budget.works : 30,
					minutes: typeof budget.minutes === "number" ? budget.minutes : 30,
					idle: typeof budget.idle === "number" ? budget.idle : 5,
				},
				goal: typeof data.goal === "string" ? data.goal : null,
				status: "open",
				end_reason: null,
			});
		} else if (event.operation === "browse.end") {
			const round = found.get(typeof data.id === "string" ? data.id : "");
			if (!round) continue;
			round.status = "closed";
			round.ended_at = event.at;
			round.end_reason = typeof data.reason === "string" ? data.reason : "";
		}
	}
	return [...found.values()];
}

// What happened inside one round. Reading the event log rather than trusting a
// counter means a work recorded twice still counts once, and a round whose end
// was never written can still be summarised.
export function roundSummary(events: Event[], id: string) {
	const round = rounds(events).find((entry) => entry.id === id);
	if (!round) return null;
	const inside = events.filter(
		(event) => event.at >= round.started_at && (!round.ended_at || event.at <= round.ended_at),
	);
	const watched = new Map<string, string>();
	const skipped: { works: string; reason: string }[] = [];
	const interacted = new Set<string>();
	for (const event of inside) {
		const data = record(event);
		// Both browse events name the work as `id`; writes name it as `video_id`.
		const work =
			(typeof data.video_id === "string" ? data.video_id : null) ?? (typeof data.id === "string" ? data.id : null);
		if (event.operation === "browse.watch" && work) watched.set(work, event.at);
		else if (event.operation === "browse.skip" && work)
			skipped.push({ works: work, reason: typeof data.reason === "string" ? data.reason : "" });
		else if (
			["video.like", "comment.post", "comment.reply", "chat.forward", "chat.share"].includes(event.operation) &&
			work
		)
			interacted.add(work);
	}
	const elapsed = (round.ended_at ? Date.parse(round.ended_at) : Date.now()) - Date.parse(round.started_at);
	const unique = [...watched.keys()];
	// A budget counts works looked at, and a skipped one was still looked at.
	// Counting only the kept ones would let a round run forever by skipping.
	const examined = new Set([...unique, ...skipped.map((entry) => entry.works)]);
	// A budget is advisory: reaching it is reported, but the CLI does not close
	// the round or refuse the next work. The caller decides.
	const overBudget = examined.size >= round.budget.works || elapsed >= round.budget.minutes * 60_000;
	return {
		round_id: id,
		status: round.status,
		watched: unique.length,
		skipped: skipped.length,
		interacted: [...interacted].length,
		elapsed_ms: elapsed,
		budget: round.budget,
		over_budget: overBudget,
		suggest: overBudget ? "The budget is spent; this is a reasonable place to close the round." : null,
		skip_reasons: skipped.reduce<Record<string, number>>((counts, entry) => {
			counts[entry.reason || "unspecified"] = (counts[entry.reason || "unspecified"] ?? 0) + 1;
			return counts;
		}, {}),
	};
}

export async function noteWatched(store: Store, roundID: string, work: string) {
	if (!/^\d{5,64}$/.test(work)) throw new CliError("invalid_argument", "Use a work ID from video info");
	await store.append("browse.watch", { round: roundID, id: work });
	return { round: roundID, watched: work };
}

export async function noteSkipped(store: Store, roundID: string, work: string, reason: string) {
	if (!/^\d{5,64}$/.test(work)) throw new CliError("invalid_argument", "Use a work ID from video info");
	if (!SKIP_REASONS.includes(reason as (typeof SKIP_REASONS)[number]))
		throw new CliError("invalid_argument", `--reason must be ${SKIP_REASONS.join(", ")}`);
	await store.append("browse.skip", { round: roundID, id: work, reason });
	return { round: roundID, skipped: work, reason };
}

// What was already seen and already acted on, so the caller does not have to
// compare lists by hand. Only facts this installation recorded: no interest is
// inferred here, and a work seen twice in two windows is one work.
export function browsingContext(events: Event[], options: { limit?: number } = {}) {
	const limit = options.limit ?? 50;
	const watched = new Map<string, { at: string; round: string | null }>();
	const skipped = new Map<string, string>();
	const acted = new Map<string, Set<string>>();
	for (const event of events) {
		const data = record(event);
		const round = typeof data.round === "string" ? data.round : null;
		if (event.operation === "browse.watch" && typeof data.id === "string" && !watched.has(data.id))
			watched.set(data.id, { at: event.at, round });
		else if (event.operation === "browse.skip" && typeof data.id === "string")
			skipped.set(data.id, typeof data.reason === "string" ? data.reason : "");
		else if (typeof data.video_id === "string") {
			const set = acted.get(data.video_id) ?? new Set<string>();
			if (
				["video.like", "video.favorite", "comment.post", "comment.reply", "chat.forward", "chat.share"].includes(
					event.operation,
				)
			)
				set.add(event.operation);
			if (set.size) acted.set(data.video_id, set);
		}
	}
	// Works read through video.info are what the feed actually showed, even when
	// the caller did not mark the round. They are included so a caller that never
	// called browse watch still gets a usable answer, and marked as such.
	const seen = new Map<string, { at: string; round: string | null; marked: boolean }>();
	for (const event of events) {
		if (event.operation !== "video.info") continue;
		const data = record(event);
		const video = data.video;
		const id =
			video && typeof video === "object" && typeof (video as Record<string, unknown>).id === "string"
				? ((video as Record<string, unknown>).id as string)
				: null;
		if (!id || seen.has(id)) continue;
		seen.set(id, { at: event.at, round: null, marked: false });
	}
	for (const [id, entry] of watched) seen.set(id, { ...entry, marked: true });
	// A work the caller skipped was seen too, even though it was never marked as
	// watched: leaving it out would hide the one thing the context exists to say.
	for (const event of events) {
		if (event.operation !== "browse.skip") continue;
		const data = record(event);
		if (typeof data.id !== "string" || seen.has(data.id)) continue;
		seen.set(data.id, {
			at: event.at,
			round: typeof data.round === "string" ? data.round : null,
			marked: true,
		});
	}
	const recent = [...seen.entries()].sort((a, b) => b[1].at.localeCompare(a[1].at)).slice(0, limit);
	return {
		works: recent.map(([id, entry]) => ({
			video_id: id,
			seen_at: entry.at,
			round: entry.round,
			// Whether the caller recorded this as watched, or it was only read.
			observed_from: entry.marked ? "browse.watch" : "video.info",
			skipped: skipped.get(id) ?? null,
			interactions: [...(acted.get(id) ?? [])],
			// The one thing a caller most needs before liking or commenting again.
			already_acted: (acted.get(id)?.size ?? 0) > 0,
		})),
		open_round: rounds(events).find((round) => round.status === "open") ?? null,
		scope: "local_events",
		limitations: [
			"Only what this installation recorded; a work watched in another session leaves no trace here.",
			"Nothing about interest is inferred. The list is what was seen, not what was liked.",
			"A work observed in several windows appears once.",
		],
	};
}

// What this round saw, shaped so the caller can turn it into memories.
// Deliberately not memories themselves: the round only knows what was on screen,
// and writing that straight into the store would fill it with whatever the feed
// happened to serve. The caller decides what is worth keeping, and the source
// stays attached so the decision can be revisited.
export function roundCandidates(events: Event[], id: string) {
	const round = rounds(events).find((entry) => entry.id === id);
	if (!round) return null;
	const inside = events.filter(
		(event) => event.at >= round.started_at && (!round.ended_at || event.at <= round.ended_at),
	);
	const works = new Map<
		string,
		{
			video_id: string;
			seen_at: string;
			title: string;
			author: string;
			skipped: string | null;
			interactions: string[];
			text_written: string;
			sources: string[];
		}
	>();
	const ensure = (video: string) => {
		const existing = works.get(video);
		if (existing) return existing;
		const created = {
			video_id: video,
			seen_at: "",
			title: "",
			author: "",
			skipped: null as string | null,
			interactions: [] as string[],
			text_written: "",
			sources: [] as string[],
		};
		works.set(video, created);
		return created;
	};
	for (const event of inside) {
		const data = record(event);
		const source = `event:default:${event.id}`;
		// The round's own start and end carry an `id` too, and it is the round's.
		// Reading it as a work put the round itself in the candidate list.
		if (event.operation.startsWith("browse.start") || event.operation === "browse.end") continue;
		if (event.operation === "video.info") {
			// The read carries the work's own title and author, which is what a
			// memory about "what I watched" would actually be about.
			const video = data.video;
			if (!video || typeof video !== "object") continue;
			const id =
				typeof (video as Record<string, unknown>).id === "string" ? String((video as Record<string, unknown>).id) : "";
			// A profile read reports "self" as its id. That is a route alias, not a
			// work, and the same check below does not reach this branch.
			if (!id || !/^\d{5,64}$/.test(id)) continue;
			const entry = ensure(id);
			if (!entry.seen_at) entry.seen_at = event.at;
			if (!entry.title && typeof (video as Record<string, unknown>).title === "string")
				entry.title = (video as Record<string, unknown>).title as string;
			if (!entry.author && typeof (video as Record<string, unknown>).author === "string")
				entry.author = (video as Record<string, unknown>).author as string;
			if (!entry.sources.includes(source)) entry.sources.push(source);
			continue;
		}
		const work =
			(typeof data.video_id === "string" ? data.video_id : null) ?? (typeof data.id === "string" ? data.id : null);
		// A work is a numeric platform id. `self` and other aliases describe a
		// route, not a work, and cannot become a candidate.
		if (!work || !/^\d{5,64}$/.test(work)) continue;
		const entry = ensure(work);
		if (!entry.seen_at) entry.seen_at = event.at;
		if (!entry.sources.includes(source)) entry.sources.push(source);
		if (event.operation === "browse.watch" && !entry.seen_at) entry.seen_at = event.at;
		else if (event.operation === "browse.skip")
			entry.skipped = typeof data.reason === "string" ? data.reason : "unspecified";
		else if (
			["video.like", "video.favorite", "comment.post", "comment.reply", "chat.share", "chat.forward"].includes(
				event.operation,
			)
		) {
			if (!entry.interactions.includes(event.operation)) entry.interactions.push(event.operation);
			if (typeof data.text === "string" && data.text) entry.text_written = data.text;
		}
	}
	const list = [...works.values()].sort((a, b) => a.seen_at.localeCompare(b.seen_at));
	return {
		round_id: id,
		started_at: round.started_at,
		ended_at: round.ended_at,
		candidates: list.map((entry) => ({
			...entry,
			// What a memory made from this row would claim, and what it would not.
			memory_hint: entry.skipped
				? `Skipped (${entry.skipped}). Useful as "not this", not as "liked".`
				: entry.interactions.length
					? `Acted on: ${entry.interactions.join(", ")}. Useful as evidence of what this account chose to do.`
					: "Only seen. Useful only if something about it mattered enough to say so.",
		})),
		scope: "local_events",
		limitations: [
			"These are observations, not conclusions. Nothing here is written to memory.",
			"A work that was only seen says nothing about interest; the feed chose it.",
			"Pass each candidate through memory add with its source to keep it traceable.",
		],
	};
}
