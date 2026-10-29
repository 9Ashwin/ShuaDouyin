import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import { profileVoice, type VoiceProfile } from "../voice.ts";
import type { Workspaces } from "../workspace.ts";
import { GROWTH_SECTION, PRESETS, RETIRED_FIXED_LINE } from "../workspace.ts";

// A persona that is read from a file and never changes is a costume, not a
// personality: it stays exactly as it was the day the workspace was created
// while everything it sees moves on. This makes the persona its own history —
// the section that describes how it writes is derived from what it actually
// wrote, and it is rewritten when that changes.
//
// What the tool may decide is bounded on purpose. Everything measured here comes
// from the account's own sent comments, so it is evidence rather than invention.
// The one thing it will not do is add a claim about who the bot is: a persona
// line that says "喜欢看老电影" cannot be measured from comment lengths, and a
// persona that invents itself is worse than one that stays still.

export interface PersonaEvolution {
	// True when the persona section actually changed.
	changed: boolean;
	// What was measured, and from how many comments.
	samples: number;
	profile: VoiceProfile;
	// The rule that was applied, readable by the caller.
	derived: string[];
	// The version the replaced state was kept as, so a caller can roll back to it.
	snapshot: number | null;
	// The section before and after; null before means the section did not exist.
	before: string | null;
	after: string;
	// A content hash of the new section, so two runs can be compared.
	revision: string;
}

// The persona section this command owns. Everything between this heading and the
// next one is derived; the rest of the file belongs to the owner and is never
// touched. Naming the section explicitly is what keeps an automatic rewrite from
// being an automatic rewrite of the whole persona.
export const SECTION = "## 长出来的声音";

const MAX_SAMPLES = 40;
// Below this, a section would describe one comment rather than a voice.
const MIN_SAMPLES = 5;
// The shortest span that can distinguish a voice from a mood.
const MIN_SPAN_DAYS = 2;

// One line per measurement, so a reader can check the rule against the number
// rather than take the sentence on trust.
export function deriveVoice(profile: VoiceProfile): string[] {
	const lines: string[] = [];
	const median = profile.length.median;
	// A comment section's own median decides what "short" means; this is the
	// account's own history, so it is a description, not a target.
	if (median > 0) {
		const shape = median <= 12 ? "一两句就收" : median <= 30 ? "说完整一句，不铺陈" : "会写满一段再说";
		lines.push(`${shape}（自己发的评论中位数 ${median} 字，${profile.samples} 条样本）`);
	}
	if (profile.exclamation.samples === 0) lines.push("不用感叹号（样本里一次都没有）");
	else if (profile.exclamation.repeated > profile.exclamation.samples / 2)
		lines.push(`习惯连用感叹号（${profile.exclamation.repeated}/${profile.exclamation.samples} 条出现两次以上）`);
	else lines.push(`感叹号用得克制（${profile.exclamation.samples}/${profile.samples} 条用过）`);
	if (profile.uses_emoji === 0) lines.push("不发表情（样本里没有）");
	else if (profile.uses_emoji * 2 > profile.samples)
		lines.push(`经常带表情（${profile.uses_emoji}/${profile.samples} 条）`);
	if (profile.questions * 2 > profile.samples) lines.push(`爱用问句接话（${profile.questions}/${profile.samples} 条）`);
	if (profile.addresses_author * 2 > profile.samples)
		lines.push(`会直接称呼对方（${profile.addresses_author}/${profile.samples} 条）`);
	if (profile.first_person === 0) lines.push("很少说自己，把话落在内容上（样本里没有第一人称）");
	// The openers that repeat are the closest thing to a signature, and they are
	// also the thing that makes a bot read as a bot when it leans on them. They
	// are named so the persona can avoid depending on them.
	const openers = profile.openers.slice(0, 3).map((entry) => `${entry.text}（${entry.count} 次）`);
	if (openers.length) lines.push(`惯用开头 ${openers.join("、")}，换着用，别条条一样`);
	return lines;
}

function sectionOf(content: string): { before: string | null; start: number; end: number } | null {
	const start = content.indexOf(`${SECTION}\n`);
	if (start < 0) return null;
	const next = content.indexOf("\n## ", start + SECTION.length);
	const end = next < 0 ? content.length : next;
	return { before: content.slice(start, end), start, end };
}

