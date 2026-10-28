import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { isScalar, isSeq, parseDocument, stringify } from "yaml";
import { CliError } from "../errors.ts";
import type { Input } from "../operations/validate.ts";
import type { memories } from "../schema.ts";
import { revision } from "../workspace.ts";

// A memory is one concept file: YAML frontmatter plus a Markdown body. This
// module owns the file format, label rules and link parsing; nothing here
// touches SQLite or the filesystem.

// `relationship` holds what a person means to the owner and where the contact
// stands: where they met, shared ground, the last thing talked about, and what
// the owner wants from it. It is a layer of memory rather than a table of its
// own, because a relationship needs the same three guarantees every memory has —
// a source, a correction path and a way to forget it.
export const LAYERS = [
	"preference",
	"identity",
	"context",
	"experience",
	"activity",
	"persona",
	"relationship",
	"note",
] as const;
export const RELATIONS = ["refs", "same_profile", "same_topic", "same_day"] as const;
// What kind of thing a memory is. The distinction that earns its keep is
// observation versus insight: "he said the price was high" is something that
// happened, "he cares about cost" is a conclusion drawn from several such
// statements. Keeping them as separate rows is what lets a profile cite the
// evidence it rests on, and lets deleting the evidence show which conclusions
// lost their support.
export const MEMORY_TYPES = ["memory", "observation", "insight", "profile"] as const;
const CERTAINTIES = ["observed", "inferred", "user-stated"];
const PROFILE_REF = /^(?:user|group):[^\s:\r\n]{1,200}$/;
export const memoryId = /^(?:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}|mem_[A-Za-z0-9_-]{1,120})$/;

export type Memory = typeof memories.$inferSelect;
export interface Header {
	type: string;
	title: string;
	id: string;
	layer: string;
	subject: string;
	topic: string;
	tags: string[];
	profile_ref: string;
	certainty: string;
	confidence: number;
	sources: string[];
	links: string[];
	created_at: string;
	updated_at: string;
}
export interface Entry {
	row: Memory;
	content: string;
	frontmatter?: Record<string, unknown>;
}

// The most specific human-readable name wins, and the ID
// tail is only a fallback so two memories never collapse to one slug.
export function slugify(value: string): string {
	const normalized = value
		.normalize("NFKC")
		.toLowerCase()
		.trim()
		.replace(/[^\p{L}\p{N}]+/gu, "-")
		.replace(/-+/g, "-")
		.slice(0, 80);
	return normalized.replace(/^-+|-+$/g, "");
}

export function nodeSlug(id: string, subject: string, topic: string): string {
	return slugify(subject) || slugify(topic) || slugify(id.slice(id.lastIndexOf(":") + 1)) || slugify(id);
}

// Wiki links and relative .md links are authored references; external URLs are not.
export function parseLinks(body: string): string[] {
	const found: string[] = [];
	for (const match of body.matchAll(/\[\[([^\]]+)\]\]/g)) found.push(match[1]);
	for (const match of body.matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) {
		const href = match[1].trim();
		if (/^https?:/i.test(href) || !/\.md$/i.test(href)) continue;
		found.push(href.slice(href.lastIndexOf("/") + 1, -3));
	}
	return [...new Set(found.map(slugify).filter(Boolean))];
}

// A title is what a reader scans in a list, so it comes from what the memory
// says rather than from who it is about. Subject used to win here, which made
// every memory about a person show up under that person's sec_uid — an id is
// not a title, and a list of them tells the reader nothing.
export function deriveTitle(subject: string, topic: string, body: string): string {
	if (topic.trim()) return topic.trim().slice(0, 120);
	const firstLine = body.trim().split("\n")[0].trim();
	if (firstLine) return firstLine.length > 80 ? `${firstLine.slice(0, 80)}...` : firstLine;
	// Nothing to derive from: the subject is better than an empty title.
	return subject.trim().slice(0, 120);
}

