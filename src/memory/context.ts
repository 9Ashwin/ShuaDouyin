import type { RecallHit } from "./recall.ts";

interface PackedMemory {
	hit: RecallHit;
	length: number;
}

// Keep high-scoring memories inside the available body budget; never repeat an ID.
export function packMemories(hits: RecallHit[], budget: number, limit: number) {
	if (budget <= 0 || limit <= 0)
		return { items: [] as { hit: RecallHit; body: string; truncated: boolean }[], used: 0 };
	const unique = [...new Map(hits.map((hit) => [hit.entry.row.id, hit])).values()];
	const selected: PackedMemory[] = [];
	const selectedIDs = new Set<string>();
	let used = 0;
	const minimum = Math.min(80, budget);
	for (const hit of unique) {
		if (selected.length >= limit) break;
		const full = Array.from(hit.entry.row.body).length;
		const natural = Math.min(full, 1000);
		const available = budget - used;
		const needed = natural <= available ? natural : Math.min(minimum, full);
		if (!needed || needed > available) continue;
		selected.push({ hit, length: needed });
		selectedIDs.add(hit.entry.row.id);
		used += needed;
	}
	if (selected.length < limit && selected.length < unique.length) {
		for (const item of selected) {
			const reduced = Math.min(item.length, minimum);
			used -= item.length - reduced;
			item.length = reduced;
		}
		for (const hit of unique) {
			if (selected.length >= limit) break;
			if (selectedIDs.has(hit.entry.row.id)) continue;
			const full = Array.from(hit.entry.row.body).length;
			const needed = Math.min(full, 1000, budget - used);
			if (!needed || (needed < minimum && needed < full)) continue;
			selected.push({ hit, length: needed });
			selectedIDs.add(hit.entry.row.id);
			used += needed;
		}
	}
	if (selected.length && used < budget) {
		const perItem = Math.floor((budget - used) / selected.length);
		for (const item of selected) {
			const available = Math.min(Array.from(item.hit.entry.row.body).length, 1000) - item.length;
			const growth = Math.min(perItem, available);
			item.length += growth;
			used += growth;
		}
	}
	// Alternate placement from both ends, keeping the strongest result first.
	const ordered: PackedMemory[] = Array.from({ length: selected.length });
	let head = 0;
	let tail = selected.length - 1;
	selected.forEach((item, index) => {
		ordered[index % 2 === 0 ? head++ : tail--] = item;
	});
	return {
		items: ordered.map(({ hit, length }) => {
			const chars = Array.from(hit.entry.row.body);
			return { hit, body: chars.slice(0, length).join(""), truncated: length < chars.length };
		}),
		used,
	};
}
