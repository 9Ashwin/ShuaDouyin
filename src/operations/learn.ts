import { createHash } from "node:crypto";
import { CliError } from "../errors.ts";
import { measureWit } from "../voice.ts";
import type { Workspaces } from "../workspace.ts";

// Turn what a session taught into something the next session starts with.
//
// This is the piece that was missing: the bot kept learning — browsing rounds,
// comment outcomes, corrections — and every bit of it stayed in an event log
// nobody reads again. A persona grows from that, but only its voice; the lessons
// themselves had no route back into the tool's own skill.
//
// The design follows the continual-learning hook shipped by PenguinHarness
// (github.com/Prism-Shadow/penguin-harness): when a task ends, condense it and
// keep only what a future session would want to know before it starts. Two
// things differ here, deliberately. It is a command rather than a hook, because
// the agent calls it when it decides a round is worth keeping rather than being
// interrupted at a workflow boundary. And a finding is not written straight into
// a skill: it is recorded with its source, so a later call can see where each
// line came from instead of trusting the tool's judgement.

export const FINDING_KINDS = ["correction", "gotcha", "method", "convention", "preference"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
	kind: FindingKind;
	// One sentence, general enough to apply to the next round.
	text: string;
	// What in the activity supports it.
	source: string;
	// What makes this finding the same finding on a later round. A failure that
	// has happened twice and one that has happened four times are the same lesson,
	// so the count belongs in the text a reader sees and not in this key — putting
	// it in the comparison made every round append another line saying the number
	// had gone up.
	key: string;
}

// Which events can carry a lesson, and what a lesson from each one reads like.
//
// This is the part worth doing mechanically: an event already says what happened,
// so the tool can propose the finding. What it cannot do is say why it mattered —
// that is the agent's job, and inventing a reason here would put a guess in the
// same record as a fact.
export function candidateFindings(events: unknown[]): Finding[] {
	const out: Finding[] = [];
	const failed = new Map<string, { count: number; codes: Set<string> }>();
	for (const event of events) {
		if (!event || typeof event !== "object") continue;
		const record = event as { id?: unknown; operation?: unknown; data?: unknown; at?: unknown };
		const operation = typeof record.operation === "string" ? record.operation : "";
		const id = typeof record.id === "string" ? record.id : "";
		const data = record.data as Record<string, unknown> | undefined;
		if (!operation || !id) continue;
		// A repeated failure is the strongest signal there is: it cost a round and
		// it will cost the next one unless it is written down. A failure is stored
		// as a normal event whose data says ok:false, so the code lives there.
		const ok = data && data.ok === false;
		const code = ok && typeof data.error_code === "string" ? data.error_code : "";
		if (code) {
			const entry = failed.get(operation) ?? { count: 0, codes: new Set<string>() };
			entry.count++;
			entry.codes.add(code);
			failed.set(operation, entry);
			continue;
		}
		// A comment that landed well says something about what works here.
		if ((operation === "comment.post" || operation === "comment.reply") && data) {
			const text = typeof data.text === "string" ? data.text : "";
			if (!text) continue;
			const wit = measureWit(text);
			if (wit.verdict === "has-wit") {
				// Why it landed is the agent's judgement, not the tool's. What the
				// tool can honestly say is which signals it found, so the record
				// carries them and stops there.
				const signals = [...wit.echoes, ...wit.specific, ...wit.turns].slice(0, 4);
				out.push({
					kind: "method",
					text: `「${text.slice(0, 40)}」这种写法有反响${signals.length ? `（${signals.join("、")}）` : ""}`,
					source: `event:${id}`,
					key: `method:${text.slice(0, 40)}`,
				});
			}
		}
		// A round that ended with more skips than keeps says what this account does
		// not want. The counts live under summary, and are numbers rather than the
		// arrays the first version looked for — so this rule never fired on a real
		// event, only on the fixture written to match it.
		if (operation === "browse.end" && data) {
			const summary = data.summary as { watched?: unknown; skipped?: unknown } | undefined;
			const watched = typeof summary?.watched === "number" ? summary.watched : 0;
			const skipped = typeof summary?.skipped === "number" ? summary.skipped : 0;
			if (skipped > watched && skipped >= 3)
				out.push({
					kind: "preference",
					text: `这一轮划过 ${skipped} 条、只看过 ${watched} 条`,
					source: `event:${id}`,
					// Each round is its own evidence, so the round is what makes it
					// distinct; two rounds that skipped a lot are two observations.
					key: `preference:${id}`,
				});
		}
	}
	for (const [operation, entry] of failed) {
		// One failure is an incident. Two of the same kind is a property of this
		// page that the next round will hit again.
		if (entry.count < 2) continue;
		out.push({
			kind: "gotcha",
			text: `${operation} 失败过 ${entry.count} 次（${[...entry.codes].join("、")}），重试前先读一遍错误再动手`,
			source: `events:${operation}`,
			// What the lesson is about: the command. Not how many times, which only
			// grows and would make the same lesson look new on every round.
			key: `gotcha:${operation}`,
		});
	}
	return out;
}

