import type { Entry } from "./concept.ts";
import { resolveReferences } from "./graph.ts";

export interface RecallQuery {
	text: string;
	keywords?: string[];
	profile_ref?: string;
}
export interface RecallHit {
	entry: Entry;
	score: number;
	reasons: string[];
	factIndices: number[];
	depth: number;
	path: string[];
}
export interface RecallResult {
	hits: RecallHit[];
	graphTruncated: boolean;
	seedsTruncated: boolean;
	fallbackTruncated: boolean;
}
interface Neighbor {
	id: string;
	relation: string;
	weight: number;
}

const DECAY = 0.6;
const NEIGHBOR_LIMIT = 128;

// CJK bigrams retain short Chinese variants without requiring an external model or dictionary.
function terms(value: string): string[] {
	const result = new Set<string>();
	for (const token of value
		.normalize("NFKC")
		.toLowerCase()
		.match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+|[\p{Letter}\p{Number}]+/gu) ??
		[]) {
		const chars = Array.from(token);
		if (/^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]+$/u.test(token) && chars.length > 2) {
			for (let i = 0; i < chars.length - 1 && result.size < 100; i++) result.add(chars[i] + chars[i + 1]);
		} else if (chars.length) result.add(token);
	}
	return [...result];
}

export function lexicalScore(query: string, body: string): number {
	const normalized = query.normalize("NFKC").trim().toLowerCase();
	if (!normalized) return 1;
	const haystack = body.normalize("NFKC").toLowerCase();
	if (haystack.includes(normalized)) return 1;
	const words = terms(normalized);
	if (!words.length) return 0;
	return words.filter((word) => haystack.includes(word)).length / words.length;
}

function byRecent(a: Entry, b: Entry): number {
	return b.row.updated_at.localeCompare(a.row.updated_at) || a.row.id.localeCompare(b.row.id);
}

// Construct explicit edges once, while deriving shared-field neighbors lazily.
// Each query gets its own scoped graph so one person's seed cannot traverse another person's memory.
export function recall(entries: Entry[], queries: RecallQuery[], limit: number, fallback: boolean): RecallResult {
	const merged = new Map<string, RecallHit>();
	let graphTruncated = false;
	let seedsTruncated = false;
	let fallbackTruncated = false;
	const references = resolveReferences(entries).resolved;
	for (const [factIndex, query] of queries.entries()) {
		const scoped = entries
			.filter((entry) => !query.profile_ref || entry.row.profile_ref === query.profile_ref)
			.sort(byRecent);
		const byID = new Map(scoped.map((entry) => [entry.row.id, entry]));
		const explicit = new Map<string, Neighbor[]>();
		const append = (source: string, target: string) => {
			if (source === target || !byID.has(source) || !byID.has(target)) return;
			const values = explicit.get(source) ?? [];
			values.push({ id: target, relation: "refs", weight: 1 });
			explicit.set(source, values);
		};
		const groups = [new Map<string, Entry[]>(), new Map<string, Entry[]>(), new Map<string, Entry[]>()];
		for (const reference of references) {
			append(reference.source_id, reference.target_id);
			append(reference.target_id, reference.source_id);
		}
		for (const entry of scoped) {
			const keys = [entry.row.profile_ref, entry.row.topic, entry.row.created_at.slice(0, 10)];
			keys.forEach((key, index) => {
				if (!key) return;
				const values = groups[index].get(key) ?? [];
				values.push(entry);
				groups[index].set(key, values);
			});
		}
		const cache = new Map<string, Neighbor[]>();
		const neighbors = (entry: Entry): Neighbor[] => {
			const cached = cache.get(entry.row.id);
			if (cached) return cached;
			const unique = new Map<string, Neighbor>();
			const offer = (neighbor: Neighbor) => {
				const previous = unique.get(neighbor.id);
				if (previous) {
					if (neighbor.weight > previous.weight) unique.set(neighbor.id, neighbor);
					return;
				}
				if (unique.size >= NEIGHBOR_LIMIT) {
					graphTruncated = true;
					return;
				}
				unique.set(neighbor.id, neighbor);
			};
			for (const neighbor of explicit.get(entry.row.id) ?? []) offer(neighbor);
			const values = [entry.row.profile_ref, entry.row.topic, entry.row.created_at.slice(0, 10)];
			const relations = ["same_profile", "same_topic", "same_day"];
			const weights = [1, 0.8, 0.5];
			for (let index = 0; index < groups.length; index++) {
				for (const neighbor of groups[index].get(values[index]) ?? []) {
					if (neighbor.row.id === entry.row.id) continue;
					offer({ id: neighbor.row.id, relation: relations[index], weight: weights[index] });
				}
			}
			const result = [...unique.values()];
			cache.set(entry.row.id, result);
			return result;
		};
		const phrases = [query.text, ...(query.keywords ?? [])].filter((phrase) => phrase.trim());
		const seeds = scoped
			.map((entry) => {
				const searchable = `${entry.row.title} ${entry.row.subject} ${entry.row.topic} ${entry.row.tags.join(" ")} ${entry.row.body}`;
				const score = phrases.length ? Math.max(...phrases.map((phrase) => lexicalScore(phrase, searchable))) : 1;
				return { entry, score };
			})
			.filter((seed) => seed.score > 0)
			.sort((a, b) => b.score - a.score || byRecent(a.entry, b.entry));
		const maxSeeds = Math.min(Math.max(limit * 3, 10), 90);
		if (seeds.length > maxSeeds) seedsTruncated = true;
		const add = (entry: Entry, score: number, reason: string, depth: number, path: string[]) => {
			const previous = merged.get(entry.row.id);
			if (!previous) {
				merged.set(entry.row.id, { entry, score, reasons: [reason], factIndices: [factIndex], depth, path });
				return;
			}
			if (score > previous.score) {
				previous.score = score;
				previous.depth = depth;
				previous.path = path;
			}
			if (!previous.reasons.includes(reason)) previous.reasons.push(reason);
			if (!previous.factIndices.includes(factIndex)) previous.factIndices.push(factIndex);
		};
		for (const seed of seeds.slice(0, maxSeeds)) {
			add(seed.entry, seed.score, phrases.length ? "lexical" : "recent", 0, [seed.entry.row.id]);
			if (!phrases.length) continue;
			for (const first of neighbors(seed.entry)) {
				const entry = byID.get(first.id);
				if (!entry) continue;
				const score = seed.score * first.weight * DECAY;
				add(entry, score, first.relation === "refs" ? "ref_neighbor" : first.relation, 1, [
					seed.entry.row.id,
					entry.row.id,
				]);
				for (const second of neighbors(entry)) {
					if (second.id === seed.entry.row.id) continue;
					const next = byID.get(second.id);
					if (next)
						add(next, score * DECAY, second.relation === "refs" ? "ref_neighbor" : second.relation, 2, [
							seed.entry.row.id,
							entry.row.id,
							next.row.id,
						]);
				}
			}
		}
		if (fallback) {
			if (scoped.length > limit) fallbackTruncated = true;
			for (const entry of scoped.slice(0, limit)) {
				if (!merged.get(entry.row.id)?.factIndices.includes(factIndex))
					add(entry, 0, "recent_fallback", 0, [entry.row.id]);
			}
		}
	}
	return {
		hits: [...merged.values()].sort((a, b) => b.score - a.score || a.depth - b.depth || byRecent(a.entry, b.entry)),
		graphTruncated,
		seedsTruncated,
		fallbackTruncated,
	};
}
