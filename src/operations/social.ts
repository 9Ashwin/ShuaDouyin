import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";

// A relationship is not a chat log. What makes it useful is the small set of
// facts a person would actually recall before writing to someone again: where
// you met, what you have in common, the last thing you talked about, and whether
// anything is owed. Those are derived from the event log rather than stored a
// second time, so the card can never disagree with what actually happened.

// Friendship and lead generation are not the same thing, and the words show it.
// A friendship has no outcome; a lead ends. So the stage list belongs to the
// goal that produced the card, not to the code: adding a new way of relating
// must not mean editing an enum.
export const FRIEND_STAGES = ["discovered", "met", "talking", "connected", "resting"] as const;
export const LEAD_STAGES = ["lead", "contacted", "qualified", "won", "lost"] as const;

// How far the evidence alone may carry a card. Beyond this the owner or the
// caller has to say so: no amount of sent messages proves a relationship, and
// no amount of sent messages proves a sale.
const INFERRED_LIMIT = 2;

export interface Vocabulary {
	id: string;
	stages: string[];
	// The stage past which only a stated decision counts.
	evidence_stops_at: number;
}

const DEFAULT_VOCABULARY: Vocabulary = {
	id: "friend",
	stages: [...FRIEND_STAGES],
	evidence_stops_at: INFERRED_LIMIT,
};

interface Touch {
	at: string;
	kind: string;
	text: string;
	direction: "out" | "in";
	source: string;
}