export function validateMemoryInput(operation: string, input: Input): void {
	if (
		["memory.get", "memory.update", "memory.delete", "memory.history"].includes(operation) &&
		!memoryId.test(input.resource ?? "")
	)
		throw new CliError("invalid_argument", "Use a memory ID returned by memory list/search");
	if (input.layer !== undefined && !LAYERS.some((layer) => layer === input.layer))
		throw new CliError("invalid_argument", `--layer must be ${LAYERS.join(", ")}`);
	if (input.memory_type !== undefined && !MEMORY_TYPES.some((type) => type === input.memory_type))
		throw new CliError("invalid_argument", `--memory-type must be ${MEMORY_TYPES.join(", ")}`);
	if (input.certainty !== undefined && !CERTAINTIES.includes(input.certainty))
		throw new CliError("invalid_argument", "--certainty must be observed, inferred or user-stated");
	if (
		input.confidence !== undefined &&
		(!Number.isFinite(input.confidence) || input.confidence < 0 || input.confidence > 1)
	)
		throw new CliError("invalid_argument", "--confidence must be 0..1");
	if (input.profile_ref !== undefined && !PROFILE_REF.test(input.profile_ref))
		throw new CliError("invalid_argument", "--profile-ref must be user:<id> or group:<id>", {
			hint: "Link the memory to an entry in PROFILES.md.",
		});
	if (input.tags !== undefined) {
		const tags = input.tags.split(",").map((tag) => tag.trim());
		if (tags.some((tag) => !tag || tag.length > 60 || /[\r\n]/.test(tag)))
			throw new CliError("invalid_argument", "--tags must be comma-separated labels of 1..60 characters");
		if (tags.length > 20) throw new CliError("invalid_argument", "--tags accepts at most 20 labels");
	}
	if (["memory.add", "memory.update"].includes(operation)) {
		if (!input.text?.trim() || input.text.length > 65536 || input.text.includes("\0"))
			throw new CliError("invalid_argument", "Memory requires 1..65536 characters without NUL");
		if (!input.source?.trim() || input.source.length > 2048 || /[\r\n]/.test(input.source))
			throw new CliError(
				"invalid_argument",
				"--source must identify the supporting observation, message or user statement",
			);
		if (input.certainty === "user-stated" && !input.source.startsWith("user:"))
			throw new CliError("invalid_argument", "user-stated memory requires a user: source reference");
		if (input.links?.trim() && input.links.split(",").some((id) => !memoryId.test(id.trim())))
			throw new CliError("invalid_argument", "--links must contain comma-separated memory IDs");
	}
	if (["memory.update", "memory.delete"].includes(operation) && !input.if_match)
		throw new CliError("invalid_argument", "--if-match is required; read the current memory first");
}

// A title counts as written by someone when it is neither the current
// derivation nor the old one, which took the subject whenever a subject existed.
function authored(old?: Header & { body?: string }): boolean {
	if (!old?.title) return false;
	const derived = [deriveTitle(old.subject, old.topic, old.body ?? ""), old.subject.trim().slice(0, 120)];
	return !derived.includes(old.title);
}

export function metadata(input: Input, body: string, old?: Header & { body?: string }): Header {
	const subject = input.subject ?? old?.subject ?? "self";
	const topic = input.topic ?? old?.topic ?? "";
	const tags =
		input.tags === undefined ? (old?.tags ?? []) : [...new Set(input.tags.split(",").map((tag) => tag.trim()))];
	return {
		type: input.memory_type ?? old?.type ?? "memory",
		// A written title is the author's; only a title this module derived is
		// replaced. Files written before the derivation changed carry the subject
		// as their title, which no longer counts as authored.
		title: authored(old) ? (old?.title ?? "") : deriveTitle(subject, topic, body),
		id: old?.id ?? randomUUID(),
		layer: input.layer ?? old?.layer ?? "note",
		subject,
		topic,
		tags,
		profile_ref: input.profile_ref ?? old?.profile_ref ?? "",
		certainty: input.certainty ?? old?.certainty ?? "inferred",
		confidence: input.confidence ?? old?.confidence ?? 0.5,
		sources: [...new Set([...(old?.sources ?? []), input.source ?? ""].filter(Boolean))],
		links:
			input.links === undefined
				? (old?.links ?? [])
				: input.links.trim()
					? [...new Set(input.links.split(",").map((id) => id.trim()))]
					: [],
		created_at: old?.created_at ?? new Date().toISOString(),
		updated_at: new Date().toISOString(),
	};
}