// Replace only the derived section. The owner's text above and below it is
// carried through byte for byte, which is what makes this safe to run on a
// persona someone has edited by hand.
export function applySection(content: string, body: string): { content: string; before: string | null } {
	const section = `${SECTION}\n\n${body}\n`;
	const found = sectionOf(content);
	if (!found) {
		// A document that ends without a trailing newline would run the new heading
		// into its last paragraph.
		const separated = content.endsWith("\n") ? content : `${content}\n`;
		return { content: `${separated}\n${section}`, before: null };
	}
	return { content: `${content.slice(0, found.start)}${section}${content.slice(found.end)}`, before: found.before };
}

export async function evolvePersona(
	workspaces: Workspaces,
	store: { events: () => Promise<unknown[]> },
	options: { write?: boolean } = {},
): Promise<PersonaEvolution> {
	const written = writtenComments(await store.events());
	const sent = written.map((comment) => comment.text);
	// One comment is an incident, not a habit. Writing a persona section from a
	// single sentence would turn whatever that one comment happened to look like
	// into a rule, and the section would then describe the account to itself
	// wrongly — which is worse than having no derived section at all.
	if (sent.length < MIN_SAMPLES)
		throw new CliError("not_found", "Not enough of this account's own writing to learn a voice from", {
			hint: `${sent.length} of ${MIN_SAMPLES} comments so far. The section is derived from what was actually written, so it waits for enough of it.`,
			details: { samples: sent.length, required: MIN_SAMPLES },
		});
	const samples = sent.slice(-MAX_SAMPLES).map((text) => ({ text }));
	// Enough comments is not the same as enough time. Five comments written in one
	// sitting describe one mood, and rewriting the persona after every round would
	// make it swing with whatever the account happened to feel that hour — which is
	// drift, not growth. A voice is what survives across days, so the section waits
	// for writing that spans more than one.
	const span = spanOf(written);
	if (span !== null && span < MIN_SPAN_DAYS)
		throw new CliError("not_found", "This writing all comes from the same session", {
			hint: `${sent.length} comments spanning ${span} day(s). A voice is what stays the same across days; ${MIN_SPAN_DAYS} days is the shortest span that can show it.`,
			details: { samples: sent.length, span_days: span, required_days: MIN_SPAN_DAYS },
		});
	const profile = profileVoice(samples);
	const derived = deriveVoice(profile);
	// A run with nothing to say must not blank the section: an unchanged rule set
	// means the persona keeps what it already had.
	if (!derived.length)
		throw new CliError("not_found", "The writing so far is too uniform to describe", {
			hint: "There is not enough variation in length, punctuation or address to write a section from.",
		});
	const document = await workspaces.document("AGENTS.md");
	const body = derived.map((line) => `- ${line}`).join("\n");
	const applied = applySection(document.content, body);
	const revision = createHash("sha256").update(body).digest("hex");
	if (applied.before?.includes(body)) {
		return {
			changed: false,
			snapshot: null,
			samples: profile.samples,
			profile,
			derived,
			before: applied.before,
			after: applied.before,
			revision,
		};
	}
	// The state being replaced is kept before it is replaced. Without this a
	// persona that drifts somewhere worse has no way back, and "it evolves" would
	// mean "it only ever moves forward".
	let snapshot: number | null = null;
	if (options.write !== false) {
		snapshot = await workspaces.snapshot("AGENTS.md", document.content);
		await workspaces.setDocument("AGENTS.md", applied.content, document.revision);
	}
	return {
		changed: true,
		snapshot,
		samples: profile.samples,
		profile,
		derived,
		before: applied.before,
		after: `${SECTION}\n\n${body}\n`,
		revision,
	};
}

// The account's own words, from the same event log the rest of the tool audits
// against. A comment that was never confirmed is not evidence of how this account
// writes, so only operation events carrying text count.
export interface WrittenComment {
	text: string;
	at: string;
}

export function writtenComments(events: unknown[]): WrittenComment[] {
	const out: WrittenComment[] = [];
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const record = event as { operation?: unknown; data?: unknown; at?: unknown };
		if (record.operation !== "comment.post" && record.operation !== "comment.reply") continue;
		const data = record.data as { text?: unknown } | undefined;
		const text = typeof data?.text === "string" ? data.text.trim() : "";
		// The reply text lives under `text` on a saved write; a comment that was
		// only an image has none and would measure as an empty sample.
		if (!text) continue;
		out.push({ text, at: typeof record.at === "string" ? record.at : "" });
	}
	return out;
}