function record(event: Event): Record<string, unknown> {
	const data = event.data;
	return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

// Who an event concerns. A direct message names its conversation; a comment
// names the work, and the person is the author the comment list reported. Only
// a stable id counts — a display name is never an identity.
function subjectOf(event: Event): string | null {
	const data = record(event);
	for (const key of ["user_id", "recipient_id"]) {
		const value = data[key];
		if (typeof value !== "string" || !value) continue;
		// Targets are named with a kind prefix; the person is the id after it.
		return value.replace(/^(?:secuid|user|native|rendered):/, "");
	}
	// A read reports the conversation it read as `id`, not as
	// `conversation_id`, so both spellings name the peer.
	const conversation = data.conversation_id ?? data.id;
	if (typeof conversation === "string") {
		// A direct conversation is addressed by the peer's stable id; a group one
		// is not a single person and cannot become a relationship card.
		return conversation.startsWith("secuid:") ? conversation.slice("secuid:".length) : null;
	}
	return null;
}

const OUTWARD = new Set([
	"comment.post",
	"comment.reply",
	"chat.send",
	"chat.reply",
	"chat.share",
	"chat.forward",
	"chat.image",
	"user.follow",
	"video.like",
]);

export interface Card {
	person: string;
	stage: string;
	first_seen: string;
	last_contact: string | null;
	contact_count: number;
	last_text: string;
	open_followups: { at: string; topic: string; due: string }[];
	decided_at: string | null;
	note: string;
	goal: string | null;
	stage_position: number | null;
	forgotten?: boolean;
	forgotten_reason?: string;
	forgotten_at?: string;
}

// The vocabularies this installation has recorded, newest definition winning.
// A goal keeps the list it was created with, so changing the defaults later
// cannot reinterpret a card that was already decided.
export function vocabularies(events: Event[]): Map<string, Vocabulary> {
	const found = new Map<string, Vocabulary>();
	for (const event of events) {
		if (event.operation !== "social.goal") continue;
		const data = record(event);
		const id = typeof data.id === "string" ? data.id : null;
		if (!id) continue;
		const stages = Array.isArray(data.stages)
			? data.stages.filter((stage): stage is string => typeof stage === "string" && !!stage)
			: [];
		found.set(id, {
			id,
			stages: stages.length ? stages : [...FRIEND_STAGES],
			evidence_stops_at:
				typeof data.evidence_stops_at === "number" && data.evidence_stops_at >= 0
					? data.evidence_stops_at
					: INFERRED_LIMIT,
		});
	}
	return found;
}

export function relationships(events: Event[]): Map<string, Card> {
	const cards = new Map<string, Card>();
	const touches = new Map<string, Touch[]>();
	const decided = new Map<string, { stage: string; note: string; at: string }>();
	// Someone the owner set aside. The card stays readable; it stops being owed
	// anything and stops appearing as a person to meet.
	const forgotten = new Map<string, { reason: string; at: string }>();
	// Which goal a person was first attached to. A card belongs to one goal: the
	// same person under two goals is two attempts, and merging them would let a
	// lead's outcome silently close a friendship.
	const goals = new Map<string, string>();
	const lists = vocabularies(events);

	for (const event of events) {
		const data = record(event);
		if (event.operation === "social.goal") continue;
		if (event.operation === "social.stage") {
			const person = typeof data.person === "string" ? data.person : null;
			const stage = typeof data.stage === "string" && data.stage ? data.stage : null;
			if (person && stage)
				decided.set(person, { stage, note: typeof data.note === "string" ? data.note : "", at: event.at });
			continue;
		}
		if (event.operation === "social.forgotten") {
			const person = typeof data.person === "string" ? data.person : null;
			if (person) forgotten.set(person, { reason: typeof data.reason === "string" ? data.reason : "", at: event.at });
			continue;
		}
		if (event.operation === "social.followup") {
			const person = typeof data.person === "string" ? data.person : null;
			if (!person) continue;
			const card = ensure(cards, person, event.at);
			card.open_followups.push({
				at: event.at,
				topic: typeof data.topic === "string" ? data.topic : "",
				due: typeof data.due === "string" ? data.due : event.at,
			});
			continue;
		}
		if (event.operation === "social.followup.done") {
			const person = typeof data.person === "string" ? data.person : null;
			if (!person) continue;
			const card = cards.get(person);
			if (card) card.open_followups = card.open_followups.filter((entry) => entry.at !== data.at);
			continue;
		}
		const person = subjectOf(event);
		if (!person) continue;
		const card = ensure(cards, person, event.at);
		if (typeof data.goal === "string" && !goals.has(person)) goals.set(person, data.goal);
		if (!OUTWARD.has(event.operation)) continue;
		const list = touches.get(person) ?? [];
		list.push({
			at: event.at,
			kind: event.operation,
			text: typeof data.text === "string" ? data.text : "",
			direction: "out",
			source: `event:default:${event.id}`,
		});
		touches.set(person, list);
		card.contact_count = list.length;
		if (!card.last_contact || event.at > card.last_contact) {
			card.last_contact = event.at;
			card.last_text = typeof data.text === "string" ? data.text : "";
		}
	}

	for (const [person, card] of cards) {
		const goal = goals.get(person) ?? null;
		const vocabulary = (goal && lists.get(goal)) || DEFAULT_VOCABULARY;
		const own = decided.get(person);
		if (own) {
			card.stage = own.stage;
			card.note = own.note;
			card.decided_at = own.at;
		} else card.stage = infer(card, vocabulary);
		card.goal = goal;
		card.stage_position = vocabulary.stages.indexOf(card.stage);
		const gone = forgotten.get(person);
		if (gone) {
			card.forgotten = true;
			card.forgotten_reason = gone.reason;
			card.forgotten_at = gone.at;
		}
	}
	return cards;
}

function ensure(cards: Map<string, Card>, person: string, at: string): Card {
	const existing = cards.get(person);
	if (existing) return existing;
	const card: Card = {
		person,
		stage: "discovered",
		first_seen: at,
		last_contact: null,
		contact_count: 0,
		last_text: "",
		open_followups: [],
		decided_at: null,
		note: "",
		goal: null,
		stage_position: null,
	};
	cards.set(person, card);
	return card;
}

// A stage the owner never set is inferred from what was actually sent, and the
// vocabulary decides how far that can go. Two sent messages say "we are talking"
// in a friendship and "contacted" in a lead; neither says "connected" or "won",
// because those are facts about the other person, not about what was sent.
function infer(card: Card, vocabulary: Vocabulary): string {
	const stop = Math.min(vocabulary.evidence_stops_at, vocabulary.stages.length - 1);
	const position = Math.min(card.contact_count, stop);
	return vocabulary.stages[position] ?? vocabulary.stages[0] ?? "discovered";
}

export async function recordStage(store: Store, person: string, stage: string, note: string) {
	if (!/^[A-Za-z0-9_-]{5,300}$/.test(person))
		throw new CliError("invalid_argument", "Use the person's stable ID from user get or chat list");
	if (note.length > 2000) throw new CliError("invalid_argument", "Note is too long");
	// The stage has to be one the card's own goal understands. Accepting any
	// string would let a lead be marked "talking" and then quietly be inferred
	// again by the friendship rules.
	const events = await store.events();
	const card = relationships(events).get(person);
	const lists = vocabularies(events);
	const vocabulary = (card?.goal && lists.get(card.goal)) || DEFAULT_VOCABULARY;
	if (!vocabulary.stages.includes(stage))
		throw new CliError("invalid_argument", `--stage must be one of ${vocabulary.stages.join(", ")}`, {
			details: { goal: card?.goal ?? null, vocabulary: vocabulary.id },
		});
	await store.append("social.stage", { person, stage, note, goal: card?.goal ?? null });
	return { person, stage, note, goal: card?.goal ?? null };
}

export function stageVocabulary(events: Event[], goal?: string | null): Vocabulary {
	return (goal && vocabularies(events).get(goal)) || DEFAULT_VOCABULARY;
}

export async function recordFollowup(store: Store, person: string, topic: string, due: string) {
	if (!person.trim()) throw new CliError("invalid_argument", "Name the person this follow-up is for");
	if (!topic.trim()) throw new CliError("invalid_argument", "Say what needs following up");
	if (Number.isNaN(Date.parse(due))) throw new CliError("invalid_argument", "Use an ISO date for --due");
	await store.append("social.followup", { person, topic, due });
	return { person, topic, due };
}

export async function closeFollowup(store: Store, person: string, at: string) {
	await store.append("social.followup.done", { person, at });
	return { person, at };
}

// What deserves attention today. Two different situations are worth a look:
// a follow-up that has come due, and a card that has been quiet long enough for
// a natural next message. They are not the same, so they are reported apart —
// and the second one only applies to someone who has answered before. Writing
// again into silence is not follow-up, it is the thing this project refuses to
// build.
const CLOSED = new Set(["won", "lost", "resting", "dropped"]);
export function dueToday(cards: Card[], now = Date.now(), heard: Set<string> = new Set()) {
	const quietAfter = 3 * 24 * 3600_000;
	return [...cards.values()]
		.flatMap((card) => {
			// A closed or set-aside card is owed nothing: the owner already said
			// this one is not to be pursued.
			if (CLOSED.has(card.stage) || card.forgotten) return [];
			const owed = card.open_followups.filter((entry) => Date.parse(entry.due) <= now);
			const quiet =
				card.contact_count > 0 &&
				!!card.last_contact &&
				// Only someone who replied once is a conversation. A card that never
				// answered has nothing to continue.
				heard.has(card.person) &&
				now - Date.parse(card.last_contact) >= quietAfter;
			if (!owed.length && !quiet) return [];
			return [
				{
					person: card.person,
					stage: card.stage,
					goal: card.goal,
					why: owed.length ? "a follow-up is due" : "it has been quiet for a while",
					last_text: card.last_text,
					last_contact: card.last_contact,
					followups: owed,
				},
			];
		})
		.sort((a, b) => (a.last_contact ?? "").localeCompare(b.last_contact ?? ""));
}

// Who has written back at least once, read from the conversation windows this
// installation recorded. A direction the page did not state is not evidence of
// a reply, so "unknown" does not count.
export function heardFrom(events: Event[]): Set<string> {
	const heard = new Set<string>();
	for (const event of events) {
		const data = record(event);
		if (!Array.isArray(data.messages)) continue;
		const person = subjectOf(event);
		if (!person) continue;
		const answered = data.messages.some(
			(message) =>
				message && typeof message === "object" && (message as Record<string, unknown>).direction === "incoming",
		);
		if (answered) heard.add(person);
	}
	return heard;
}

// A card can be set aside without being a stage: the owner has the right to say
// "not this person" without inventing an interaction. Recorded as its own event
// so the stage stays what it was — the reason for leaving is not a stage.
export async function forgetPerson(store: Store, person: string, reason: string) {
	if (!/^[A-Za-z0-9_-]{5,300}$/.test(person))
		throw new CliError("invalid_argument", "Use the person's stable ID from user get or chat list");
	const card = relationships(await store.events()).get(person);
	if (!card) throw new CliError("not_found", "That person has no card");
	await store.append("social.forgotten", { person, reason: reason.slice(0, 2000) });
	return { person, forgotten: true, had_stage: card.stage };
}

export async function socialView(store: Store, operation: string, input: { person?: string; limit?: number }) {
	const events = await store.events();
	const cards = relationships(events);
	const lists = vocabularies(events);
	if (operation === "social.relation") {
		const person = input.person ?? "";
		const card = cards.get(person);
		if (!card)
			return {
				person,
				known: false,
				limitations: ["No interaction and no stage have been recorded for this person yet."],
			};
		const touches = events
			.map((event, index) => ({ event, index }))
			.filter(({ event }) => subjectOf(event) === person && OUTWARD.has(event.operation))
			// Same millisecond: the later line in the append-only log is the newer
			// interaction, and `at` alone cannot say which came first.
			.sort((a, b) => b.event.at.localeCompare(a.event.at) || b.index - a.index)
			.map(({ event }) => event)
			.slice(0, input.limit ?? 10)
			.map((event) => ({
				at: event.at,
				kind: event.operation,
				text: typeof record(event).text === "string" ? (record(event).text as string) : "",
				source: `event:default:${event.id}`,
			}));
		const vocabulary = stageVocabulary(events, card.goal);
		return { ...card, known: true, vocabulary, timeline: touches };
	}
	if (operation === "social.due") {
		const heard = heardFrom(events);
		// Cards where every message went out and nothing came back. Reported
		// separately because the useful answer is the opposite of a reminder:
		// stop, do not send again.
		const unanswered = [...cards.values()]
			.filter((card) => card.contact_count > 0 && !heard.has(card.person) && !CLOSED.has(card.stage))
			.map((card) => ({ person: card.person, stage: card.stage, goal: card.goal, sent: card.contact_count }));
		return { items: dueToday([...cards.values()], Date.now(), heard), unanswered, scope: "local_events" };
	}
	const list = [...cards.values()].sort((a, b) =>
		(b.last_contact ?? b.first_seen).localeCompare(a.last_contact ?? a.first_seen),
	);
	return {
		relations: list.slice(0, input.limit ?? 50),
		count: list.length,
		vocabularies: [...lists.values()],
		scope: "local_events",
		limitations: [
			"Cards are derived from this installation's own event log; nothing here is read from the platform.",
			"A stage you never set is inferred from what was sent, and the goal's vocabulary decides how far that can go.",
		],
	};
}

// What this agent did on its own behalf. The point is not a dashboard: it is to
// answer, in one call, "what has it been up to" and "what is it waiting on me
// for". Read events and proposals are separated because only the second kind
// changes anything for another person.
export function socialLog(events: Event[], options: { since?: string; limit?: number }) {
	const reads = new Set([
		"video.info",
		"comment.list",
		"chat.read",
		"user.get",
		"user.followers",
		"user.following",
		"search.results",
		"social.discover",
	]);
	const entries = events
		.filter((event) => !options.since || event.at >= options.since)
		.filter(
			(event) =>
				OUTWARD.has(event.operation) ||
				reads.has(event.operation) ||
				event.operation.startsWith("action.") ||
				event.operation.startsWith("social."),
		)
		.map((event, index) => {
			// The log is append-only, so a higher index happened later. Two events
			// written in the same millisecond share an `at` and the order between
			// them is otherwise undefined — which made "newest first" return the
			// older one on a faster machine.
			const order = index;
			const data = record(event);
			const kind = OUTWARD.has(event.operation)
				? "acted"
				: reads.has(event.operation)
					? "looked"
					: event.operation.startsWith("action.")
						? "proposed"
						: "noted";
			const failed = data.ok === false;
			return {
				at: event.at,
				order,
				kind: failed ? "failed" : kind,
				operation: event.operation,
				target:
					typeof data.conversation_id === "string"
						? data.conversation_id
						: typeof data.user_id === "string"
							? data.user_id
							: typeof data.video_id === "string"
								? data.video_id
								: null,
				text: typeof data.text === "string" ? data.text : "",
				error: failed && typeof data.error_code === "string" ? data.error_code : null,
				source: `event:default:${event.id}`,
			};
		})
		.sort((a, b) => b.at.localeCompare(a.at) || b.order - a.order);
	return {
		// `order` positioned the sort; it is not part of the response.
		entries: entries.slice(0, options.limit ?? 50).map(({ order: _order, ...entry }) => entry),
		counts: {
			looked: entries.filter((entry) => entry.kind === "looked").length,
			acted: entries.filter((entry) => entry.kind === "acted").length,
			proposed: entries.filter((entry) => entry.kind === "proposed").length,
			failed: entries.filter((entry) => entry.kind === "failed").length,
		},
		scope: "local_events",
		limitations: [
			"Nothing here is read from the platform: this is what this installation recorded.",
			"Looking is not remembering; a read that taught nothing still appears here.",
		],
	};
}

// Pausing is one switch, not a policy engine. While paused the agent may still
// look, because looking changes nothing for anyone else; it may not act.
export async function setPaused(store: Store, paused: boolean, reason: string) {
	const events = await store.events();
	const current = pauseState(events);
	if (current.paused === paused) return { ...current, unchanged: true };
	await store.append(paused ? "social.paused" : "social.resumed", { reason });
	return { paused, since: new Date().toISOString(), reason };
}

export function pauseState(events: Event[]) {
	let paused = false;
	let since: string | null = null;
	let reason = "";
	for (const event of events) {
		if (event.operation === "social.paused") {
			paused = true;
			since = event.at;
			reason = typeof record(event).reason === "string" ? (record(event).reason as string) : "";
		} else if (event.operation === "social.resumed") {
			paused = false;
			since = null;
			reason = "";
		}
	}
	return { paused, since, reason };
}

// A goal's daily limit counts people newly reached today, not actions. Three
// comments on one person is one person; the rule exists to stop the agent from
// spreading outward, not to ration how much it says to someone it already talks
// to. Enforced by refusing: nothing is queued for later.
export function checkGoalQuota(events: Event[], goalId: string): void {
	const goal = goalsById(events).get(goalId);
	if (!goal) throw new CliError("not_found", "That goal does not exist", { details: { goal: goalId } });
	const limit = goal.daily_limit;
	if (limit === null) return;
	const today = new Date().toISOString().slice(0, 10);
	// The first outward event a goal records for a person is the contact that
	// counts; later ones on the same day against the same person do not.
	const reached = new Map<string, string>();
	for (const event of events) {
		if (!OUTWARD.has(event.operation)) continue;
		const data = record(event);
		if (data.goal !== goalId) continue;
		const person = subjectOf(event);
		if (!person || reached.has(person)) continue;
		reached.set(person, event.at);
	}
	const used = [...reached.values()].filter((at) => at.slice(0, 10) === today).length;
	if (used >= limit)
		throw new CliError("state", "This goal's daily limit is already reached", {
			hint: "Wait until tomorrow, raise the limit with a new goal, or act under a different goal.",
			details: { goal: goalId, used, limit, counted: "people newly reached today" },
		});
}

// Goal limits live with the goal events, which are also where the vocabularies
// come from; reading them here keeps the quota check independent of the
// discover module.
function goalsById(events: Event[]): Map<string, { daily_limit: number | null }> {
	const found = new Map<string, { daily_limit: number | null }>();
	for (const event of events) {
		if (event.operation !== "social.goal") continue;
		const data = record(event);
		const id = typeof data.id === "string" ? data.id : null;
		if (!id) continue;
		found.set(id, { daily_limit: typeof data.daily_limit === "number" ? data.daily_limit : null });
	}
	return found;
}

// What came of a lead. A result is the owner's conclusion, never something the
// CLI infers: an answer is not a sale, and only a person can say one happened.
// Keeping the outcome separate from the stage is deliberate — the stage records
// where the conversation is, the outcome records what it was worth.
export const OUTCOMES = ["won", "lost", "dropped", "pending"] as const;

export interface Outcome {
	person: string;
	goal: string | null;
	outcome: string;
	note: string;
	at: string;
	// The signal this contact was built on, by event id, when the caller knew it.
	signal: string | null;
}

export async function recordOutcome(
	store: Store,
	person: string,
	outcome: string,
	options: { goal?: string; note?: string; signal?: string } = {},
) {
	if (!/^[A-Za-z0-9_-]{5,300}$/.test(person))
		throw new CliError("invalid_argument", "Use the person's stable ID from user get or chat list");
	if (!OUTCOMES.includes(outcome as (typeof OUTCOMES)[number]))
		throw new CliError("invalid_argument", `--outcome must be ${OUTCOMES.join(", ")}`);
	if ((options.note ?? "").length > 2000) throw new CliError("invalid_argument", "Note is too long");
	const events = await store.events();
	const card = relationships(events).get(person);
	if (!card)
		throw new CliError("not_found", "That person has no card yet", { hint: "Contact them first, or record a stage." });
	// A result can only be filed under a goal that actually reached this person,
	// so a typo or a stale goal id cannot invent a conclusion under a funnel that
	// never touched them. The card's own goal is the default.
	const reached = new Set<string>();
	for (const event of events) {
		if (!OUTWARD.has(event.operation)) continue;
		const data = record(event);
		if (subjectOf(event) !== person || typeof data.goal !== "string") continue;
		reached.add(data.goal);
	}
	if (options.goal && !reached.has(options.goal))
		throw new CliError("not_found", "This goal has not reached that person", {
			hint: "Act under the goal first, or omit --goal to use the card's own.",
			details: { goal: options.goal, reached: [...reached] },
		});
	const goal = options.goal && reached.has(options.goal) ? options.goal : (card.goal ?? null);
	await store.append("social.outcome", {
		person,
		goal,
		outcome,
		note: options.note ?? "",
		...(options.signal ? { signal: options.signal } : {}),
	});
	return { person, goal, outcome, note: options.note ?? "", signal: options.signal ?? null };
}

export function outcomes(events: Event[]): Outcome[] {
	return events
		.filter((event) => event.operation === "social.outcome")
		.map((event) => {
			const data = record(event);
			return {
				person: typeof data.person === "string" ? data.person : "",
				goal: typeof data.goal === "string" ? data.goal : null,
				outcome: typeof data.outcome === "string" ? data.outcome : "",
				note: typeof data.note === "string" ? data.note : "",
				at: event.at,
				signal: typeof data.signal === "string" ? data.signal : null,
			};
		})
		.filter((outcome) => outcome.person);
}

// Per goal: how many people were reached, how many got anywhere, and how many
// reached a conclusion. The last two are kept apart because an unfinished lead
// is not a failure — but a report that adds them together hides how much is
// still open.
export function outcomeSummary(events: Event[]) {
	const cards = relationships(events);
	const results = outcomes(events);
	const byGoal = new Map<
		string,
		{
			goal: string;
			people: number;
			progressed: number;
			concluded: number;
			open: number;
			outcomes: Record<string, number>;
		}
	>();
	for (const card of cards.values()) {
		const key = card.goal ?? "unassigned";
		const entry = byGoal.get(key) ?? {
			goal: key,
			people: 0,
			progressed: 0,
			concluded: 0,
			open: 0,
			outcomes: {},
		};
		entry.people += 1;
		// "Progressed" means someone other than the agent's own sending moved it:
		// a card past the evidence limit needed a person to say so.
		if ((card.stage_position ?? 0) > 2) entry.progressed += 1;
		const concluded = results.filter((result) => result.person === card.person && result.goal === card.goal);
		const final = concluded.filter((result) => result.outcome !== "pending");
		if (final.length) {
			entry.concluded += 1;
			for (const result of final) entry.outcomes[result.outcome] = (entry.outcomes[result.outcome] ?? 0) + 1;
		} else entry.open += 1;
		byGoal.set(key, entry);
	}
	return {
		goals: [...byGoal.values()],
		total_resolved: results.length,
		scope: "local_events",
		limitations: [
			"Outcomes are conclusions the owner or caller recorded; nothing here is inferred from replies.",
			"Open is not failed: a lead with no result yet is simply unfinished.",
		],
	};
}

// How much of each goal's day is spent. Reported beside the log because "what
// did it do" and "how much may it still do today" are the same question asked
// before and after the fact.
export function goalUsage(events: Event[]) {
	const limits = new Map<string, number | null>();
	for (const event of events) {
		if (event.operation !== "social.goal") continue;
		const data = record(event);
		const id = typeof data.id === "string" ? data.id : null;
		if (!id) continue;
		limits.set(id, typeof data.daily_limit === "number" ? data.daily_limit : null);
	}
	const today = new Date().toISOString().slice(0, 10);
	const reached = new Map<string, Set<string>>();
	for (const event of events) {
		if (!OUTWARD.has(event.operation) || event.at.slice(0, 10) !== today) continue;
		const goal = record(event).goal;
		if (typeof goal !== "string") continue;
		const person = subjectOf(event);
		if (!person) continue;
		const set = reached.get(goal) ?? new Set<string>();
		set.add(person);
		reached.set(goal, set);
	}
	return [...limits.entries()].map(([goal, limit]) => {
		const used = reached.get(goal)?.size ?? 0;
		return {
			goal,
			used,
			limit,
			remaining: limit === null ? null : Math.max(0, limit - used),
		};
	});
}
