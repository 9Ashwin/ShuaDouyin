import type { Event } from "../store.ts";

// What a browsing command actually returned, read back out of the event log.
//
// A round used to count only the works the caller explicitly marked with
// `browse watch`. Everything a sweep or a search had already shown was invisible
// to the budget, so a caller could scan a hundred works and the round still said
// zero — the budget never approached and the cross-round context never learned
// what had been seen.
//
// This is the one place that knows which events carry works. It is a pure
// function over events: no page, no store, no clock. That is what makes the
// counting rules testable without a browser.

/** How hard the work was looked at. */
export type Depth = "scan" | "inspect";

export interface Observation {
	/** Stable entity reference: `work:<id>` or `person:<sec_uid>`. */
	entity: string;
	kind: "work" | "person";
	round_id: string | null;
	/** Whether the round was attached by this call or inferred from the window. */
	attribution: "event" | "legacy_time_window";
	depth: Depth;
	operation: string;
	at: string;
	source: string;
}

interface Round {
	id: string;
	started_at: string;
	ended_at?: string | null;
}

/** The works an operation's response names, without inference. */
function worksOf(operation: string, data: Record<string, unknown>): { works: string[]; depth: Depth } {
	const id = (value: unknown) => (typeof value === "string" && /^\d{1,64}$/.test(value) ? value : null);
	// A single current work.
	if (["video.info"].includes(operation)) {
		const value = id(data.video_id) ?? id(data.id);
		return { works: value ? [value] : [], depth: "inspect" };
	}
	// Deriving a work from an arbitrary id field is how a comment id or a lane id
	// becomes a work. Only the fields these commands actually return are read.
	if (operation === "video.digest") {
		const value = id(data.video_id) ?? id(data.id);
		return { works: value ? [value] : [], depth: "inspect" };
	}
	if (operation === "feed.sweep") {
		const list = Array.isArray(data.works) ? data.works : [];
		const found: string[] = [];
		for (const entry of list) {
			if (!entry || typeof entry !== "object") continue;
			const value = id((entry as { id?: unknown }).id);
			if (value) found.push(value);
		}
		return { works: found, depth: "scan" };
	}
	if (operation === "feed.next" || operation === "feed.previous") {
		const video = data.video;
		const value = video && typeof video === "object" ? id((video as { id?: unknown }).id) : null;
		return { works: value ? [value] : [], depth: "scan" };
	}
	if (operation === "search" || operation === "user.search") {
		const list = Array.isArray(data.items) ? data.items : Array.isArray(data) ? data : [];
		const found: string[] = [];
		for (const entry of list) {
			if (!entry || typeof entry !== "object") continue;
			const value = id((entry as { id?: unknown }).id);
			if (value) found.push(value);
		}
		return { works: found, depth: "scan" };
	}
	return { works: [], depth: "scan" };
}

/**
 * Every observation the log contains, oldest first.
 *
 * Attribution follows the design rule: an event that names its round belongs to
 * that round and no other; an event that does not is attributed by the round's
 * time window and marked as such, so a caller can tell the two apart. Nothing
 * here rewrites the log — the legacy case is labelled, not converted.
 */
export function observations(events: Event[], bot = ""): Observation[] {
	const allRounds: Round[] = [];
	for (const event of events) {
		if (event.operation !== "browse.start") continue;
		const data = (event.data ?? {}) as Record<string, unknown>;
		const id = typeof data.id === "string" ? data.id : typeof data.round === "string" ? data.round : null;
		if (id) allRounds.push({ id, started_at: event.at });
	}
	for (const event of events) {
		if (event.operation !== "browse.end") continue;
		const data = (event.data ?? {}) as Record<string, unknown>;
		const id = typeof data.id === "string" ? data.id : typeof data.round === "string" ? data.round : null;
		const round = allRounds.find((entry) => entry.id === id);
		if (round) round.ended_at = event.at;
	}
	const found: Observation[] = [];
	for (const event of events) {
		const data = (event.data ?? {}) as Record<string, unknown>;
		const { works, depth } = worksOf(event.operation, data);
		if (!works.length) continue;
		const browsing =
			data._browse && typeof data._browse === "object" ? (data._browse as Record<string, unknown>) : null;
		const declared = typeof browsing?.round_id === "string" ? browsing.round_id : null;
		// An event that names a round is not also attributed by time: a long sweep
		// can finish after the round closed, and guessing would put it in the next.
		let roundID: string | null = declared;
		let attribution: Observation["attribution"] = "event";
		if (!roundID) {
			const during = allRounds.filter(
				(entry) => event.at >= entry.started_at && (!entry.ended_at || event.at <= entry.ended_at),
			);
			// The most recent round that was open at this moment, if exactly one is
			// a straight answer. Overlapping rounds are not resolved by picking one.
			roundID = during.length === 1 ? (during[0]?.id ?? null) : null;
			attribution = "legacy_time_window";
		}
		for (const work of works)
			found.push({
				entity: `work:${work}`,
				kind: "work",
				round_id: roundID,
				attribution,
				depth,
				operation: event.operation,
				at: event.at,
				source: `event:${bot || "default"}:${event.id}`,
			});
	}
	return found;
}

/** One key per round per entity, keeping the deepest look and the first time. */
export function uniqueObservations(entries: Observation[]): Observation[] {
	const byKey = new Map<string, Observation>();
	for (const entry of entries) {
		const key = `${entry.round_id ?? ""}\0${entry.entity}`;
		const existing = byKey.get(key);
		if (!existing) {
			byKey.set(key, entry);
			continue;
		}
		// A scan followed by an inspect is one examined work read properly, not two.
		if (existing.depth === "scan" && entry.depth === "inspect") byKey.set(key, { ...entry, at: existing.at });
	}
	return [...byKey.values()];
}
