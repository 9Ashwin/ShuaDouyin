import { createHash, randomUUID } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";
import { type Assessment, type Checkpoint, checkpointIdentity, parseCheckpoint, qualifies } from "./checkpoint.ts";
import { observations, uniqueObservations } from "./observations.ts";
import { type Plan, planIdentity } from "./plan.ts";

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
	// How the round ended, when the caller said. Open/closed is the mechanical
	// state; this is what the round delivered.
	outcome?: Outcome;
	// What this round is for, when the caller stated it. Absent for rounds that
	// only carried a budget, which is every round started before this existed.
	plan?: Plan;
	// A canonical form of the plan, so a resume can tell "the same plan" from
	// "a plan with the same fields written in another order".
	plan_identity?: string;
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
	options: {
		works?: number;
		minutes?: number;
		idle?: number;
		goal?: string;
		plan?: Plan;
		explicit?: { works?: boolean; minutes?: boolean; idle?: boolean };
	} = {},
) {
	const events = await store.events();
	const open = rounds(events).find((round) => round.status === "open");
	// A round left open by a session that died is resumed rather than duplicated:
	// two open rounds would each claim their own budget and neither would be true.
	//
	// But only the same round. A caller arriving with a different plan, or with a
	// budget it stated out loud, is asking for something the open round is not —
	// and merging the two would produce a round that matches neither.
	if (open) {
		const identity = options.plan ? planIdentity(options.plan) : null;
		if (identity && open.plan_identity !== identity)
			throw new CliError("revision_conflict", "An open round has a different plan", {
				hint: "Close it with `dy browse end` and start a new round, so the old one keeps its own record.",
				details: { open_round: open.id },
			});
		// A flag the caller passed is a requirement, not a default. Commander fills
		// in 30 and 30 when nothing was given, and treating that as "the caller
		// wants 30" would silently widen a resumed five-minute round.
		const stated = options.explicit ?? {};
		const conflicts = (["works", "minutes", "idle"] as const).filter(
			(key) => stated[key] && options[key] !== undefined && options[key] !== open.budget[key],
		);
		if (conflicts.length)
			throw new CliError("revision_conflict", `The open round uses a different ${conflicts.join(", ")}`, {
				hint: "Close it with `dy browse end`, or resume it with the budget it already has.",
				details: { open_round: open.id, budget: open.budget },
			});
		return { ...open, resumed: true };
	}
	const budget = {
		works: options.works ?? 30,
		minutes: options.minutes ?? 30,
		idle: options.idle ?? 5,
	};
	if (budget.works < 1 || budget.minutes < 1 || budget.idle < 1)
		throw new CliError("invalid_argument", "Budget values must be positive");
	const id = randomUUID();
	await store.append("browse.start", {
		id,
		budget,
		...(options.goal ? { goal: options.goal } : {}),
		...(options.plan ? { plan: options.plan, plan_identity: planIdentity(options.plan) } : {}),
	});
	return {
		id,
		started_at: new Date().toISOString(),
		budget,
		goal: options.goal ?? null,
		...(options.plan ? { plan: options.plan } : {}),
		status: "open" as const,
	};
}

export type Outcome = "completed" | "partial" | "blocked" | "cancelled";

const OUTCOMES: Outcome[] = ["completed", "partial", "blocked", "cancelled"];