function contentHash(body: string): string {
	const trim = (value: string) => value.replace(/^\p{White_Space}+|\p{White_Space}+$/gu, "");
	const canonical = body.replace(/\[([^\]]*)\]\(([^)]+)\)/g, (match, _label: string, href: string) => {
		const path = trim(href);
		if (/^https?:\/\//i.test(path) || !/\.md$/i.test(path)) return match;
		const name = posix.basename(path, posix.extname(path));
		const lower = Array.from(trim(name), (character) => Array.from(character.toLowerCase())[0] ?? character).join("");
		const slug = lower.replace(/[^\p{L}\p{Nd}]+/gu, "-").replace(/^-+|-+$/g, "");
		return slug ? `[[${slug}]]` : match;
	});
	return createHash("sha256").update(trim(canonical)).digest("hex");
}

// A field with nothing in it is left out rather than written as an empty
// string or list. Frontmatter is evidence a reader has to scan past to reach
// what the memory says, and four lines of `tags: []` / `profile_ref: ""` are
// four lines of noise. Every omitted field decodes back to the same default, so
// nothing is lost by not writing it.
function fields(header: Header): Record<string, unknown> {
	const written: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(header))
		if (Array.isArray(value) ? value.length > 0 : value !== "") written[key] = value;
	return written;
}

export function markdown(header: Header, body: string, original?: Entry): string {
	if (!original) return `---\n${stringify(fields(header))}---\n${body}`;
	const opening = /^---\r?\n/.exec(original.content);
	if (!opening) throw new CliError("state_corrupt", "Memory frontmatter is incomplete");
	const remainder = original.content.slice(opening[0].length);
	const closing = /\r?\n---\r?\n/.exec(remainder);
	if (!closing) throw new CliError("state_corrupt", "Memory frontmatter is incomplete");
	const doc = parseDocument(remainder.slice(0, closing.index), { uniqueKeys: true });
	if (doc.errors.length || doc.warnings.length) throw new CliError("state_corrupt", "Invalid memory YAML");
	const setPreservingComments = (path: string[], value: unknown) => {
		const current = doc.getIn(path, true);
		if (isSeq(current) && Array.isArray(value)) {
			const available = [...current.items];
			current.items = value.map((item) => {
				const index = available.findIndex((node) => isScalar(node) && node.value === item);
				return index < 0 ? doc.createNode(item) : available.splice(index, 1)[0];
			});
		} else if (!isScalar(current) || current.value !== value) doc.setIn(path, value);
	};
	const written = fields(header);
	for (const key of Object.keys(header) as (keyof Header)[]) {
		// A key that has gone empty is removed rather than set to `[]` or `""`,
		// so an update produces the same lean file a fresh write would.
		if (!(key in written) && doc.has(key)) doc.delete(key);
		else if (key in written) setPreservingComments([key], written[key]);
	}
	for (const key of [
		"subject",
		"topic",
		"profile_ref",
		"layer",
		"confidence",
		"certainty",
		"title",
		"tags",
		"type",
	] as const)
		if (doc.hasIn(["metadata", key])) setPreservingComments(["metadata", key], header[key]);
	if (doc.has("hash")) setPreservingComments(["hash"], contentHash(body));
	return `---\n${doc.toString()}---\n${body}`;
}

export function checkedMarkdown(bot: string, path: string, header: Header, body: string, original?: Entry): string {
	const content = markdown(header, body, original);
	if (content.length > 131072 || Buffer.byteLength(content, "utf8") > 262144)
		throw new CliError("invalid_argument", "The resulting memory file exceeds the supported size");
	decode(bot, path, content);
	return content;
}

