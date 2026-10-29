import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.ts";
import { profileVoice, type VoiceProfile } from "../voice.ts";
import type { Workspaces } from "../workspace.ts";
import { PRESETS } from "../workspace.ts";

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
	const sent = eventsAsComments(await store.events());
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
			samples: profile.samples,
			profile,
			derived,
			before: applied.before,
			after: applied.before,
			revision,
		};
	}
	if (options.write !== false) await workspaces.setDocument("AGENTS.md", applied.content, document.revision);
	return {
		changed: true,
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
export function eventsAsComments(events: unknown[]): string[] {
	const out: string[] = [];
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const record = event as { operation?: unknown; data?: unknown; bot_id?: unknown };
		if (record.operation !== "comment.post" && record.operation !== "comment.reply") continue;
		const data = record.data as { text?: unknown } | undefined;
		const text = typeof data?.text === "string" ? data.text.trim() : "";
		// The reply text lives under `text` on a saved write; a comment that was
		// only an image has none and would measure as an empty sample.
		if (text) out.push(text);
	}
	return out;
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