export interface KeepResult {
	// The identifier this batch was stored under.
	batch: string;
	findings: Finding[];
	// Findings this round that a previous round already recorded.
	duplicates: string[];
	// Where it was written.
	path: string;
}

// Findings accumulate in one Markdown file per bot, next to the persona.
//
// Markdown because the rest of the workspace's knowledge is Markdown, so a human
// can read and edit it, and because a lesson someone disagreed with should be
// deletable by hand. It is not a skill: the skill ships with the tool and is
// replaced on update, which would throw the bot's own lessons away.
export async function keepFindings(
	workspaces: Workspaces,
	events: unknown[],
	options: { note?: string; since?: string; write?: boolean } = {},
): Promise<KeepResult> {
	// --since limits what counts as this round's activity. It was accepted and
	// only echoed into a source label, so a round that named a start time still
	// learned from everything ever recorded — the filter said one thing and did
	// another.
	let scope = events;
	if (options.since !== undefined) {
		const from = Date.parse(options.since);
		if (!Number.isFinite(from)) throw new CliError("invalid_argument", "--since must be an RFC3339 timestamp");
		scope = events.filter((event) => {
			const at = event && typeof event === "object" ? (event as { at?: unknown }).at : undefined;
			return typeof at === "string" && Date.parse(at) >= from;
		});
	}
	const proposals = candidateFindings(scope);
	const note = (options.note ?? "").trim();
	// A caller that read the activity and reached its own conclusion can say so in
	// one line; that line is recorded verbatim and marked as authored, which is
	// what keeps it distinguishable from what the tool measured.
	if (note) {
		if (note.length > 2000) throw new CliError("invalid_argument", "--note must be at most 2000 characters");
		proposals.push({
			kind: "convention",
			text: note,
			source: "caller:note",
			key: `convention:${note}`,
		});
	}
	if (!proposals.length)
		throw new CliError("not_found", "Nothing in this activity is worth keeping", {
			hint: "Findings come from repeated failures, comments that landed, and rounds that mostly skipped. Pass --note to record your own conclusion.",
		});
	const path = "lessons.md";
	let existing = "";
	try {
		existing = (await workspaces.document(path)).content;
	} catch (error) {
		if (!(error instanceof CliError && error.code === "not_found")) throw error;
	}
	// A stored line reads "- [kind] text  <!-- source -->". Comparing a new
	// finding against that whole line never matched, because the finding itself is
	// just the text — every round re-added everything it had already kept.
	// The kind and the source comment are stripped before comparing, so the same
	// lesson is the same lesson whatever section it was filed under.
	// The identity is the key that was written into the line's comment, not the
	// sentence: a failure count in the sentence grows, and comparing sentences made
	// each round append the same lesson again. A line written before keys existed
	// falls back to its text, which is what the old file holds.
	const seen = new Set(
		existing
			.split("\n")
			.filter((line) => line.startsWith("- "))
			.map((line) => {
				// The key sits after the source inside the comment, not at its start,
				// so anchoring it to `<!--` matched nothing and every round re-added
				// everything.
				const key = /key:([^>]*?)\s*-->/.exec(line)?.[1];
				if (key) return normalise(key);
				return normalise(
					line
						.slice(2)
						.replace(/^\[[a-z]+\]\s*/, "")
						.replace(/<!--.*?-->/g, ""),
				);
			}),
	);
	const fresh: Finding[] = [];
	const duplicates: string[] = [];
	for (const finding of proposals) {
		const identity = normalise(finding.key);
		if (seen.has(identity)) {
			duplicates.push(finding.text);
			continue;
		}
		seen.add(identity);
		fresh.push(finding);
	}
	const batch = createHash("sha256")
		.update(JSON.stringify(fresh.map((finding) => [finding.kind, finding.text])))
		.digest("hex")
		.slice(0, 16);
	if (!fresh.length || options.write === false) return { batch, findings: fresh, duplicates, path };
	const date = new Date().toISOString().slice(0, 10);
	const lines = [
		"",
		`## ${date} · ${batch}`,
		"",
		...fresh.map((finding) => `- [${finding.kind}] ${finding.text}  <!-- ${finding.source} · key:${finding.key} -->`),
	];
	const base = existing.trimEnd();
	const header = base ? "" : "# 学到的东西\n\n每条都带着它是从哪来的。不同意就删掉，工具不会再加回来。\n";
	const content = `${base}${base ? "\n" : header}\n${lines.join("\n").trimStart()}\n`;
	if (base) await workspaces.setDocument(path, content, (await workspaces.document(path)).revision);
	else await workspaces.setDocument(path, content);
	return { batch, findings: fresh, duplicates, path };
}

// The same lesson said twice is the same lesson: case, spacing and the source
// comment must not make a duplicate look new, or every round would re-add
// everything.
function normalise(text: string): string {
	return text.replace(/\s+/g, "").toLowerCase();
}