// The text alone, for callers that only measure what was written.
export function eventsAsComments(events: unknown[]): string[] {
	return writtenComments(events).map((comment) => comment.text);
}

// How many whole days the writing spans. A missing or unparseable timestamp is
// treated as no information rather than as day zero, so old events without one
// do not make a single session look like a long history.
function spanOf(comments: WrittenComment[]): number | null {
	const times = comments
		.map((comment) => Date.parse(comment.at))
		.filter((value) => Number.isFinite(value) && value > 0);
	if (times.length < 2) return null;
	return Math.floor((Math.max(...times) - Math.min(...times)) / 86_400_000);
}

// Read the persona without changing it, for a caller that only wants to know
// whether the section is current.
export async function personaSection(workspaces: Workspaces): Promise<string | null> {
	try {
		const document = await workspaces.document("AGENTS.md");
		return sectionOf(document.content)?.before ?? null;
	} catch (error) {
		if (error instanceof CliError && error.code === "not_found") return null;
		throw error;
	}
}

// The presets exist so a fresh workspace has a voice before it has any history.
// This names which preset the current section is still identical to, so a caller
// can tell "never evolved" from "evolved and unchanged".
export function presetOf(section: string | null): string | null {
	if (!section) return null;
	for (const [name, value] of Object.entries(PRESETS)) if (section.includes(value)) return name;
	return null;
}

export async function readPersonaFile(workspaces: Workspaces): Promise<string> {
	return readFile(join(workspaces.root(), "AGENTS.md"), "utf8");
}

export interface Migration {
	// True when the document was rewritten.
	changed: boolean;
	// Which retired line was found, if any.
	found: string | null;
	// Where the replacement section was placed: after 工作区, or at the end when
	// that heading is missing.
	placement: "after-workspace" | "appended" | null;
	before: string;
	after: string;
}

// Move a workspace created before the persona could grow onto the same words a
// new one starts with.
//
// The line this replaces said the opposite of what the file now says: "keep the
// owner's fixed settings, do not rewrite the persona". Leaving it in place means
// an agent reading the persona is told, in the same document, both to grow and
// never to change — and the older line wins, because it is concrete. Only the
// exact retired sentence is matched, so a persona whose owner already rewrote
// that line themselves is left untouched.
export function migratePersona(content: string): Migration {
	const unchanged: Migration = { changed: false, found: null, placement: null, before: content, after: content };
	if (!content.includes(RETIRED_FIXED_LINE)) return unchanged;
	// Someone who wrote their own replacement keeps it: the old line being gone is
	// the only thing this removes, and a section that already exists is not
	// duplicated.
	const stripped = content.replace(`${RETIRED_FIXED_LINE}\n`, "").replace(RETIRED_FIXED_LINE, "");
	if (stripped.includes("## 人格会生长")) {
		return { changed: true, found: RETIRED_FIXED_LINE, placement: null, before: content, after: stripped };
	}
	const section = `${GROWTH_SECTION.join("\n")}\n`;
	// The old line sat at the end of 工作区, so the replacement belongs there too.
	// Falling back to the end of the file keeps the order a reader expects when the
	// workspace section has been renamed or removed.
	const workspace = stripped.indexOf("\n## 工作区");
	const nextHeading = workspace >= 0 ? stripped.indexOf("\n## ", workspace + 1) : -1;
	if (nextHeading >= 0) {
		const before = stripped.slice(0, nextHeading).replace(/\n+$/, "\n");
		return {
			changed: true,
			found: RETIRED_FIXED_LINE,
			placement: "after-workspace",
			before: content,
			after: `${before}\n${section}${stripped.slice(nextHeading + 1)}`,
		};
	}
	const base = stripped.endsWith("\n") ? stripped : `${stripped}\n`;
	return {
		changed: true,
		found: RETIRED_FIXED_LINE,
		placement: "appended",
		before: content,
		after: `${base}\n${section}`,
	};
}

export async function migratePersonaDocument(
	workspaces: Workspaces,
	options: { write?: boolean } = {},
): Promise<Migration> {
	const document = await workspaces.document("AGENTS.md");
	const migrated = migratePersona(document.content);
	if (migrated.changed && options.write !== false)
		await workspaces.setDocument("AGENTS.md", migrated.after, document.revision);
	return migrated;
}
