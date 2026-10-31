import { posix } from "node:path";
import { marked } from "marked";
import type { Memory } from "./concept.ts";
import { type Entry, nodeSlug, slugify } from "./concept.ts";

// Memory relations. refs is authored (explicit IDs or body links); the other
// three are derived from attributes and therefore undirected.

const IMPLICIT_WEIGHTS = { same_profile: 1, same_topic: 0.8, same_day: 0.5 } as const;

export interface Relation {
	source_id: string;
	target_id: string;
	relation: string;
	weight: number;
}

export interface ReferenceIssue {
	source_id: string;
	kind: "id" | "path" | "wiki";
	target: string;
	reason: "not_active" | "ambiguous" | "outside_memory" | "unverified";
}
export interface ResolvedReference {
	source_id: string;
	target_id: string;
	kind: "id" | "path" | "wiki";
}

// Used only to prevent destructive moves; a case or Unicode variant may refer
// to the same file on another supported filesystem and must not be guessed as an edge.
export function possiblySamePath(left: string, right: string): boolean {
	return left.normalize("NFC").toLowerCase() === right.normalize("NFC").toLowerCase();
}

// Resolve authored links from the same files for graph, recall and maintenance.
export function resolveReferences(entries: Entry[]): { resolved: ResolvedReference[]; unresolved: ReferenceIssue[] } {
	const byID = new Map(entries.map(({ row }) => [row.id, row]));
	const byPath = new Map(entries.map(({ row }) => [posix.normalize(row.path), row.id]));
	const bySlug = new Map<string, string[]>();
	for (const { row } of entries) {
		const key = nodeSlug(row.id, row.subject, row.topic);
		bySlug.set(key, [...(bySlug.get(key) ?? []), row.id]);
	}
	const resolved: ResolvedReference[] = [];
	const unresolved: ReferenceIssue[] = [];
	const seen = new Set<string>();
	for (const { row } of entries) {
		const add = (
			kind: ReferenceIssue["kind"],
			value: string,
			target?: string,
			reason: ReferenceIssue["reason"] = "not_active",
		) => {
			const key = `${row.id}\0${kind}\0${value}`;
			if (seen.has(key)) return;
			seen.add(key);
			if (!target) unresolved.push({ source_id: row.id, kind, target: value, reason });
			else if (target !== row.id) resolved.push({ source_id: row.id, target_id: target, kind });
		};
		for (const id of row.links) add("id", id, byID.has(id) ? id : undefined);
		const resolvePath = (destination: string) => {
			const raw = destination.split(/[?#]/, 1)[0];
			if (!raw || /^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(raw)) return;
			let decoded: string;
			try {
				decoded = decodeURIComponent(raw);
			} catch {
				add("path", raw, undefined, "outside_memory");
				return;
			}
			if (!/\.md$/i.test(decoded)) return;
			if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(decoded)) {
				add("path", raw, undefined, "outside_memory");
				return;
			}
			const path = posix.normalize(posix.join(posix.dirname(row.path), decoded));
			if (!path.startsWith("memory/") || path.includes("\\")) {
				add("path", raw, undefined, "outside_memory");
				return;
			}
			add("path", path, byPath.get(path));
		};
		// Raw HTML is stripped of comments and script bodies first: both can contain
		// something that looks like a link and is not one. A relative href is a
		// reference to another memory; an absolute one is not, and is skipped
		// rather than reported.
		const htmlReferences = (token: { raw: string }) => {
			const html = token.raw.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
			for (const anchor of html.matchAll(/<a\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi)) {
				const href = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(anchor[0]);
				if (!href) continue;
				const value = href[1] ?? href[2] ?? href[3] ?? "";
				if (/^(?:[a-z][a-z0-9+.-]*:|\/)/i.test(value)) continue;
				// An entity in the href means the value is not the one the author
				// wrote. Resolving it would be a guess, so it is reported as unverified.
				if (/&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);/i.test(value)) add("path", value, undefined, "unverified");
				else resolvePath(value);
			}
		};
		// A wiki link resolves only when exactly one memory carries that slug. Two
		// candidates make it ambiguous rather than picking one.
		const wikiReferences = (token: unknown) => {
			const text = typeof (token as { text?: unknown }).text === "string" ? (token as { text: string }).text : "";
			if (!text) return;
			for (const match of text.matchAll(/\[\[([^\]]+)\]\]/g)) {
				const label = slugify(match[1]);
				if (!label) continue;
				const found = bySlug.get(label) ?? [];
				add("wiki", label, found.length === 1 ? found[0] : undefined, found.length > 1 ? "ambiguous" : "not_active");
			}
		};
		const tokens = marked.lexer(row.body);
		marked.walkTokens(tokens, (token) => {
			if (token.type === "link") resolvePath(token.href);
			if (token.type === "html") htmlReferences(token);
			// Inline tokens are walked separately; treating them here would double
			// count the same link.
			if (token.type !== "text" || ("tokens" in token && token.tokens?.length)) return;
			wikiReferences(token);
		});
	}
	return { resolved, unresolved };
}

export function edgeKey(source: string, target: string, relation: string): string {
	return `${source}\u0000${target}\u0000${relation}`;
}

// Explicit IDs, body wiki links and attribute grouping all become edges.
// Implicit edges are undirected pairs, so the lower ID is stored first.
export function relations(entries: Entry[]): Relation[] {
	const byID = new Map(entries.map((entry) => [entry.row.id, entry]));
	// A slug shared by two memories cannot identify either one, so it links
	// to neither rather than silently resolving to whichever came last.
	const found = new Map<string, Relation>();
	const add = (source: string, target: string, relation: string, weight: number) => {
		if (source === target || !byID.has(source) || !byID.has(target)) return;
		const [from, to] = relation === "refs" || source < target ? [source, target] : [target, source];
		found.set(edgeKey(from, to, relation), { source_id: from, target_id: to, relation, weight });
	};
	for (const reference of resolveReferences(entries).resolved) add(reference.source_id, reference.target_id, "refs", 1);
	const groups: [keyof typeof IMPLICIT_WEIGHTS, (row: Memory) => string][] = [
		["same_profile", (row) => row.profile_ref],
		["same_topic", (row) => row.topic],
		["same_day", (row) => row.created_at.slice(0, 10)],
	];
	for (const [relation, key] of groups) {
		const buckets = new Map<string, Memory[]>();
		for (const { row } of entries) {
			const value = key(row);
			if (!value) continue;
			const bucket = buckets.get(value) ?? [];
			bucket.push(row);
			buckets.set(value, bucket);
		}
		for (const bucket of buckets.values())
			for (let left = 0; left < bucket.length; left++)
				for (let right = left + 1; right < bucket.length; right++)
					add(bucket[left].id, bucket[right].id, relation, IMPLICIT_WEIGHTS[relation]);
	}
	return [...found.values()].sort(
		(left, right) =>
			left.relation.localeCompare(right.relation) ||
			left.source_id.localeCompare(right.source_id) ||
			left.target_id.localeCompare(right.target_id),
	);
}