export function decode(bot: string, path: string, content: string): Entry {
	const opening = /^---\r?\n/.exec(content);
	if (content.length > 131072 || !opening)
		throw new CliError("state_corrupt", `Memory lacks YAML frontmatter: ${path}`);
	const remainder = content.slice(opening[0].length);
	const closing = /\r?\n---\r?\n/.exec(remainder);
	if (!closing) throw new CliError("state_corrupt", `Memory frontmatter is incomplete: ${path}`);
	let raw: Partial<Header> & { timestamp?: string; metadata?: unknown };
	try {
		const yaml = parseDocument(remainder.slice(0, closing.index), { uniqueKeys: true });
		if (yaml.errors.length || yaml.warnings.length)
			throw new Error([...yaml.errors, ...yaml.warnings].map((error) => error.message).join("; "));
		raw = yaml.toJS({ maxAliasCount: 0 }) as Partial<Header> & { timestamp?: string; metadata?: unknown };
	} catch (cause) {
		throw new CliError("state_corrupt", `Invalid memory YAML: ${path}`, { cause });
	}
	// Hand-edited files usually end with a newline; it must not change the body
	// hash, or identical bodies would stop merging after an external edit.
	const body = remainder.slice(closing.index + closing[0].length).trimEnd();
	if (
		!raw ||
		typeof raw !== "object" ||
		Array.isArray(raw) ||
		(raw.metadata !== undefined && (!raw.metadata || typeof raw.metadata !== "object" || Array.isArray(raw.metadata)))
	)
		throw new CliError("state_corrupt", `Invalid memory metadata: ${path}`);
	const nested = (raw.metadata ?? {}) as { subject?: string; topic?: string; profile_ref?: string };
	// Files written before concept frontmatter existed carry no type, title,
	// tags or profile_ref; they stay readable and index with derived defaults.
	const header: Header = {
		type: raw.type ?? "memory",
		title: raw.title ?? "",
		id: raw.id ?? "",
		layer: raw.layer ?? "",
		subject: raw.subject ?? nested.subject ?? "",
		topic: raw.topic ?? nested.topic ?? "",
		tags: raw.tags ?? [],
		profile_ref: raw.profile_ref ?? nested.profile_ref ?? "",
		certainty: raw.certainty ?? "inferred",
		confidence: raw.confidence ?? 0.5,
		sources: raw.sources ?? [`file:${path}`],
		links: raw.links ?? [],
		created_at: raw.created_at ?? raw.timestamp ?? "",
		updated_at: raw.updated_at ?? raw.timestamp ?? "",
	};
	if (typeof header.type !== "string" || typeof header.title !== "string" || !Array.isArray(header.tags))
		throw new CliError("state_corrupt", `Invalid memory metadata: ${path}`);
	if (header.tags.some((tag) => typeof tag !== "string"))
		throw new CliError("state_corrupt", `Invalid memory tags: ${path}`);
	if (typeof header.profile_ref !== "string" || (header.profile_ref && !PROFILE_REF.test(header.profile_ref)))
		throw new CliError("state_corrupt", `Invalid memory profile_ref: ${path}`);
	if (
		!memoryId.test(header.id) ||
		!LAYERS.some((layer) => layer === header.layer) ||
		!CERTAINTIES.includes(header.certainty) ||
		typeof header.subject !== "string" ||
		typeof header.topic !== "string" ||
		!Number.isFinite(header.confidence) ||
		header.confidence < 0 ||
		header.confidence > 1 ||
		!Array.isArray(header.sources) ||
		!header.sources.length ||
		header.sources.some((source) => typeof source !== "string" || !source.trim()) ||
		(header.certainty === "user-stated" && !header.sources.every((source) => source.startsWith("user:"))) ||
		!Array.isArray(header.links) ||
		header.links.some((id) => typeof id !== "string" || !memoryId.test(id)) ||
		!body.trim() ||
		typeof header.created_at !== "string" ||
		typeof header.updated_at !== "string" ||
		Number.isNaN(Date.parse(header.created_at)) ||
		Number.isNaN(Date.parse(header.updated_at)) ||
		!path.startsWith(`memory/${header.layer}/`)
	)
		throw new CliError("state_corrupt", `Invalid memory metadata: ${path}`);
	if (!header.title) header.title = deriveTitle(header.subject, header.topic, body);
	return {
		row: { ...header, bot_id: bot, path, body, revision: revision(content) },
		content,
		frontmatter: raw as Record<string, unknown>,
	};
}
