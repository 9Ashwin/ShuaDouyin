import { randomUUID } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";
import { FRIEND_STAGES, LEAD_STAGES, relationships } from "./social.ts";

// Discovery answers a different question from browsing: not "what is on screen"
// but "who is worth meeting, and why this one". The answer needs a goal to judge
// against and evidence the caller can check, so both are recorded before any
// candidate is produced.

// The two vocabularies the CLI knows by name. A caller may also supply its own
// list, because a business has its own stages and the code should not have to
// learn them all.
const PRESETS: Record<string, string[]> = { friend: [...FRIEND_STAGES], lead: [...LEAD_STAGES] };

export interface Goal {
	id: string;
	description: string;
	topics: string[];
	paused: boolean;
	created_at: string;
	paused_at?: string;
	stages: string[];
	evidence_stops_at: number;
	// How many distinct people this goal may newly reach per day. Null is no cap.
	daily_limit: number | null;
}

function record(event: Event): Record<string, unknown> {
	const data = event.data;
	return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

export function goals(events: Event[]): Goal[] {
	const found = new Map<string, Goal>();
	for (const event of events) {
		const data = record(event);
		if (event.operation === "social.goal") {
			const id = typeof data.id === "string" ? data.id : null;
			if (!id) continue;
			const stages = Array.isArray(data.stages)
				? data.stages.filter((stage): stage is string => typeof stage === "string" && !!stage)
				: [...FRIEND_STAGES];
			found.set(id, {
				id,
				description: typeof data.description === "string" ? data.description : "",
				topics: Array.isArray(data.topics) ? data.topics.filter((topic) => typeof topic === "string") : [],
				paused: false,
				created_at: event.at,
				stages,
				evidence_stops_at:
					typeof data.evidence_stops_at === "number" && data.evidence_stops_at >= 0 ? data.evidence_stops_at : 2,
				daily_limit: typeof data.daily_limit === "number" ? data.daily_limit : null,
			});
		} else if (event.operation === "social.goal.paused") {
			const goal = found.get(typeof data.id === "string" ? data.id : "");
			if (goal) {
				goal.paused = true;
				goal.paused_at = event.at;
			}
		}
	}
	return [...found.values()];
}

export async function addGoal(
	store: Store,
	description: string,
	topics: string,
	options: { preset?: string; stages?: string; dailyLimit?: number } = {},
) {
	if (!description.trim()) throw new CliError("invalid_argument", "Say what kind of relationship you want to build");
	const list = topics
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	// A preset names a vocabulary; an explicit list overrides it. Both are
	// recorded with the goal, because a card's stage must stay readable even
	// after the shipped defaults change.
	const named = options.preset ?? "friend";
	const preset = PRESETS[named];
	if (options.preset && !preset)
		throw new CliError("invalid_argument", `--preset must be ${Object.keys(PRESETS).join(", ")}`, {
			hint: "Use --stages to define your own list instead.",
		});
	const custom = (options.stages ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (options.stages !== undefined && custom.length < 2)
		throw new CliError("invalid_argument", "--stages needs at least two stage names, comma separated");
	const stages = custom.length ? custom : [...(preset ?? FRIEND_STAGES)];
	if (new Set(stages).size !== stages.length) throw new CliError("invalid_argument", "Stage names must be distinct");
	const id = randomUUID();
	await store.append("social.goal", {
		id,
		description,
		topics: list,
		preset: custom.length ? "custom" : named,
		stages,
		// Evidence may only carry a card through the first two stages, whatever
		// the list is: what was sent can show contact, never a result.
		evidence_stops_at: Math.min(2, stages.length - 1),
		...(options.dailyLimit === undefined ? {} : { daily_limit: options.dailyLimit }),
	});
	return {
		id,
		description,
		topics: list,
		paused: false,
		stages,
		evidence_stops_at: Math.min(2, stages.length - 1),
		daily_limit: options.dailyLimit ?? null,
	};
}

export async function pauseGoal(store: Store, id: string) {
	const current = goals(await store.events()).find((goal) => goal.id === id);
	if (!current) throw new CliError("not_found", "Goal not found");
	if (current.paused) return { ...current, already_paused: true };
	await store.append("social.goal.paused", { id });
	return { ...current, paused: true };
}

export interface CandidateSource {
	person: string;
	name: string;
	where: string;
	source: string;
	context: string;
}

// Where a candidate could come from, as reported by the caller. Discovery does
// not crawl on its own: it takes what the caller already read and turns it into
// candidates with reasons, so the evidence behind each one stays visible.
export async function discover(
	store: Store,
	input: { sources?: string; goal?: string; limit?: number },
	sources: CandidateSource[],
) {
	const events = await store.events();
	const all = goals(events);
	const active = all.filter((goal) => !goal.paused);
	// A goal is an answer to a question the owner may never answer. Without one,
	// discovery uses who this account already leans toward: the topics its own
	// memories and comments keep returning to. That is the same judgement the
	// owner would have given, drawn from what the bot actually did.
	const explicit = input.goal ? active.find((entry) => entry.id === input.goal) : active[0];
	if (input.goal && !explicit) throw new CliError("not_found", "That goal is not active");
	const goal: Goal = explicit ?? inferredGoal(events);

	const cards = relationships(events);
	const seen = new Set<string>();
	const candidates = sources
		.filter((source) => {
			if (!source.person || seen.has(source.person)) return false;
			seen.add(source.person);
			return true;
		})
		// Someone already on a card is not a discovery: they are a relationship, and
		// surfacing them again would read as a new person to meet.
		.filter((source) => !cards.has(source.person))
		.map((source) => {
			const topics = goal.topics.filter((topic) => source.context.includes(topic));
			return {
				person: source.person,
				name: source.name,
				where: source.where,
				common_ground: topics.length ? topics : [],
				opening: topics.length
					? `Mention ${topics.join("、")} — it appears in what they wrote.`
					: "No shared topic was found in what was read; open with what they actually said.",
				source: source.source,
				goal: { id: goal.id, description: goal.description },
				// A candidate carries its own uncertainty: a match on a topic string is
				// not an interest, and saying so is what keeps the list honest.
				uncertainty: topics.length ? "A shared word, not a verified interest." : "No shared topic found.",
			};
		})
		.slice(0, input.limit ?? 20);

	return {
		goal,
		candidates,
		count: candidates.length,
		scope: "caller_supplied_sources",
		limitations: [
			"Candidates come from what the caller read; this command does not crawl.",
			"A shared word is not a shared interest; the reason is evidence to check, not a verdict.",
			"People already on a relationship card are excluded.",
		],
	};
}

// What this account has been paying attention to, read from its own record. It
// is deliberately thin: a goal built this way says only that these words kept
// coming up, which is enough to rank candidates and not enough to claim taste.
function inferredGoal(events: Event[]): Goal {
	const counts = new Map<string, number>();
	for (const event of events) {
		// Text sits at different depths depending on the command: a write keeps it
		// at the top, a read keeps what it read one or two levels down. Walking the
		// whole data object is the only way to count what this account actually
		// looked at without hard-coding each command's shape.
		// Chinese has no spaces, and a greedy run would cut "这首歌的吉他编曲" into one
		// word that never repeats. Sliding a 2..4 character window over each run and
		// keeping what recurs finds the shared terms instead.
		for (const text of strings(event.data))
			for (const run of text.match(/[\u4e00-\u9fa5]{2,}/g) ?? [])
				for (let width = 2; width <= Math.min(4, run.length); width++)
					for (let start = 0; start + width <= run.length; start++) {
						const word = run.slice(start, start + width);
						counts.set(word, (counts.get(word) ?? 0) + 1);
					}
	}
	const topics = [...counts.entries()]
		.filter(([, count]) => count >= 2)
		.sort((a, b) => b[1] - a[1])
		.slice(0, 8)
		.map(([word]) => word);
	return {
		id: "inferred",
		description: "No goal was set; using what this account keeps talking about.",
		topics,
		paused: false,
		created_at: new Date().toISOString(),
		stages: [...FRIEND_STAGES],
		evidence_stops_at: 2,
		daily_limit: null,
	};
}

// Every string inside a recorded value, at any depth. Bounded so a large read
// cannot make this the slowest part of a command.
function strings(value: unknown, depth = 0): string[] {
	if (depth > 5) return [];
	if (typeof value === "string") return [value];
	if (Array.isArray(value)) return value.flatMap((entry) => strings(entry, depth + 1));
	if (value && typeof value === "object")
		return Object.values(value as Record<string, unknown>).flatMap((entry) => strings(entry, depth + 1));
	return [];
}
