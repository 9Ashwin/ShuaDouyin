import type { Input } from "./app.ts";

export interface Flag {
	key: keyof Input;
	name: string;
	description: string;
	type: "string" | "number" | "boolean" | "boolean-value";
	default?: string | number | boolean;
	required?: boolean;
}
export interface CommandSpec {
	id: string;
	description: string;
	argument?: { key: keyof Input; name: string; description: string; optional?: boolean };
	flags?: Flag[];
	effect: "read" | "navigation" | "local" | "account_write";
	guidance?: string;
	examples?: string[];
}

// What a group command is for, in the words someone scanning the top-level
// help needs. Without this every group said "<name> operations", which is the
// command's own name read back and tells a caller nothing about where to look.
export const GROUPS: Record<string, string> = {
	skill: "Install the agent skill and check whether a copy has drifted",
	onboarding: "Ask the four setup questions and record the answers",
	growth: "Review this bot's activity and turn it into memory and persona updates",
	workspace: "Read and revise the persona and people-profile documents",
	memory: "Store, correct, search and maintain sourced long-term memory",
	browse: "Open a browsing round and record what was watched or skipped",
	context: "Export persona, relevant memories and recent activity for a caller",
	report: "Prepare sourced daily-report material and save the report",
	bot: "Create, inspect and reset the bot workspace",
	browser: "Start, stop and configure the dedicated Chrome",
	auth: "Log in and read the current login and verification state",
	page: "Compare the live page's markers with the ones the code knows",
	live: "Read a live room and send danmaku or one priced gift",
	feed: "Move through the recommended video feed",
	creator: "Inspect the creator upload landing page",
	user: "Read profiles and set the follow state",
	link: "Resolve share text or a URL to a canonical work ID",
	video: "Open a work and read, play, like, favorite, capture or sample it",
	note: "Read the slides of an image post",
	comment: "Read comments and post text, replies or one image",
	chat: "Read conversations and send text, images, replies or shares",
	social: "Track goals, candidates, relationship cards and outcomes",
	forward: "List recipients the share panel offers",
	history: "Read local operation facts and share attempts",
	share: "Inspect locally recorded share attempts",
	receipt: "Inspect a persisted write receipt",
};

const video: Flag = {
	key: "video_id",
	name: "--video-id <id>",
	description: "Exact video ID from video info",
	type: "string",
};
const conversation: Flag = {
	key: "conversation_id",
	name: "--conversation-id <id>",
	description: "Stable ID from chat list",
	type: "string",
	required: true,
};
const text: Flag = { key: "text", name: "--text <text>", description: "Exact text to send", type: "string" };
// Which goal this write serves. Optional because a person may act without one,
// but a write that names it is what attaches the resulting card to that goal's
// stages and quota.
const goal: Flag = {
	key: "goal",
	name: "--goal <id>",
	description: "Goal ID this action serves",
	type: "string",
};
// A sticker is not text: it is chosen from the composer's smiley grid by the
// name the platform gives it, so the flag carries that name and nothing else.
const sticker: Flag = {
	key: "emoji",
	name: "--emoji <name>",
	description: "Pick one sticker by the name the page shows, e.g. 比心 or [微笑]",
	type: "string",
};
const textFile: Flag = {
	key: "text_file",
	name: "--text-file <path>",
	description: "Read UTF-8 text from a file, or - for stdin",
	type: "string",
};
const value: Flag = {
	key: "enabled",
	name: "--value <boolean>",
	description: "Desired state: true or false",
	type: "boolean-value",
	default: true,
};
const paging: Flag[] = [
	{ key: "limit", name: "--limit <count>", description: "Maximum returned records", type: "number", default: 20 },
	{
		key: "scrolls",
		name: "--scrolls <count>",
		description: "Additional page scrolls to load more records",
		type: "number",
		default: 0,
	},
];

const memoryFields: Flag[] = [
	{
		key: "memory_type",
		name: "--memory-type <type>",
		description: "memory, observation, insight or profile",
		type: "string",
	},
	{
		key: "layer",
		name: "--layer <layer>",
		description: "preference, identity, context, experience, activity, persona or note",
		type: "string",
	},
	{
		key: "subject",
		name: "--subject <subject>",
		description: "Subject, e.g. self, owner or a stable person ID",
		type: "string",
	},
	{ key: "topic", name: "--topic <topic>", description: "Short topic for grouping and file naming", type: "string" },
	{
		key: "profile_ref",
		name: "--profile-ref <ref>",
		description: "Linked PROFILES.md entry, shaped user:<id> or group:<id>",
		type: "string",
	},
	{ key: "tags", name: "--tags <labels>", description: "Comma-separated labels for recall", type: "string" },
	{
		key: "certainty",
		name: "--certainty <certainty>",
		description: "observed, inferred or user-stated",
		type: "string",
	},
	{ key: "confidence", name: "--confidence <number>", description: "Caller-assessed confidence, 0..1", type: "number" },
	{
		key: "source",
		name: "--source <reference>",
		description: "Supporting event, user statement or external reference",
		type: "string",
		required: true,
	},
	{
		key: "links",
		name: "--links <ids>",
		description: "Comma-separated memory IDs from this bot; empty clears links",
		type: "string",
	},
];
const expected: Flag = {
	key: "if_match",
	name: "--if-match <revision>",
	description: "Revision returned by get; required when replacing existing content",
	type: "string",
};
const memoryArgument = { key: "resource" as const, name: "id", description: "Memory ID returned by list/search" };

