// The parts of a bot's persona that a caller needs before it speaks.
//
// `context show` returns the whole workspace within a character budget, and it
// truncates from the front. That is right for memories and wrong for a persona:
// the identity and voice sections sit after the role introduction, so a budget
// that runs out quietly removes the thing the agent is supposed to sound like —
// and nothing in the output says the voice was cut off.
//
// This projects by section instead. Known headings are extracted deterministically
// into named parts, each part says whether it arrived whole, and a document that
// does not match the expected shape is reported as needing interpretation rather
// than being turned into a default persona nobody asked for.

export type PartName = "identity" | "voice" | "conduct" | "growth" | "communication";

export interface PersonaPart {
	name: PartName;
	/** The section body, without its heading. */
	text: string;
	/** False when the part was cut to fit the remaining budget. */
	complete: boolean;
}

export interface PersonaSurface {
	bot: string;
	document: string;
	revision: string;
	source: string;
	/** The name, taken from the first heading line. */
	name: string;
	parts: PersonaPart[];
	/** Sections the template defines that this document does not have. */
	missing: PartName[];
	/** True when nothing could be extracted; `reason` says why. */
	needs_interpretation: boolean;
	reason: string | null;
	/** Whether every returned part is whole. */
	complete: boolean;
	characters: number;
	budget: number;
	limits: string[];
}

// The headings the template writes. A user may rename or rewrite a section, so a
// missing one is reported rather than filled in: inventing a default voice is
// how an agent ends up sounding like the tool instead of the bot.
const HEADINGS: { name: PartName; pattern: RegExp }[] = [
	// The template writes identity and voice as one section ("身份与声音"), so the
	// identity pattern accepts both spellings and a separate voice section is
	// optional rather than expected.
	{ name: "identity", pattern: /^##\s*(?:身份与声音|身份|Identity and voice)\s*$/m },
	{ name: "voice", pattern: /^##\s*(?:长出来的声音|声音|语气|Voice)\s*$/m },
	{ name: "conduct", pattern: /^##\s*(?:行为准则|原则|Conduct)\s*$/m },
	{ name: "growth", pattern: /^##\s*(?:人格会生长|成长|成长规则|Growth)\s*$/m },
	{ name: "communication", pattern: /^##\s*(?:沟通|说话方式|Communication)\s*$/m },
];

/** Split on `## ` headings, keeping each heading with the body that follows it. */
function sections(content: string): { heading: string; body: string }[] {
	const found: { heading: string; body: string }[] = [];
	const lines = content.split("\n");
	let heading: string | null = null;
	let body: string[] = [];
	for (const line of lines) {
		if (/^##\s/.test(line)) {
			if (heading !== null) found.push({ heading, body: body.join("\n").trim() });
			heading = line;
			body = [];
			continue;
		}
		if (heading !== null) body.push(line);
	}
	if (heading !== null) found.push({ heading, body: body.join("\n").trim() });
	return found;
}

/**
 * Project a persona document into named parts.
 *
 * The budget is spent on the sections in the template's order, which puts the
 * identity first. Anything that does not fit is reported as incomplete and left
 * out of `parts` rather than being cut mid-sentence: a caller that sees
 * `complete: false` can ask for the document itself, and one that sees a
 * truncated voice block would have no way to know it was reading half a sentence.
 */
export function personaSurface(
	bot: string,
	document: string,
	revision: string,
	content: string,
	budget: number,
): PersonaSurface {
	const limits: string[] = [
		"This is the persona as written, not proof an agent followed it. Only a host that builds its own request can guarantee the text reaches the model.",
	];
	const firstLine = content.split("\n").find((line) => line.trim().length > 0) ?? "";
	const name = /^#\s+(.+)$/.exec(firstLine.trim())?.[1]?.trim() ?? "";
	const found = sections(content);
	if (!found.length) {
		return {
			bot,
			document,
			revision,
			source: `workspace:${document}`,
			name,
			parts: [],
			missing: HEADINGS.map((entry) => entry.name),
			needs_interpretation: true,
			reason:
				"No `##` sections were found. This file has a shape the projector does not know, so it returns the revision and the name and nothing else — read the document itself rather than treating an empty result as an empty persona.",
			complete: false,
			characters: 0,
			budget,
			limits,
		};
	}
	const parts: PersonaPart[] = [];
	const missing: PartName[] = [];
	let remaining = budget;
	for (const { name: part, pattern } of HEADINGS) {
		const section = found.find((entry) => pattern.test(entry.heading));
		if (!section) {
			missing.push(part);
			continue;
		}
		const text = section.body;
		if (!text) {
			missing.push(part);
			continue;
		}
		const chars = Array.from(text);
		if (chars.length > remaining) {
			// Leave the section out whole. A half section reads as a whole one.
			parts.push({ name: part, text: "", complete: false });
			continue;
		}
		remaining -= chars.length;
		parts.push({ name: part, text, complete: true });
	}
	const characters = parts.reduce((total, entry) => total + Array.from(entry.text).length, 0);
	const trimmed = parts.filter((entry) => entry.complete);
	if (trimmed.length < parts.length)
		limits.push(
			`${parts.length - trimmed.length} section(s) did not fit the ${budget}-character budget and are returned empty with complete:false. Raise --budget or read the document.`,
		);
	return {
		bot,
		document,
		revision,
		source: `workspace:${document}`,
		name,
		// The cut sections stay in the list with an empty body. Dropping them would
		// make "there is no such section" and "it did not fit" look the same, which
		// is the distinction this whole projection exists to keep.
		parts,
		missing,
		needs_interpretation: false,
		reason: null,
		complete: parts.every((entry) => entry.complete),
		characters,
		budget,
		limits,
	};
}
