import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import type { Entry } from "../src/memory/concept.ts";
import { packMemories } from "../src/memory/context.ts";
import { lexicalScore, recall } from "../src/memory/recall.ts";
import { Workspaces } from "../src/workspace.ts";

function entry(id: string, body: string, date: string, links: string[] = [], profile = ""): Entry {
	return {
		row: {
			id,
			bot_id: "default",
			path: `memory/note/${id}.md`,
			type: "memory",
			title: "",
			layer: "note",
			subject: "",
			topic: "",
			tags: [],
			profile_ref: profile,
			certainty: "inferred",
			confidence: 0.5,
			sources: ["user:test"],
			links,
			body,
			revision: "a".repeat(64),
			created_at: date,
			updated_at: date,
		},
		content: "",
	};
}

test("lexical seeds expand through weighted reference edges for two hops", () => {
	const a = entry("mem_a", "quartzprobe", "2026-01-01T00:00:00Z", ["mem_b"]);
	const b = entry("mem_b", "independent", "2026-01-02T00:00:00Z", ["mem_c"]);
	const c = entry("mem_c", "unrelated words", "2026-01-03T00:00:00Z");
	const result = recall([a, b, c], [{ text: "quartzprobe" }], 10, false);
	assert.deepEqual(
		result.hits.map((hit) => hit.entry.row.id),
		["mem_a", "mem_b", "mem_c"],
	);
	assert.equal(result.hits[0].score, 1);
	assert.equal(result.hits[1].score, 0.6);
	assert.equal(result.hits[2].score, 0.36);
	assert.deepEqual(
		result.hits.map((hit) => hit.depth),
		[0, 1, 2],
	);
	assert.deepEqual(result.hits[2].path, ["mem_a", "mem_b", "mem_c"]);
	assert.ok(result.hits[2].reasons.includes("ref_neighbor"));
	assert.ok(lexicalScore("小林喜欢简短的回复", "小林喜欢简短回复") > 0);
	assert.ok(lexicalScore("茶", "绿茶") > 0);
});

test("recent fallback covers every eligible fact and reports omitted entries", () => {
	const entries = Array.from({ length: 6 }, (_, index) =>
		entry(`mem_${index}`, "other", "2026-01-01T00:00:00Z", [], "user:owner"),
	);
	const result = recall(
		entries,
		[
			{ text: "quartzprobe", profile_ref: "user:owner" },
			{ text: "fjordprobe", profile_ref: "user:owner" },
		],
		5,
		true,
	);
	assert.equal(result.fallbackTruncated, true);
	assert.equal(result.hits.length, 5);
	assert.deepEqual(result.hits[0].factIndices, [0, 1]);
});

test("overlapping relationships count a neighbor only once toward the bound", () => {
	const seed = entry("mem_seed", "quartzprobe", "2026-01-01T00:00:00Z", [], "user:owner");
	seed.row.topic = "shared-topic";
	const peers = Array.from({ length: 80 }, (_, index) => {
		const item = entry(`mem_peer_${index}`, "other", "2026-01-01T00:00:00Z", [], "user:owner");
		item.row.topic = "shared-topic";
		return item;
	});
	const extra = entry("mem_extra", "different", "2026-01-01T00:00:00Z", [], "user:friend");
	extra.row.topic = "shared-topic";
	const result = recall([seed, ...peers, extra], [{ text: "quartzprobe" }], 20, false);
	assert.equal(result.graphTruncated, false);
	assert.ok(result.hits.some((hit) => hit.entry.row.id === extra.row.id));
});

test("multi-person facts never propagate a seed across profile boundaries", () => {
	const owner = entry("mem_owner", "翠鸟观察", "2026-01-01T00:00:00Z", ["mem_friend"], "user:owner");
	const friend = entry("mem_friend", "夕阳山水", "2026-01-01T00:00:00Z", [], "user:friend");
	const result = recall(
		[owner, friend],
		[
			{ text: "翠鸟观察", profile_ref: "user:owner" },
			{ text: "zzqvword", profile_ref: "user:friend" },
		],
		20,
		true,
	);
	const friendHit = result.hits.find((hit) => hit.entry.row.id === friend.row.id);
	assert.deepEqual(friendHit?.reasons, ["recent_fallback"]);
	assert.deepEqual(friendHit?.factIndices, [1]);
	assert.ok(
		!recall([owner, friend], [{ text: "翠鸟观察", profile_ref: "user:owner" }], 20, false).hits.some(
			(hit) => hit.entry.row.id === friend.row.id,
		),
	);
});

test("dense derived relations have an explicit neighbor bound", () => {
	const entries = Array.from({ length: 145 }, (_, index) =>
		entry(`mem_${index}`, index === 0 ? "quartzprobe" : "other", "2026-01-01T00:00:00Z"),
	);
	const result = recall(entries, [{ text: "quartzprobe" }], 20, false);
	assert.equal(result.graphTruncated, true);
	assert.ok(result.hits.length <= entries.length);
});