// This catalog owns command descriptions, input metadata, help and schema.
export const COMMANDS: CommandSpec[] = [
	{
		id: "guide",
		description: "Read the agent workflow for onboarding, browsing, feedback and sourced reports",
		effect: "read",
	},
	{
		id: "source",
		description: "Locate the ShuaDouyin source checkout that is running this dy",
		effect: "local",
		guidance:
			"Any agent using dy can improve it from wherever it is running. The reported path is the real working tree behind this executable, so a fix made there reaches the next dy run after a build. Prefer the reported branch and HEAD; do not assume the caller's project is the source.",
	},
	{
		id: "update",
		description: "Report how this dy was installed, what commit it is, and whether a newer one exists",
		flags: [
			{
				key: "force",
				name: "--check",
				description: "Ask GitHub for the newest commit instead of reporting only what is local",
				type: "boolean",
			},
		],
		effect: "read",
		guidance:
			"The version number does not change between pushes, so it cannot say whether a copy is current. The commit it was built from can. --check compares that with the repository's main; without it this reports only what the local copy knows and works offline. The update command is the one that matches how this copy was installed.",
	},
	{ id: "skill.status", description: "Compare the bundled skill with the copies installed for agents", effect: "read" },
	{
		id: "skill.install",
		description: "Copy the bundled skill into the directories agents read",
		flags: [
			{
				key: "force",
				name: "--force",
				description: "Replace an existing copy that this installer did not create",
				type: "boolean",
			},
		],
		effect: "local",
		guidance:
			"Links the bundled skill into ~/.claude/skills/dy, ~/.agents/skills/dy and ~/.codex/skills/dy, skipping any of those agents that is not installed. A symlink is used when possible so the agent always reads the current guidance; a copy is the fallback. An existing directory this installer did not create is left alone unless --force is given.",
	},
	{
		id: "init",
		description: "Create the workspace and start owner onboarding",
		flags: [
			{ key: "name", name: "--name <name>", description: "Display name", type: "string" },
			{
				key: "preset",
				name: "--preset <preset>",
				description: "observer, curious or analyst",
				type: "string",
			},
		],
		effect: "local",
	},
	{
		id: "onboarding.show",
		description: "Read the owner setup questions and current onboarding status",
		effect: "read",
	},
	{ id: "onboarding.complete", description: "Mark owner setup complete after settings are saved", effect: "local" },
	{ id: "onboarding.skip", description: "Leave owner setup for later", effect: "local" },
	{
		id: "growth.review",
		description: "Collect this bot's browsing activity and guidance for memory and persona updates",
		flags: [
			{ key: "since", name: "--since <timestamp>", description: "Events after an RFC3339 timestamp", type: "string" },
			{ key: "limit", name: "--limit <count>", description: "Maximum recent events", type: "number", default: 20 },
		],
		guidance:
			"The caller interprets evidence and writes sourced updates. --since is a read-only historical view; acknowledge pending events in order.",
		effect: "read",
	},
	{
		id: "growth.ack",
		description: "Acknowledge this bot's activity through an event after saving observations",
		flags: [],
		guidance: "Acknowledge the next pending event only after saving any relevant memory, persona or report updates.",
		effect: "local",
	},
	{
		id: "voice.check",
		description: "Point out what makes a piece of Chinese text read as machine-written",
		flags: [
			{
				key: "text",
				name: "--text <text>",
				description: "The text to check",
				type: "string",
			},
		],
		guidance:
			"Reports the exact phrases that read as AI, with the reason each one does, plus the markers of a text scrubbed past natural — a comma chain, five equal-length sentences, one judgement sentence after another. Both directions matter: the catalog exists because deleting every tell is its own way of reading as written by a machine. The catalog is adapted from PenguinHarness's Chinese humanizer cues. Advice, not a gate: a flagged phrase kept on purpose is still a choice, and this never rewrites the text.",
		effect: "local",
	},
	{
		id: "learn.keep",
		description: "Record what this round taught into the bot's own lessons file",
		flags: [
			{
				key: "since",
				name: "--since <timestamp>",
				description: "Only consider activity after an RFC3339 timestamp",
				type: "string",
			},
			{
				key: "note",
				name: "--note <text>",
				description: "One conclusion you reached that the tool cannot measure",
				type: "string",
			},
		],
		guidance:
			"Call this when a round taught something worth carrying into the next one. The tool proposes findings it can support from the activity: repeated failures of the same command, comments that carried a signal, rounds that mostly skipped. It cannot say why one of those mattered, so --note records your own conclusion verbatim and is marked as authored. Findings go to lessons.md with their source, are deduplicated against what is already there, and are never rewritten by an update the way the shipped skill is. Read it with workspace get lessons.md and delete what you disagree with.",
		effect: "local",
	},
	{
		id: "learn.findings",
		description: "Read what this bot has kept from earlier rounds",
		flags: [],
		guidance: "The same file learn keep writes, so a caller can check what it already knows before adding more.",
		effect: "local",
	},
	{
		id: "persona.snapshot",
		description: "Keep the persona as the next version before a derived rewrite replaces it",
		flags: [],
		guidance:
			"persona evolve takes its own snapshot before writing, so this is for a caller that is about to change the persona some other way. Versions only increase and a number is never reused: rollback to v3 always means the same state. Keep the number it prints.",
		effect: "local",
	},
	{
		id: "persona.rollback",
		description: "Restore a persona version, keeping what it replaced",
		argument: { key: "resource", name: "version", description: "Version number from persona history" },
		flags: [],
		guidance:
			"A persona that drifts somewhere worse has to be able to move back, or evolving only ever means moving forward. The state being replaced is snapshotted first, so a rollback that turns out to be wrong is undone the same way. Only AGENTS.md and PROFILES.md have versions.",
		effect: "local",
	},
	{
		id: "persona.history",
		description: "List kept persona versions, newest first",
		flags: [],
		guidance:
			"Shows version, content revision and time. The revision is what tells two versions apart when the words look alike.",
		effect: "local",
	},
	{
		id: "persona.migrate",
		description: "Move a persona created before it could grow onto the current template",
		flags: [],
		guidance:
			"Replaces the retired line that told the bot to keep the owner's settings fixed and never rewrite the persona. That line contradicts the growth section in the same document, and the older, more concrete line wins, so an agent reading it is told both to grow and never to change. Only the exact retired sentence is matched; a persona whose owner has already rewritten it is left alone. Running it twice changes nothing the second time.",
		effect: "local",
	},
	{
		id: "persona.evolve",
		description: "Rewrite the persona's derived voice section from what this account actually wrote",
		flags: [],
		guidance:
			"Rewrites one section of AGENTS.md and leaves the rest of the file untouched. Everything it writes is measured from this account's own sent comments, so the persona grows from evidence instead of from a guess: comment length, exclamation and emoji habits, questions, direct address, first person, and repeated openers. Run it after a browsing round; an unchanged measurement leaves the section as it is. It never invents a trait it cannot measure, which is why the section describes how the bot writes rather than who it is.",
		effect: "local",
	},
	{
		id: "growth.event",
		description: "Retrieve one activity source belonging to the selected bot",
		flags: [],
		effect: "read",
	},
	{
		id: "workspace.get",
		description: "Read a bot persona, profiles or memory overview",
		argument: { key: "resource", name: "file", description: "AGENTS.md, PROFILES.md or MEMORY.md" },
		effect: "read",
	},
	{
		id: "workspace.set",
		description: "Replace a bot-owned persona or profiles document with revision checks",
		argument: { key: "resource", name: "file", description: "AGENTS.md or PROFILES.md" },
		flags: [text, textFile, expected],
		effect: "local",
	},
	{
		id: "workspace.history",
		description: "List saved revisions of a persona or profiles document",
		argument: { key: "resource", name: "file", description: "AGENTS.md or PROFILES.md" },
		effect: "read",
	},
	{
		id: "workspace.restore",
		description: "Restore a saved revision of a missing persona or profiles document",
		argument: { key: "resource", name: "file", description: "AGENTS.md or PROFILES.md" },
		flags: [
			{
				key: "revision",
				name: "--revision <sha256>",
				description: "Revision from workspace history",
				type: "string",
				required: true,
			},
		],
		effect: "local",
	},
	{
		id: "memory.add",
		description: "Save one durable, sourced memory as Markdown",
		flags: [text, textFile, ...memoryFields],
		effect: "local",
		guidance: "Search first; correct an existing fact instead of saving contradictory copies.",
	},
	{ id: "memory.get", description: "Read a memory and its current revision", argument: memoryArgument, effect: "read" },
	{
		id: "memory.candidates",
		description: "Prepare bounded lexical and graph candidates for caller-provided facts",
		flags: [
			text,
			textFile,
			...paging.slice(0, 1),
			{
				key: "budget",
				name: "--budget <characters>",
				description: "Total candidate body character budget (100..20000)",
				type: "number",
				default: 3000,
			},
		],
		guidance:
			"Pass JSON facts with text, sources, optional keywords and profile_ref. Two-hop graph matches are approximate and may miss relevant memories.",
		effect: "read",
	},
	{
		id: "memory.decide",
		description: "Preview or apply one caller-selected memory decision",
		flags: [
			text,
			textFile,
			{ key: "apply", name: "--apply", description: "Apply the decision after preview", type: "boolean" },
		],
		guidance:
			"Pass JSON facts and one ADD, UPDATE, DELETE or NOOP decision. Default is preview; applying a mutation requires --request-id. DELETE removes saved history.",
		effect: "local",
	},
	{
		id: "memory.decision-status",
		description: "Read a decision receipt using its request ID",
		guidance:
			"A prepared receipt means the outcome is uncertain. Inspect the target memory before deciding whether to use a new request ID.",
		effect: "read",
	},
	{
		id: "memory.list",
		description: "List this bot memories",
		flags: [
			...paging.slice(0, 1),
			...memoryFields.filter((flag) => ["layer", "subject", "profile_ref"].includes(flag.key)),
		],
		effect: "read",
	},
	{
		id: "memory.search",
		description: "Search memory text and topics with full-text and short-word matching",
		argument: { key: "query", name: "query", description: "Keywords to recall" },
		flags: [
			...paging.slice(0, 1),
			...memoryFields.filter((flag) => ["layer", "subject", "profile_ref"].includes(flag.key)),
		],
		effect: "read",
	},
	{
		id: "memory.update",
		description: "Correct a memory in place, preserving its ID and revision history",
		argument: memoryArgument,
		flags: [text, textFile, ...memoryFields, { ...expected, required: true }],
		effect: "local",
	},
	{
		id: "memory.delete",
		description: "Forget a memory, remove its source file, index and saved revisions",
		argument: memoryArgument,
		flags: [{ ...expected, required: true }],
		effect: "local",
	},
	{ id: "memory.reindex", description: "Rebuild this bot index and overview from its Markdown files", effect: "local" },
	{ id: "memory.history", description: "List saved revisions of one memory", argument: memoryArgument, effect: "read" },
	{
		id: "memory.graph",
		description: "Read this bot memory nodes and their derived relations",
		effect: "read",
		guidance:
			"Edges are refs, same_profile, same_topic and same_day. Counts describe stored relations, not semantic similarity.",
	},
	{
		id: "memory.status",
		description: "Read memory file, index, edge and overview health",
		effect: "read",
		guidance: "overview_stale means MEMORY.md may lag behind the Markdown sources; reindex rewrites it.",
	},
	{ id: "memory.usage", description: "Read stored memory counts and body byte totals", effect: "read" },
	{
		id: "memory.compact",
		description: "Merge memories whose bodies are byte-identical, keeping the oldest ID",
		effect: "local",
		guidance:
			"Deterministic dedupe only. Bodies that differ are never merged; semantic consolidation remains the calling agent's decision.",
	},
	{
		id: "memory.ingest",
		description: "Reconcile hand-edited Markdown and report ingested and skipped counts",
		effect: "local",
		guidance:
			"Malformed files are reported with their paths; existing indexed revisions are retained. Handwritten concept files may use mem_ IDs, timestamp and metadata; missing sources are marked as file references.",
	},
	{
		id: "browse.start",
		description: "Open a browsing round, or resume the one left open",
		flags: [
			{
				key: "budget",
				name: "--budget <works>",
				description: "Works this round expects to cover",
				type: "number",
				default: 30,
			},
			{ key: "minutes", name: "--minutes <count>", description: "Time budget", type: "number", default: 30 },
			{
				key: "idle",
				name: "--idle <count>",
				description: "Consecutive empty moves before the round looks spent",
				type: "number",
				default: 5,
			},
			{ key: "goal", name: "--goal <id>", description: "Goal this round serves", type: "string" },
		],
		effect: "local",
		guidance:
			"A round left open by a session that died is resumed, not duplicated: two open rounds would each claim a budget and neither would be true. The budget is advisory — browse round says it is spent, and the caller decides to close.",
	},
	{
		id: "browse.end",
		description: "Close a browsing round and keep its summary",
		argument: { key: "resource", name: "round-id", description: "Round ID from browse start" },
		flags: [{ key: "reason", name: "--reason <text>", description: "Why the round stopped", type: "string" }],
		effect: "local",
		guidance: "Closing twice is harmless; the first close wins and the second reports already_closed.",
	},
	{
		id: "browse.watch",
		description: "Record that a work was looked at in this round",
		flags: [
			{ key: "round", name: "--round <id>", description: "Round ID", type: "string", required: true },
			{ ...video, required: true },
		],
		effect: "local",
	},
	{
		id: "browse.skip",
		description: "Record that a work was passed over, and why",
		flags: [
			{ key: "round", name: "--round <id>", description: "Round ID", type: "string", required: true },
			{ ...video, required: true },
			{
				key: "reason",
				name: "--reason <name>",
				description: "seen, live, uninteresting, over_budget or failed",
				type: "string",
				required: true,
			},
		],
		effect: "local",
		guidance:
			"A skip without a reason is not recorded: the count alone hides whether the feed or the agent was the problem.",
	},
	{
		id: "browse.round",
		description: "Summarise one round, or list the recent ones",
		argument: { key: "resource", name: "round-id", description: "Round ID; omit to list", optional: true },
		flags: [{ key: "limit", name: "--limit <count>", description: "Rounds to list", type: "number", default: 10 }],
		effect: "read",
		guidance:
			"Counts are derived from the event log, not from a running counter, so a work recorded twice still counts once and a round whose end was never written is still summarisable.",
	},
	{
		id: "context.browsing",
		description: "What was already seen and acted on, so it is not done twice",
		flags: [{ key: "limit", name: "--limit <count>", description: "Works to return", type: "number", default: 50 }],
		effect: "read",
		guidance:
			"Returns recent works with whether each was already liked, commented or shared, newest first. A work seen in several windows appears once. Nothing about interest is inferred; the list is what was seen, not what was liked.",
	},
	{
		id: "context.show",
		description: "Export a bot persona, relevant memories and workflow for any agent",
		guidance:
			"Recall uses lexical seeds and bounded two-hop relations, not semantic search. With --profile-ref, full PROFILES.md and MEMORY.md are omitted because they may include other people.",
		flags: [
			{ key: "query", name: "--query <query>", description: "Task keywords for memory retrieval", type: "string" },
			{
				key: "budget",
				name: "--budget <characters>",
				description: "Total document and memory body characters (100..20000)",
				type: "number",
				default: 12000,
			},
			{
				key: "profile_ref",
				name: "--profile-ref <ref>",
				description: "Restrict memories to one person or group",
				type: "string",
			},
			...paging.slice(0, 1),
		],
		effect: "read",
	},
	{
		id: "report.prepare",
		description: "Prepare sourced activity and receipt metadata for an agent-authored daily report",
		argument: { key: "resource", name: "date", description: "YYYY-MM-DD in the selected time zone" },
		flags: [
			{
				key: "timezone",
				name: "--timezone <iana>",
				description: "IANA time zone",
				type: "string",
				default: "Asia/Shanghai",
			},
			{ key: "offset", name: "--offset <count>", description: "Page offset", type: "number", default: 0 },
			{ key: "limit", name: "--limit <count>", description: "Maximum records", type: "number", default: 20 },
			expected,
		],
		effect: "read",
		guidance:
			"Returns local sourced metadata, excluding private messages and persona text. Continue with --offset and --if-match <revision>; the caller writes and presents the report. A dispatching receipt does not prove delivery.",
	},
	{
		id: "report.save",
		description: "Save a Markdown report authored by the calling agent",
		argument: { key: "resource", name: "date", description: "YYYY-MM-DD" },
		flags: [text, textFile, expected],
		effect: "local",
	},
	{
		id: "report.get",
		description: "Read a saved daily report",
		argument: { key: "resource", name: "date", description: "YYYY-MM-DD" },
		effect: "read",
	},
	{ id: "report.list", description: "List the selected bot reports", effect: "read" },
	{
		id: "bot.init",
		description: "Restore missing workspace files without overwriting edits",
		flags: [
			{
				key: "preset",
				name: "--preset <preset>",
				description: "Preset for missing AGENTS.md only",
				type: "string",
			},
		],
		effect: "local",
	},
	{
		id: "bot.reset",
		description: "Start the bot over, copying everything accumulated aside first",
		flags: [
			{
				key: "write",
				name: "--write",
				description: "Actually reset; without it only the plan is shown",
				type: "boolean",
			},
		],
		effect: "local",
		guidance:
			"Moves the event log, memories, receipts, persona documents and the SQLite index into a sibling backup directory, then clears them. The Chrome profile is kept, so the Douyin login survives and no new scan is needed. Without --write nothing changes. Run dy init afterwards to create the fresh bot.",
	},
	{ id: "bot.show", description: "Show the workspace path and its documents", effect: "read" },
	{
		id: "browser.start",
		description: "Start dedicated Chrome and reuse its login profile",
		flags: [
			{ key: "headless", name: "--headless", description: "Run Chrome without a visible window", type: "boolean" },
		],
		effect: "local",
		guidance: "For the first login use auth login. Stop Chrome before changing its display mode.",
	},
	{ id: "browser.status", description: "Check whether dedicated Chrome is reachable", effect: "read" },
	{ id: "browser.stop", description: "Close dedicated Chrome and preserve login data", effect: "local" },
	{ id: "browser.config", description: "Show browser preferences for this profile", effect: "read" },
	{
		id: "browser.configure",
		description: "Save browser executable and default display mode",
		flags: [
			{ key: "chrome", name: "--executable <path>", description: "Chrome executable path", type: "string" },
			{ key: "headless", name: "--display <mode>", description: "headed or headless", type: "boolean-value" },
		],
		effect: "local",
	},
	{
		id: "auth.login",
		description: "Open headed Chrome for manual login or verification",
		effect: "navigation",
		guidance:
			"Returns after opening Chrome. Complete login yourself, then call auth status. No passwords or cookies are printed.",
	},
	{
		id: "auth.status",
		description: "Read observed login and verification state",
		effect: "read",
		guidance: "authenticated means the signed-in profile link was observed; its absence does not prove logout.",
	},
	{
		id: "status",
		description: "Read the current owned Douyin tab",
		flags: [
			{
				key: "include_text",
				name: "--include-text",
				description: "Include bounded visible page text",
				type: "boolean",
			},
		],
		effect: "read",
	},
	{
		id: "page.facts",
		description: "Compare the page's real data-e2e markers against the ones the code uses",
		effect: "read",
		guidance:
			"Reports which selectors the adapter relies on that this page does not have, and which markers the page offers that nothing uses. A fixture written by hand cannot catch this: it was written from the same understanding that produced the code. Read-only.",
	},
	{
		id: "live.info",
		description: "Read the live room this tab is on: host, status, whether commenting is open",
		effect: "read",
		guidance:
			"The picture is a canvas with no text layer, so nothing about the game is reported. video_readable is always false — a guess about what is being played is not a reading.",
	},
	{
		id: "live.chat",
		description: "Read the danmaku currently loaded in the room",
		flags: [{ key: "limit", name: "--limit <count>", description: "Most recent lines", type: "number", default: 30 }],
		effect: "read",
		guidance:
			"Chat, gifts, joins and system notices are returned separately: a gift is not a comment, and a join is not a viewer saying anything. Only what is already public in the room is returned.",
	},
	{
		id: "live.say",
		description: "Send one danmaku to the live room",
		flags: [text, textFile],
		effect: "account_write",
		guidance:
			"Clears the editor first and refuses if it cannot be proven empty: a composer holding anything makes the sent line a join of two strings that cannot be told apart afterwards. Confirms by finding the line in the chat; otherwise reports delivery_uncertain. Requires --request-id.",
	},
	{
		id: "live.gifts",
		description: "List the gifts the panel has loaded, with their prices",
		effect: "read",
		guidance: "Prices are what the panel shows. Only loaded items are listed.",
	},
	{
		id: "live.gift",
		description: "Send one gift, matching name and price against the panel",
		flags: [
			{ key: "name", name: "--name <name>", description: "Exact gift name from live gifts", type: "string" },
			{ key: "price", name: "--price <coins>", description: "The price that name must have", type: "number" },
			{ key: "count", name: "--count <n>", description: "How many, 1..10", type: "number", default: 1 },
		],
		effect: "account_write",
		guidance:
			"Spends real money and cannot be undone. Refuses when the name or price does not match the panel exactly. After the click it reads what the room says was sent and reports anything unexpected rather than assuming the click landed on the intended item.",
	},
	{ id: "feed.open", description: "Open the recommended video feed", effect: "navigation" },
	{
		id: "creator.status",
		description: "Inspect the creator upload landing page in this account's Chrome context",
		effect: "navigation",
		guidance:
			"Reports visible controls only. It does not verify creator account identity, inspect existing drafts, upload or publish.",
	},
	{ id: "feed.next", description: "Move to the next video and verify that its ID changed", effect: "navigation" },
	{
		id: "feed.sweep",
		description: "Walk several slides in one connection and return what was on them",
		flags: [
			{ key: "count", name: "--count <n>", description: "Works to collect (default 10)", type: "number" },
			{
				key: "steps",
				name: "--steps <n>",
				description: "Most slides to move through (default 3x count)",
				type: "number",
			},
		],
		effect: "navigation",
		guidance:
			"Read-only: it moves the feed and reads identity, and never likes, comments or follows. Live and unreadable slides are counted in skipped, not silently dropped, so works.length below count says what the feed actually served.",
	},
	{
		id: "feed.previous",
		description: "Move to the previous video and verify that its ID changed",
		effect: "navigation",
	},
	{
		id: "search",
		description: "Search Douyin and return loaded video results",
		argument: { key: "query", name: "query", description: "Search keywords" },
		flags: [
			...paging,
			{ key: "sort", name: "--sort <order>", description: "relevance, newest or likes", type: "string" },
			{ key: "published", name: "--published <range>", description: "any, day, week or half-year", type: "string" },
		],
		effect: "navigation",
		guidance:
			"Filter controls are checked on the page; selected controls do not prove that returned results have refreshed for those filters. Scrolling stops if the page no longer exposes a verifiable filter state.",
		examples: ['dy search "旅行" --limit 10 --scrolls 1'],
	},
	{
		id: "user.search",
		description: "Search Douyin users and return stable profile IDs",
		argument: { key: "query", name: "query", description: "Search keywords" },
		flags: paging,
		effect: "navigation",
		guidance:
			"Opens the user-result route and falls back to the 用户 tab, verifying the URL before reading. Rows are de-duplicated by sec_uid; the signed-in profile is excluded. Treat names as display text and use sec_uid for follow-up calls. The result card container is not reliably identifiable on current pages, so rows are built from profile links.",
		examples: ['dy user search "旅行" --limit 10'],
	},
	{
		id: "link.resolve",
		description: "Resolve a Douyin work link or share text to a canonical work ID",
		argument: { key: "resource", name: "link-or-text", description: "One HTTPS Douyin link or share text" },
		effect: "read",
		guidance:
			"Direct work URLs are resolved locally. Short links use bounded redirects without browser credentials; unsupported or expired links fail. Tracking parameters are omitted.",
	},
	{
		id: "video.open",
		description: "Open a public work by ID or canonical Douyin URL, video or image post",
		argument: {
			key: "resource",
			name: "id-or-url",
			description: "Work ID, https://www.douyin.com/video/<id> or /note/<id>",
		},
		effect: "navigation",
		guidance:
			"Douyin redirects an image post from /video/<id> to /note/<id>. Read the result to see which kind the page is.",
	},
	{
		id: "video.info",
		description: "Read current work identity: video playback state or image post slides",
		flags: [video],
		effect: "read",
		guidance:
			"page_kind is video, note or page. An image post returns note with slide count; slide.index stays null when the page does not expose it.",
	},
	{ id: "video.play", description: "Play the current video", flags: [video], effect: "navigation" },
	{ id: "video.pause", description: "Pause the current video", flags: [video], effect: "navigation" },
	{
		id: "video.seek",
		description: "Move playback to a position in seconds",
		flags: [
			video,
			{
				key: "position",
				name: "--at <seconds>",
				description: "Position to seek to, within the work's duration",
				type: "number",
				required: true,
			},
		],
		effect: "navigation",
		guidance:
			"Without this, every observation samples from the start and a long work is only ever seen at its opening. A position past the end is refused rather than clamped, so a caller that guessed a duration learns it was wrong. Seeking does not wait for the new frame to decode; read video info or observe afterwards to see what actually shows.",
	},
	{
		id: "note.capture",
		description: "Save one currently visible image from an image post",
		flags: [
			{ ...video, required: true },
			{
				key: "index",
				name: "--index <number>",
				description: "Image number in the current visible images, starting at 1",
				type: "number",
				default: 1,
			},
			{ key: "output", name: "--output <path>", description: "New PNG path", type: "string" },
		],
		effect: "local",
		guidance:
			"Use video info to inspect currently visible images. The index is not necessarily the post's slide number. Saves one decoded frame when canvas access is allowed; existing output is never overwritten.",
	},
	{
		id: "note.next",
		description: "Move to the next image post slide",
		flags: [{ ...video, required: true }],
		effect: "navigation",
		guidance: "Checks the work and current slide at the click; autoplay can make the result uncertain.",
	},
	{
		id: "note.previous",
		description: "Move to the previous image post slide",
		flags: [{ ...video, required: true }],
		effect: "navigation",
		guidance: "Checks the work and current slide at the click; autoplay can make the result uncertain.",
	},
	{
		id: "video.like",
		description: "Set the desired like state of the current video or image post",
		flags: [{ ...video, required: true }, value],
		effect: "account_write",
		guidance:
			"Read video info first. --value false removes the like; an already matching state does not click the button. Image posts use their own controls and never fall back to the video button.",
	},
	{
		id: "video.favorite",
		description: "Set the desired favorite state of the current video or image post",
		flags: [{ ...video, required: true }, value],
		effect: "account_write",
	},
	{
		id: "video.screenshot",
		description: "Save the current Douyin viewport as a PNG",
		flags: [{ key: "output", name: "--output <path>", description: "PNG output path", type: "string" }],
		effect: "local",
	},
	{
		id: "video.digest",
		description: "Gather what a work is about: identity, sampled positions and loaded comments",
		flags: [
			video,
			{
				key: "frames",
				name: "--frames <count>",
				description: "Positions to sample: 0 for none, 1, or 3 (default 3); 0 skips all seeking",
				type: "number",
				default: 3,
			},
			{ key: "limit", name: "--limit <count>", description: "Comments to read (default 8)", type: "number" },
			{ key: "output", name: "--output <directory>", description: "Frame output directory", type: "string" },
		],
		effect: "local",
		guidance:
			"A title states the form, not the point. Three positions inside a work carry the argument, and the comment section says who is watching and what they took from it. Sampling avoids the opening and the end, which are the least informative parts. Frames are viewport screenshots and are labelled as samples, never as a claim about the whole work. A work under 15 seconds is not sampled: it is its own summary. Use --frames 0 to skip seeking entirely.",
	},
	{
		id: "video.observe",
		description: "Sample frames and playback state from the current video",
		flags: [
			{
				key: "seconds",
				name: "--seconds <seconds>",
				description: "Sampling span in seconds",
				type: "number",
				default: 3,
			},
			{ key: "frames", name: "--frames <count>", description: "Number of PNG frames", type: "number", default: 3 },
			{ key: "output", name: "--output <directory>", description: "Frame output directory", type: "string" },
			{
				key: "position",
				name: "--at <seconds>",
				description: "Seek here before sampling, to look past the opening",
				type: "number",
			},
		],
		effect: "local",
		guidance:
			"Frames capture the viewport and may not contain the player. The playback summary classifies endpoint changes and deduplicates overlapping time ranges; it cannot prove uninterrupted viewing, visibility or comprehension. Existing output files are never overwritten.",
	},
	{
		id: "video.audio",
		description: "Save a short audio sample from the current video as WebM",
		flags: [
			{
				key: "seconds",
				name: "--seconds <seconds>",
				description: "Capture length, 1..60 seconds",
				type: "number",
				default: 8,
			},
			{ key: "output", name: "--output <path>", description: "WebM output path", type: "string" },
		],
		effect: "local",
		guidance:
			"Captures only a browser video audio track. Transcription belongs to the caller. Some videos expose no capturable audio track.",
	},
	{
		id: "comment.close",
		description: "Close the comment panel that covers the feed arrows",
		effect: "navigation",
		guidance:
			"comment list opens the panel and leaves it open. The panel covers the right edge of the player, so feed next fails with 'the feed did not move' until it is closed. Safe to run when nothing is open.",
	},
	{
		id: "comment.voice",
		description: "Measure how this section writes, so a draft can sound local",
		flags: [
			video,
			{ key: "limit", name: "--limit <count>", description: "Comments to read (default 20)", type: "number" },
			{
				key: "write",
				name: "--save",
				description: "Store this profile as an insight memory for later sections",
				type: "boolean",
			},
			{
				key: "known",
				name: "--known",
				description: "Report what saved sections looked like, without reading the page",
				type: "boolean",
			},
		],
		effect: "navigation",
		guidance:
			"Returns length, exclamation habit, repeated openers, direct address, first person and questions, each with the count behind it, plus guidance lines. Measured per work: two sections read minutes apart had a median length of 11 and 28 characters, so one global style would be wrong for both. --save keeps the measurement so later sections can be compared against it; comment voice with no work reports what has been saved.",
	},
	{
		id: "comment.phrases",
		description: "Which learned phrases are available to say, and which have been used enough",
		flags: [
			{
				key: "text",
				name: "--use <phrase>",
				description: "Record that this phrase was said, so the ledger can tell fresh from spent",
				type: "string",
			},
		],
		effect: "local",
		guidance:
			"A phrase earns its place by being used once and then resting. Three uses without two weeks of silence marks it spent, and spent phrases are reported rather than hidden — a caller that cannot see them keeps reaching for the same line. Without --use this only reports.",
	},
	{
		id: "comment.list",
		description: "Read loaded public comments with stable IDs",
		flags: [video, ...paging],
		effect: "navigation",
		guidance:
			"scope=loaded_dom and complete=false indicate that this is a bounded page view, not the full comment history.",
	},
	{
		id: "comment.replies",
		description: "Expand and read loaded replies to one comment",
		flags: [
			{ ...video, required: true },
			{
				key: "comment_id",
				name: "--comment-id <id>",
				description: "Exact parent ID from comment list",
				type: "string",
				required: true,
			},
			{
				key: "steps",
				name: "--steps <count>",
				description: "Maximum expansion clicks, 1..10",
				type: "number",
				default: 1,
			},
			{ key: "limit", name: "--limit <count>", description: "Maximum replies returned", type: "number", default: 20 },
		],
		effect: "navigation",
		guidance:
			"Expands only the requested loaded parent. Returned replies are a bounded DOM view, not a complete thread; ambiguous controls stop the operation.",
	},
	{
		id: "comment.delete",
		description: "Delete one of this account's own comments",
		flags: [
			{ ...video, required: true },
			{
				key: "comment_id",
				name: "--comment-id <id>",
				description: "Exact ID of a comment this account wrote",
				type: "string",
				required: true,
			},
			{
				key: "confirm",
				name: "--confirm",
				description: "Acknowledge that deleting cannot be undone",
				type: "boolean",
				default: false,
			},
		],
		effect: "account_write",
		guidance:
			"Deletes one comment and cannot be undone: the page asks for no confirmation, so this command is the only check there is. It refuses unless the loaded row carries this account's own identity, so a display name or a nearby ID cannot be used to delete someone else's. The row must already be visible in the loaded list; a comment further down is not hunted for, because acting on an id the page did not show is how the wrong row gets deleted. Requires --request-id, and the response reports whether the row is gone afterwards.",
	},
	{
		id: "comment.image",
		description: "Post one local image as a top-level comment",
		flags: [
			{ ...video, required: true },
			{
				key: "image",
				name: "--image <path>",
				description: "PNG or JPEG file up to 10 MB",
				type: "string",
				required: true,
			},
		],
		effect: "account_write",
		guidance:
			"Requires --request-id. Verifies the work, empty composer and preview bytes before posting. Avoid editing the same composer during the operation. Delivery remains uncertain until independently verified; never automatically resend.",
	},
	{
		id: "comment.post",
		description: "Post exact text on the current video",
		flags: [{ ...video, required: true }, text, textFile, sticker, goal],
		effect: "account_write",
		guidance:
			"Requires text or text-file and --request-id. Loaded comments cannot prove a new delivery, so a dispatched post returns delivery_uncertain; inspect the receipt and page without resending. A dry run does not open Chrome.",
		examples: ['dy comment post --video-id 123456 --text "你好" --request-id comment-123456-01 --dry-run'],
	},
	{
		id: "comment.reply",
		description: "Reply to a comment whose exact ID is currently loaded",
		flags: [
			{ ...video, required: true },
			{
				key: "comment_id",
				name: "--comment-id <id>",
				description: "Exact ID from comment list",
				type: "string",
				required: true,
			},
			text,
			textFile,
			goal,
		],
		effect: "account_write",
		guidance:
			"Stops if the page does not expose a stable binding between the reply composer and the comment ID. A dispatched reply returns delivery_uncertain until delivery can be verified; inspect the receipt and page without resending. Requires --request-id.",
	},
	{
		id: "user.get",
		description: "Open a user profile and read its visible metadata and video links",
		argument: { key: "resource", name: "id-or-url", description: "User sec_uid or canonical profile URL" },
		effect: "navigation",
	},
	{
		id: "user.followers",
		description: "List the accounts following a user profile, or your own",
		flags: [
			{
				key: "user_id",
				name: "--user-id <id>",
				description: "Profile ID, or self for the signed-in account",
				type: "string",
				default: "self",
			},
			{ key: "limit", name: "--limit <count>", description: "Maximum returned accounts", type: "number", default: 50 },
			{
				key: "scrolls",
				name: "--scrolls <count>",
				description: "Additional list scrolls to load more",
				type: "number",
				default: 0,
			},
		],
		effect: "navigation",
		guidance:
			"Reads the follower list the platform loads into a modal. A follower is not a mutual follow: compare with user following to find one. The list loads lazily and may stop short of the real total.",
	},
	{
		id: "user.following",
		description: "List the accounts a user profile follows, or the ones you follow",
		flags: [
			{
				key: "user_id",
				name: "--user-id <id>",
				description: "Profile ID, or self for the signed-in account",
				type: "string",
				default: "self",
			},
			{ key: "limit", name: "--limit <count>", description: "Maximum returned accounts", type: "number", default: 50 },
			{
				key: "scrolls",
				name: "--scrolls <count>",
				description: "Additional list scrolls to load more",
				type: "number",
				default: 0,
			},
		],
		effect: "navigation",
		guidance: "Reads the following list the platform loads into a modal. See user followers for the other direction.",
	},
	{
		id: "user.follow",
		description: "Set the desired follow state of the current user profile",
		flags: [
			{ key: "user_id", name: "--user-id <id>", description: "Exact profile sec_uid", type: "string", required: true },
			value,
		],
		effect: "account_write",
		guidance:
			"Open the profile with user get first. If Douyin requires a separate confirmation dialog, the unconfirmed result is reported for inspection.",
	},
	{
		id: "chat.list",
		description: "Open private chat and list loaded conversation metadata",
		effect: "navigation",
		guidance:
			"Use stable id values for reads and sends. A null id cannot be used as a send target; display names are not identifiers.",
	},
	{
		id: "diagnostics-ack",
		description: "Record that a repeated failure was fixed, with the time of the fix",
		argument: { key: "resource", name: "command", description: "Command that was fixed" },
		flags: [
			{
				key: "error_code",
				name: "--error-code <code>",
				description: "Only this code, if the fix was specific",
				type: "string",
			},
			{ key: "note", name: "--note <text>", description: "What the fix was", type: "string" },
		],
		effect: "local",
		guidance:
			"Failures before this moment become history and stop heading the list; the events themselves are never deleted. A failure that happens after the mark brings the command back as a lead, so an acknowledgement cannot hide a regression.",
	},
	{
		id: "diagnostics",
		description: "Group this bot's recorded failures into repeated trouble worth fixing",
		flags: [
			{ key: "since", name: "--since <date>", description: "Only failures at or after this date", type: "string" },
			{ key: "limit", name: "--limit <count>", description: "Maximum candidates", type: "number", default: 20 },
		],
		effect: "local",
		guidance:
			"Reads only local events; no browser and no writes. A repeated failure is a lead, not a diagnosis: reproduce it on the real page before changing code, and keep unproven workarounds out of the CLI. A command that got slower without failing is reported too.",
	},
	{
		id: "chat.close",
		description: "Close the private chat panel without discarding a draft",
		effect: "navigation",
		guidance:
			"Private chat covers the work underneath it, so video, comment and feed reads fail while it is open. Closing is refused when the composer holds a draft; clear it first or leave it open.",
	},
	{
		id: "social.goal",
		description: "Ask what kind of people to look for, and record the answer",
		flags: [
			{ key: "text", name: "--text <text>", description: "What kind of relationship to build", type: "string" },
			{ key: "topic", name: "--topic <list>", description: "Comma-separated topics to look for", type: "string" },
			{
				key: "goal_preset",
				name: "--goal-preset <name>",
				description: "Stage vocabulary: friend or lead",
				type: "string",
			},
			{
				key: "stages",
				name: "--stages <list>",
				description: "Your own stage names, comma separated, in order",
				type: "string",
			},
			{
				key: "daily_limit",
				name: "--daily-limit <count>",
				description: "People this goal may newly reach per day",
				type: "number",
			},
		],
		effect: "local",
		guidance:
			"Run with no flags to get the question to put to the owner. The owner may not answer, and that is not a blocker: discovery falls back to what this account already keeps talking about, read from its own record. A goal is a preference, not a prerequisite. --preset friend suits meeting people; --preset lead names a funnel whose last stages are outcomes. --stages overrides both. Evidence alone never carries a card past the second stage: what was sent can show contact, not a result.",
	},
	{
		id: "social.goalpause",
		description: "Stop using one goal without deleting it",
		argument: { key: "resource", name: "id", description: "Goal ID" },
		effect: "local",
	},
	{
		id: "social.signal",
		description: "Find what people explicitly asked for, in text already read",
		flags: [
			{
				key: "sources",
				name: "--sources <file>",
				description: "JSON array of {person, name, where, source, text}",
				type: "string",
			},
			{ key: "limit", name: "--limit <count>", description: "Maximum people", type: "number", default: 50 },
		],
		effect: "local",
		guidance:
			"Reads text the caller supplied and quotes explicit requests: asking for a recommendation, a contact or a price, stating an intention, or comparing options. Those three are reported separately, because comparing is not asking. Negative statements are excluded rather than scored. This does not read the platform and does not crawl.",
	},
	{
		id: "social.discover",
		description: "Turn what was read into candidates worth meeting, with reasons",
		flags: [
			{ key: "sources", name: "--sources <file>", description: "JSON array of people the caller read", type: "string" },
			{
				key: "goal",
				name: "--goal <id>",
				description: "Judge against one goal instead of the first active one",
				type: "string",
			},
			{ key: "limit", name: "--limit <count>", description: "Maximum candidates", type: "number", default: 20 },
		],
		effect: "local",
		guidance:
			"Each source needs person, name, where, source and context. Candidates exclude people already on a relationship card, and each one carries the evidence behind it plus what that evidence does not prove. This command does not crawl: it judges what the caller already read.",
	},
	{
		id: "social.response",
		description: "Read whether anything came back after this account wrote",
		flags: [
			{
				key: "conversation_id",
				name: "--conversation-id <id>",
				description: "Stable ID from chat list",
				type: "string",
				required: true,
			},
			{
				key: "limit",
				name: "--limit <count>",
				description: "Messages to consider, 1..50",
				type: "number",
				default: 30,
			},
		],
		effect: "read",
		guidance:
			"The one part of the social loop that is a fact rather than a judgement: either an incoming message follows one of this account's messages or it does not. Reports how many were answered, which are still hanging with how long they have waited, the median reply delay, and whether the loaded window is only outgoing. It does not read what a reply said and does not decide whether the relationship moved — social stage still refuses to infer that. 'Unanswered' means nothing loaded after it, not that nobody ever replied.",
	},
	{
		id: "social.stage",
		description: "Record where a relationship stands, and what you want from it",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [
			{
				key: "stage",
				name: "--stage <stage>",
				description: "One stage from the card's goal vocabulary",
				type: "string",
				required: true,
			},
			{ key: "note", name: "--note <text>", description: "What you want from this relationship", type: "string" },
		],
		effect: "local",
		guidance:
			"A stage you do not set is inferred from what was sent, and never goes beyond talking: becoming connected needs you to say so. The card is derived from this installation's own event log.",
	},
	{
		id: "social.relation",
		description: "Read one relationship card with its recent interactions",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [
			{
				key: "limit",
				name: "--limit <count>",
				description: "Recent interactions to include",
				type: "number",
				default: 10,
			},
		],
		effect: "read",
	},
	{
		id: "social.list",
		description: "List relationship cards, most recently active first",
		flags: [{ key: "limit", name: "--limit <count>", description: "Maximum cards", type: "number", default: 50 }],
		effect: "read",
	},
	{
		id: "social.followup",
		description: "Note something to bring up with someone, and when",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [
			{ key: "topic", name: "--topic <text>", description: "What to follow up on", type: "string", required: true },
			{
				key: "due",
				name: "--due <date>",
				description: "When it becomes due, ISO date",
				type: "string",
				required: true,
			},
		],
		effect: "local",
	},
	{
		id: "social.forget",
		description: "Set a person aside without inventing a stage for it",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [{ key: "reason", name: "--reason <text>", description: "Why this person is set aside", type: "string" }],
		effect: "local",
		guidance:
			"The card stays readable and its history is kept; it stops being owed follow-ups and stops being offered as someone to meet. This is not a stage: the reason for leaving is not where the relationship stands.",
	},
	{
		id: "social.outcome",
		description: "Record what came of a contact, and under which goal",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [
			{
				key: "outcome",
				name: "--outcome <name>",
				description: "won, lost, dropped or pending",
				type: "string",
				required: true,
			},
			{ key: "note", name: "--note <text>", description: "Why it ended that way", type: "string" },
			goal,
			{
				key: "signal_source",
				name: "--signal <id>",
				description: "Event ID of the signal this contact came from",
				type: "string",
			},
		],
		effect: "local",
		guidance:
			"An outcome is the owner's or caller's conclusion; the CLI never infers one from a reply. The card's goal is used, not one supplied here, so a result cannot be filed under the wrong goal. One person may have results under different goals.",
	},
	{
		id: "social.outcomes",
		description: "Per goal: people reached, people who progressed, people concluded",
		effect: "read",
		guidance:
			"Progressed means someone other than the agent's own sending moved the card. Open is kept apart from concluded, because an unfinished lead is not a failure.",
	},
	{
		id: "social.done",
		description: "Close one recorded follow-up",
		argument: { key: "resource", name: "person", description: "Stable person ID" },
		flags: [
			{
				key: "at",
				name: "--at <timestamp>",
				description: "The follow-up's recorded time",
				type: "string",
				required: true,
			},
		],
		effect: "local",
	},
	{
		id: "social.log",
		description: "What this agent looked at, did and proposed, newest first",
		flags: [
			{ key: "since", name: "--since <timestamp>", description: "Only events after this RFC3339 time", type: "string" },
			{ key: "limit", name: "--limit <count>", description: "Maximum entries", type: "number", default: 50 },
		],
		effect: "read",
		guidance:
			"Answers what the agent has been up to and what it is waiting on you for. Everything here comes from this installation's own record, not the platform. Looking is listed separately from acting, because only acting changes anything for another person.",
	},
	{
		id: "social.pause",
		description: "Stop acting while still allowed to look",
		flags: [{ key: "reason", name: "--reason <text>", description: "Why the pause was requested", type: "string" }],
		effect: "local",
		guidance: "One switch, not a policy engine: paused means no outward action, and reads are unaffected.",
	},
	{
		id: "social.resume",
		description: "Allow the agent to act again",
		effect: "local",
	},
	{
		id: "social.due",
		description: "Who deserves a message today, and why",
		effect: "read",
		guidance:
			"Reports follow-ups that have come due and relationships quiet long enough for a natural next message. A suggestion, not a queue: sending still goes through the ordinary write command.",
	},
	{
		id: "chat.read",
		description: "Read one conversation by its stable ID",
		flags: [
			conversation,
			{
				key: "limit",
				name: "--limit <count>",
				description: "Maximum previous observation windows, 1..50",
				type: "number",
				default: 20,
			},
			{
				key: "budget",
				name: "--budget <characters>",
				description: "Maximum history text characters, 500..20000",
				type: "number",
				default: 6000,
			},
			{
				key: "scrolls",
				name: "--scrolls <count>",
				description: "Walk this many pages back through the conversation first, 0..20",
				type: "number",
				default: 0,
			},
			{
				key: "pixels",
				name: "--pixels <px>",
				description: "Pixels per scroll step, 200..4000",
				type: "number",
				default: 1200,
			},
		],
		effect: "navigation",
		guidance:
			"Reads the current page window and returns prior local bot-attributed observations separately. Neither proves complete history. The list is virtualised: older rows exist only after --scrolls walks it back, and the response reports how many pages it walked and whether it reached the top. Media URLs are withheld because they may contain credentials.",
	},
	{
		id: "chat.history",
		description: "Read previously observed local conversation context for this bot",
		flags: [
			conversation,
			{
				key: "limit",
				name: "--limit <count>",
				description: "Maximum observation windows per page, 1..50",
				type: "number",
				default: 20,
			},
			{
				key: "budget",
				name: "--budget <characters>",
				description: "Maximum text characters, 500..20000",
				type: "number",
				default: 6000,
			},
			{ key: "offset", name: "--offset <count>", description: "Older observation offset", type: "number", default: 0 },
			expected,
		],
		effect: "read",
		guidance:
			"Reads only this installation's own observations; no browser or send. Missing IDs remain separate observations. Continue with next_offset and --if-match <revision>.",
	},
	{
		id: "chat.capture",
		description: "Save a decoded image from a loaded chat message",
		flags: [
			conversation,
			{
				key: "message_id",
				name: "--message-id <id>",
				description: "Stable loaded message ID",
				type: "string",
				required: true,
			},
			{
				key: "index",
				name: "--index <number>",
				description: "Image number within the message, starting at 1",
				type: "number",
				default: 1,
			},
			{ key: "output", name: "--output <path>", description: "New PNG path", type: "string" },
		],
		effect: "local",
		guidance:
			"Saves a loaded image as PNG without exposing its source URL. Animation captures one frame. The source must permit canvas access; otherwise extraction fails. Existing output is never overwritten.",
	},
	{
		id: "chat.changes",
		description: "Compare the last two locally saved views of one conversation",
		flags: [conversation],
		effect: "read",
		guidance:
			"Run chat read twice first. Window differences do not prove new messages, deletion or read status. Rows without stable IDs cannot be compared.",
	},
	{
		id: "chat.image",
		description: "Send one local image to a stable conversation",
		flags: [
			conversation,
			{
				key: "image",
				name: "--image <path>",
				description: "PNG, JPEG or GIF file up to 10 MB",
				type: "string",
				required: true,
			},
		],
		effect: "account_write",
		guidance:
			"Requires --request-id. Checks the file, conversation, preview bytes and recipient identity before confirming. Avoid editing the same composer during the operation. A dispatched image returns delivery_uncertain; inspect the receipt and do not automatically resend.",
	},
	{
		id: "chat.send",
		description: "Send exact text to one conversation",
		flags: [
			conversation,
			text,
			textFile,
			goal,
			{
				key: "reply_to",
				name: "--reply-to <message-id>",
				description: "Require this loaded incoming message as a reply anchor",
				type: "string",
			},
			{
				key: "mention",
				name: "--mention <display-name>",
				description: "Select this group member from the @ picker before sending",
				type: "string",
			},
			sticker,
		],
		effect: "account_write",
		guidance:
			"Requires --request-id. Stops on identity or draft conflicts. --mention picks one exact name from the group @ picker; an ambiguous or missing name fails instead of mentioning the wrong member. --emoji sends one sticker from the composer's smiley, on its own: combining it with --text is refused because the platform sends a sticker the moment it is clicked. The latest end of a loaded conversation is not yet verifiable, so dispatched messages return delivery_uncertain; inspect the receipt and conversation and do not automatically resend.",
	},
	{
		id: "chat.voice",
		description: "Ask the page to transcribe voice messages and return the text",
		flags: [
			conversation,
			{
				key: "index",
				name: "--index <n>",
				description: "Which loaded voice row to transcribe, 1-based; omit for all",
				type: "number",
			},
			{
				key: "scrolls",
				name: "--scrolls <count>",
				description: "Walk this many pages back first to load older voice rows, 0..20",
				type: "number",
				default: 0,
			},
		],
		effect: "navigation",
		guidance:
			"Uses the platform's own 转文字 from the message context menu rather than downloading audio and running recognition here: the platform already has a transcript model, and a copy of the audio would leave this machine. Returns one entry per loaded voice row with its transcript, duration and whether a source is available. A row with no transcript after the platform has run is reported as null rather than guessed at.",
	},
	{
		id: "chat.reply",
		description: "Quote one loaded conversation message and reply inside the same conversation",
		flags: [
			conversation,
			text,
			textFile,
			{
				key: "message_index",
				name: "--message-index <index>",
				description: "1-based position in the loaded message window returned by chat read",
				type: "number",
				required: true,
			},
		],
		effect: "account_write",
		guidance:
			"Quotes through the page's own reply control, which is what makes the platform show 回复消息 above the input. Requires --request-id. Use an index from chat read in this same conversation; a group message carries no stable id, so the loaded window is the only anchor. A dispatched reply returns delivery_uncertain; inspect the receipt and do not automatically resend.",
	},
	{
		id: "chat.share",
		description: "Send a canonical public video link to one conversation",
		flags: [conversation, { ...video, required: true }],
		effect: "account_write",
		guidance: "Sends a text URL, not a native video card. Requires --request-id.",
	},
	{
		id: "chat.forward",
		description: "Forward the current work as a native share card to one recipient",
		flags: [
			{
				key: "recipient_id",
				name: "--recipient-id <id>",
				description: "secuid:<value> from chat list, or the panel's numeric user ID",
				type: "string",
				required: true,
			},
			{ ...video, required: true },
		],
		effect: "account_write",
		guidance:
			"Opens the current work's share panel and re-verifies the recipient before clicking. Panel or row changes do not prove delivery. Native-card delivery cannot currently be verified, so a dispatched share returns delivery_uncertain; inspect the receipt and conversation without automatically retrying. Requires --request-id.",
		examples: [
			"dy chat forward --recipient-id secuid:MS4wLjABAAAA... --video-id 456 --request-id forward-456-01 --dry-run",
		],
	},
	{
		id: "forward.list",
		description: "List recipients the share panel currently offers for the current work",
		flags: [{ ...video, required: true }],
		effect: "navigation",
		guidance:
			"Use this to learn a recipient's ID when chat list has no matching conversation. The panel is hover-revealed and its list scrolls; only laid-out rows are reported.",
	},
	{
		id: "page.scroll",
		description: "Scroll the page or public comment container",
		flags: [
			{ key: "target", name: "--target <target>", description: "page or comments", type: "string", default: "page" },
			{ key: "pixels", name: "--pixels <pixels>", description: "Signed scroll distance", type: "number", default: 900 },
			video,
		],
		effect: "navigation",
		guidance: "An image post scrolls its own layout container rather than the document.",
	},
	{
		id: "history.list",
		description: "Read local operation facts for export or agent summaries",
		flags: [
			{
				key: "since",
				name: "--since <timestamp>",
				description: "RFC3339 timestamp, including timezone",
				type: "string",
			},
			{
				key: "limit",
				name: "--limit <count>",
				description: "Maximum records, newest records selected",
				type: "number",
				default: 100,
			},
		],
		effect: "read",
	},
	{
		id: "share.history",
		description: "Inspect locally recorded share attempts and delivery state",
		flags: [
			video,
			{ key: "recipient_id", name: "--recipient-id <id>", description: "Exact recipient ID", type: "string" },
			{ key: "conversation_id", name: "--conversation-id <id>", description: "Exact conversation ID", type: "string" },
			{ key: "since", name: "--since <timestamp>", description: "RFC3339 timestamp", type: "string" },
			{ key: "limit", name: "--limit <count>", description: "Maximum records", type: "number", default: 20 },
		],
		guidance:
			"Reads local receipts. Dispatching means delivery is uncertain, not confirmed. Older receipts may have unknown targets; this is not a complete platform share history.",
		effect: "read",
	},
	{
		id: "receipt.get",
		description: "Inspect a persisted write receipt",
		argument: { key: "request_id", name: "request-id", description: "The request ID used by the write" },
		guidance:
			"Reads one persisted receipt by its request ID. An uncertain receipt is evidence the write may have happened, not that it did.",
		effect: "read",
	},
];