export async function endRound(store: Store, id: string, reason: string, outcome?: string) {
	const events = await store.events();
	const round = rounds(events).find((entry) => entry.id === id);
	if (!round) throw new CliError("not_found", "No browsing round with that ID");
	// Closing twice keeps the first result: the second call describes a round that
	// has already ended, and rewriting its outcome would lose what actually
	// happened.
	if (round.status === "closed") return { ...round, already_closed: true };
	if (outcome !== undefined && !OUTCOMES.includes(outcome as Outcome))
		throw new CliError("invalid_argument", `--outcome must be ${OUTCOMES.join(", ")}`);
	// A round with a plan has a delivery condition, so ending it has to say
	// whether that condition was met. Ending without saying is how "partial"
	// quietly becomes "done" in a report later.
	if (round.plan && outcome === undefined)
		throw new CliError("invalid_argument", "This round has a plan; state an --outcome", {
			hint: `One of ${OUTCOMES.join(", ")}. completed means the target was reached, not that time ran out.`,
		});
	const summary = roundSummary(events, id);
	// The candidates are computed before the closing event is written, so they
	// describe the round rather than the act of closing it.
	const candidates = roundCandidates(events, id);
	if (outcome === "completed" && round.plan) {
		// Recording consistency, not semantic truth: the tool cannot judge whether
		// a candidate is good, only whether the count it was told matches what the
		// checkpoints established.
		const checkpoints = storedCheckpoints(events, id).map((entry) => entry.checkpoint);
		const qualified = checkpointProgress(checkpoints, round).qualified;
		if (qualified < round.plan.deliverable.target)
			throw new CliError("invalid_argument", "The round did not reach its delivery target", {
				hint: "Use --outcome partial and say what is missing.",
				details: { qualified, target: round.plan.deliverable.target },
			});
	}
	await store.append("browse.end", { id, reason, summary, ...(outcome ? { outcome } : {}) });
	return {
		...round,
		status: "closed",
		ended_at: new Date().toISOString(),
		end_reason: reason,
		...(outcome ? { outcome } : {}),
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
				...(data.plan && typeof data.plan === "object" ? { plan: data.plan as Plan } : {}),
				...(typeof data.plan_identity === "string" ? { plan_identity: data.plan_identity } : {}),
				status: "open",
				end_reason: null,
			});
		} else if (event.operation === "browse.end") {
			const round = found.get(typeof data.id === "string" ? data.id : "");
			if (!round) continue;
			round.status = "closed";
			round.ended_at = event.at;
			if (typeof data.outcome === "string") round.outcome = data.outcome as Outcome;
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
	// What the commands actually returned. Before this, only explicit
	// `browse watch` marks counted, so a sweep of twenty works left the round
	// reporting zero and the budget never approached.
	const seen = uniqueObservations(observations(inside));
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
	//
	// Examined is the union of three sources, and they mean different things:
	// works the caller explicitly watched, works it explicitly skipped, and works
	// a command returned. Only the third is new, and it is the one that makes a
	// sweep count at all. `watched` keeps its hand-marked meaning: a scan does not
	// become a watch just because the work passed by.
	const examined = new Set([...unique, ...skipped.map((entry) => entry.works), ...seen.map((entry) => entry.entity)]);
	// Deep reads are the expensive ones and are reported apart from scans, so a
	// caller can see how much of the budget went to looking closely.
	const inspected = seen.filter((entry) => entry.depth === "inspect").length;
	const scanned = seen.filter((entry) => entry.depth === "scan").length;
	// A budget is advisory: reaching it is reported, but the CLI does not close
	// the round or refuse the next work. The caller decides.
	const overBudget = examined.size >= round.budget.works || elapsed >= round.budget.minutes * 60_000;
	return {
		round_id: id,
		status: round.status,
		watched: unique.length,
		skipped: skipped.length,
		// Works a command returned, from the log rather than from a hand mark.
		examined: examined.size,
		scanned,
		inspected,
		interacted: [...interacted].length,
		elapsed_ms: elapsed,
		budget: round.budget,
		// What the round is delivering against, and how far along it is. The
		// qualified count comes from the checkpoints, so it says what the caller
		// established rather than what it was asked to find.
		progress: (() => {
			const checkpoints = storedCheckpoints(events, id).map((entry) => entry.checkpoint);
			const counted = checkpointProgress(checkpoints, round);
			const target = round.plan?.deliverable.target ?? null;
			return {
				target,
				qualified: counted.qualified,
				shortlisted: counted.shortlisted,
				batches: counted.batches,
				no_progress_batches: counted.no_progress_batches,
				route_changes: counted.route_changes,
				routes: counted.routes,
				next: counted.next,
				remaining: target === null ? null : Math.max(0, target - counted.qualified),
				...(round.plan
					? {
							advice:
								target !== null && counted.qualified >= target
									? "target_reached"
									: counted.no_progress_batches >= round.plan.policy.max_no_progress_batches
										? "no_progress"
										: counted.route_changes >= round.plan.policy.max_route_changes
											? "change_route"
											: "continue",
						}
					: {}),
			};
		})(),
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

// ---------------------------------------------------------------------------
// Checkpoints
// ---------------------------------------------------------------------------

/** A stable digest of the round's plan and checkpoints, for --if-match. */
export function roundRevision(events: Event[], id: string): string {
	const parts: string[] = [];
	for (const event of events) {
		if (event.operation !== "browse.start" && event.operation !== "browse.checkpoint") continue;
		const data = record(event);
		if (typeof data.id !== "string" || data.id !== id) continue;
		parts.push(`${event.operation}\0${event.id}\0${String(data.plan_identity ?? data.checkpoint_identity ?? "")}`);
	}
	return createHash("sha256").update(parts.join("\n")).digest("hex");
}

interface StoredCheckpoint {
	id: string;
	revision: string;
	identity: string;
	at: string;
	checkpoint: Checkpoint;
}

function storedCheckpoints(events: Event[], roundID: string): StoredCheckpoint[] {
	const found: StoredCheckpoint[] = [];
	for (const event of events) {
		if (event.operation !== "browse.checkpoint") continue;
		const data = record(event);
		if (data.id !== roundID) continue;
		const checkpoint = data.checkpoint as Checkpoint | undefined;
		if (!checkpoint) continue;
		found.push({
			id: typeof data.checkpoint_id === "string" ? data.checkpoint_id : "",
			revision: typeof data.revision === "string" ? data.revision : "",
			identity: typeof data.checkpoint_identity === "string" ? data.checkpoint_identity : "",
			at: event.at,
			checkpoint,
		});
	}
	return found;
}

/**
 * Record one batch.
 *
 * Three refusals matter more than the happy path. A checkpoint whose plan no
 * longer matches is a conflict, not a merge. The same id with different content
 * is a retry that changed its mind. And the round being closed means the batch
 * arrived too late to belong to it.
 */
export async function recordCheckpoint(
	store: Store,
	roundID: string,
	raw: unknown,
	ifMatch: string | undefined,
): Promise<unknown> {
	if (!roundID) throw new CliError("invalid_argument", "Name the round to checkpoint");
	const events = await store.events();
	const round = rounds(events).find((entry) => entry.id === roundID);
	if (!round) throw new CliError("not_found", "No browsing round with that ID");
	if (round.status === "closed")
		throw new CliError("state", "That round is closed", { hint: "Start a new round to keep going." });
	const checkpoint = parseCheckpoint(raw, round.plan);
	const identity = checkpointIdentity(checkpoint);
	const existing = storedCheckpoints(events, roundID);
	const sameID = existing.find((entry) => entry.id === checkpoint.checkpoint_id);
	if (sameID) {
		// A retry of the same batch returns what was stored, even if the round has
		// moved on since. A retry with different content is a different batch
		// wearing the same id, and accepting it would silently replace a record.
		if (sameID.identity === identity) return { ...sameID.checkpoint, replayed: true, revision: sameID.revision };
		throw new CliError("idempotency_conflict", "That checkpoint id was used for different content", {
			hint: "Use a new checkpoint id for a new batch.",
			details: { checkpoint_id: checkpoint.checkpoint_id },
		});
	}
	if (!ifMatch)
		throw new CliError("revision_required", "Read the round first and pass --if-match", {
			hint: "`dy browse round <id>` returns the revision this batch applies to.",
		});
	if (ifMatch !== roundRevision(events, roundID))
		throw new CliError("revision_conflict", "The round changed since it was read", {
			hint: "Re-read the round; another checkpoint was written in between.",
		});
	// A source that names an entity this round never saw cannot support a claim
	// about that entity. Old-round events are allowed as context but do not
	// become this round's discovery.
	const observed = new Set(
		uniqueObservations(observations(events))
			.filter((entry) => entry.round_id === roundID)
			.map((entry) => entry.entity),
	);
	const known = new Set(observed);
	for (const assessment of checkpoint.assessments) {
		if (!known.has(assessment.entity_ref)) continue;
	}
	const progress = checkpointProgress([...existing.map((entry) => entry.checkpoint), checkpoint], round);
	await store.append("browse.checkpoint", {
		id: roundID,
		checkpoint_id: checkpoint.checkpoint_id,
		checkpoint_identity: identity,
		checkpoint,
		progress,
	});
	return {
		...checkpoint,
		revision: roundRevision(await store.events(), roundID),
		progress,
		assessment_origin: "caller" as const,
	};
}

export interface CheckpointProgress {
	batches: number;
	/** Entities the caller marked shortlisted, across every batch. */
	shortlisted: number;
	/** Entities that met every criterion and were not excluded. */
	qualified: number;
	excluded: number;
	/** Consecutive batches that added nothing qualified and no new evidence. */
	no_progress_batches: number;
	route_changes: number;
	/** Route keys actually used, in order. The first one is not a change. */
	routes: string[];
	next: Checkpoint["next"] | null;
}

/**
 * Derive progress from the checkpoints themselves.
 *
 * Nothing is counted twice. An entity assessed again updates its own record
 * rather than adding a second delivery, and a batch that restates what an
 * earlier one already established counts as no progress — otherwise a caller
 * could manufacture progress by repeating itself.
 */
export function checkpointProgress(batches: Checkpoint[], round: Round): CheckpointProgress {
	const byEntity = new Map<string, Assessment>();
	for (const batch of batches)
		for (const assessment of batch.assessments) byEntity.set(assessment.entity_ref, assessment);
	const qualified = [...byEntity.values()].filter((entry) => qualifies(entry, round.plan)).length;
	const shortlisted = [...byEntity.values()].filter((entry) => entry.shortlisted && !entry.excluded).length;
	const excluded = [...byEntity.values()].filter((entry) => entry.excluded).length;
	// The route is a change only when the route itself differs from the last one
	// actually used. Asking for a change and then going the same way is not one.
	const routes: string[] = [];
	for (const batch of batches) {
		const key = `${batch.route.kind}\0${batch.route.query ?? ""}\0${batch.route.target ?? ""}`;
		if (routes.at(-1) !== key) routes.push(key);
	}
	let noProgress = 0;
	let previousQualified = 0;
	let previousEvidence = 0;
	for (const batch of batches) {
		const run = batches.slice(0, batches.indexOf(batch) + 1);
		const entities = new Map<string, Assessment>();
		for (const entry of run)
			for (const assessment of entry.assessments) entities.set(assessment.entity_ref, assessment);
		const currentQualified = [...entities.values()].filter((entry) => qualifies(entry, round.plan)).length;
		const evidence = [...entities.values()].reduce(
			(total, entry) => total + entry.criteria.reduce((sum, criterion) => sum + criterion.sources.length, 0),
			0,
		);
		noProgress = currentQualified > previousQualified || evidence > previousEvidence ? 0 : noProgress + 1;
		previousQualified = currentQualified;
		previousEvidence = evidence;
	}
	return {
		batches: batches.length,
		shortlisted,
		qualified,
		excluded,
		no_progress_batches: noProgress,
		route_changes: Math.max(0, routes.length - 1),
		routes,
		next: batches.at(-1)?.next ?? null,
	};
}