test("context packing distributes budget without duplicate IDs", () => {
	const docs = [
		entry("mem_a", "a".repeat(150), "2026-01-01T00:00:00Z"),
		entry("mem_b", "b".repeat(100), "2026-01-02T00:00:00Z"),
		entry("mem_c", "c".repeat(40), "2026-01-03T00:00:00Z"),
	];
	const hits = docs.map((item, index) => ({
		entry: item,
		score: 1 - index / 10,
		reasons: ["lexical"],
		factIndices: [0],
		depth: 0,
		path: [item.row.id],
	}));
	const packed = packMemories(hits, 200, 3);
	assert.ok(packed.used <= 200);
	assert.equal(new Set(packed.items.map((item) => item.hit.entry.row.id)).size, packed.items.length);
	assert.equal(packed.items.length, 3);
	assert.equal(packed.items[0].hit.entry.row.id, "mem_a");
});

test("context bounds oversized memory metadata independently of body budget", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-recall-metadata-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = new App({ state_dir: base });
	await root.execute("init", { name: "ShuaDouyin" });
	const app = new App({ state_dir: base });
	const file = (await app.execute("memory.add", { text: "specificfact", source: "user:small" })) as { file: string };
	const content = (await readFile(file.file, "utf8")).replace("user:small", `user:${"s".repeat(70000)}`);
	await writeFile(file.file, content);
	const result = (await app.execute("context.show", { query: "specificfact", budget: 100 })) as {
		memories: { sources: string[]; sources_truncated: boolean }[];
	};
	assert.equal(result.memories[0].sources_truncated, true);
	assert.deepEqual(result.memories[0].sources, []);
	assert.ok(JSON.stringify(result).length < 10000);
});

test("candidate fallback and large context report omitted matches", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-recall-more-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = new App({ state_dir: base });
	await root.execute("init", { name: "ShuaDouyin" });
	const app = new App({ state_dir: base });
	const dir = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(dir, { recursive: true });
	for (let index = 0; index < 95; index++) {
		const content = [
			"---",
			`id: mem_many_${index}`,
			"layer: note",
			"certainty: inferred",
			"confidence: 0.5",
			"sources:",
			"  - user:test",
			"created_at: 2026-01-01T00:00:00Z",
			"updated_at: 2026-01-01T00:00:00Z",
			"---",
			"unrelated memory",
			"",
		].join("\n");
		await writeFile(join(dir, `${index}.md`), content);
	}
	const result = (await app.execute("memory.candidates", {
		text: JSON.stringify({ facts: [{ text: "quartzprobe", sources: ["user:test"] }] }),
		limit: 5,
	})) as { candidates: unknown[]; more_candidates: boolean };
	assert.equal(result.candidates.length, 5);
	assert.equal(result.more_candidates, true);
	const context = (await app.execute("context.show", { limit: 1000, budget: 20000 })) as {
		recall: { seeds_truncated: boolean; more_matches: boolean };
	};
	assert.equal(context.recall.seeds_truncated, true);
	assert.equal(context.recall.more_matches, true);
});

test("context uses scoped lexical graph recall and keeps room for memories", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-recall-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const root = new App({ state_dir: base });
	await root.execute("init", { name: "ShuaDouyin" });
	const app = new App({ state_dir: base });
	const saved = (await app.execute("memory.add", {
		text: "小林喜欢简短回复",
		source: "user:one",
		profile_ref: "user:owner",
	})) as { id: string; file: string };
	await app.execute("memory.add", { text: "朋友喜欢简短回复", source: "user:two", profile_ref: "user:friend" });
	const persona = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	await app.execute("workspace.set", {
		resource: "AGENTS.md",
		text: "长人格".repeat(3000),
		if_match: persona.revision,
	});
	const db = await readFile(join(base, "state.sqlite"));
	const overview = await readFile(join(new Workspaces(base).root(), "MEMORY.md"));
	const context = (await app.execute("context.show", {
		query: "小林喜欢简短的回复",
		profile_ref: "user:owner",
		budget: 400,
	})) as {
		memories: { id: string; body: string; truncated: boolean; reasons: string[] }[];
		documents: { content: string; truncated: boolean }[];
		body_characters: number;
	};
	assert.equal(context.memories[0].id, saved.id);
	assert.ok(context.memories[0].body.length > 0);
	assert.ok(context.memories.every((memory) => memory.id === saved.id));
	assert.ok(context.documents[0].truncated);
	assert.ok(context.body_characters <= 400);
	assert.deepEqual(await readFile(join(base, "state.sqlite")), db);
	assert.deepEqual(await readFile(join(new Workspaces(base).root(), "MEMORY.md")), overview);
	await writeFile(saved.file, "corrupt");
	await assert.rejects(app.execute("context.show", { query: "小林", profile_ref: "user:owner" }), {
		code: "state_corrupt",
	});
	assert.deepEqual(await readFile(join(base, "state.sqlite")), db);
});