export const GLOBAL_FLAGS = [
	{ name: "--state-dir <path>", description: "Override local state directory (or DY_STATE_DIR)" },
	{ name: "--chrome <path>", description: "Override Chrome executable (or DY_CHROME_PATH)" },
	{ name: "--format <format>", description: "json or pretty", default: "json" },
	{ name: "--timeout <seconds>", description: "Per-command timeout in seconds", default: 45 },
	{ name: "--request-id <id>", description: "Idempotency key for sends and comments" },
	{ name: "--dry-run", description: "Validate input and show the plan without side effects" },
	{
		name: "--progress",
		description: "Emit one JSON progress line per step to stderr while a write runs",
	},
];

export function schema(id?: string) {
	const selected = id ? COMMANDS.filter((command) => command.id === id.trim().replaceAll(" ", ".")) : COMMANDS;
	return {
		schema_version: 1,
		commands: selected,
		global_flags: GLOBAL_FLAGS,
		output: {
			success: { stream: "stdout", shape: '{"ok":true,"data":...}' },
			failure: {
				stream: "stderr",
				shape: '{"ok":false,"error":{"type":...,"code":...,"message":...,"retryable":false}}',
			},
		},
		exit_codes: {
			0: "success",
			1: "internal",
			2: "validation",
			3: "authentication or verification",
			4: "browser or timeout",
			5: "state or selector",
			6: "uncertain delivery or key conflict",
			130: "cancelled",
		},
	};
}
