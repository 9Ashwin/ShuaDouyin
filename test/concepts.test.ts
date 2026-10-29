import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";
import { parse } from "yaml";
import { App } from "../src/app.ts";
import { withDatabase } from "../src/database.ts";
import { nodeSlug, parseLinks, slugify } from "../src/memory.ts";
import type { edges, memories } from "../src/schema.ts";
import { Workspaces } from "../src/workspace.ts";

type Memory = typeof memories.$inferSelect & { file: string };
type Edge = typeof edges.$inferSelect;

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-concepts-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init", { name: "ShuaDouyin" });
	return { base, app: new App({ state_dir: base }) };
}

function relations(base: string): Edge[] {
	return withDatabase(
		base,
		(_db, sqlite) =>
			sqlite
				.prepare("SELECT relation, weight, source_id, target_id FROM memory_edges ORDER BY relation")
				.all() as Edge[],
	);
}

test("slugs and wiki links use stable label rules", () => {
	assert.equal(slugify("  Oolong Tea!  "), "oolong-tea");
	assert.equal(slugify("表达 偏好"), "表达-偏好");
	assert.equal(slugify("---"), "");
	assert.equal(nodeSlug("bot:abc", "Owner", "tea"), "owner");
	assert.equal(nodeSlug("bot:abc", "", "tea"), "tea");
	assert.equal(nodeSlug("bot:abc", "", ""), "abc");
	assert.deepEqual(parseLinks("见 [[Oolong Tea]] 与 [x](../context/tea-stack.md) 和 https://example.com/a.md"), [
		"oolong-tea",
		"tea-stack",
	]);
});

test("concept frontmatter carries type, title, tags and profile_ref", async (t) => {
	const { app } = await setup(t);
	const saved = (await app.execute("memory.add", {
		text: "主人明确希望回答简洁",
		layer: "preference",
		subject: "user",
		topic: "表达偏好",
		profile_ref: "user:owner",
		tags: "表达,偏好",
		certainty: "user-stated",
		confidence: 1,
		source: "user:chat-1",
	})) as Memory;
	assert.equal(saved.type, "memory");
	// The topic names what the memory says; the subject only says who it is about.
	// A title taken from the subject turned every memory about a person into that
	// person's id, which tells a reader nothing.
	assert.equal(saved.title, "表达偏好");
	assert.deepEqual(saved.tags, ["表达", "偏好"]);
	assert.equal(saved.profile_ref, "user:owner");
	const raw = await readFile(saved.file, "utf8");
	assert.match(raw, /^---\ntype: memory\n/);
	assert.match(raw, /profile_ref: user:owner/);
	assert.match(raw, /\ntags:\n\s+- 表达\n/);
	// A field with nothing in it is left out, so the frontmatter a reader has to
	// scan past stays as short as the memory it describes.
	assert.doesNotMatch(raw, /^links: \[\]$/m);
	assert.doesNotMatch(raw, /^profile_ref: ""$/m);
	await assert.rejects(app.execute("memory.add", { text: "x", source: "user:1", profile_ref: "owner" }), {
		code: "invalid_argument",
	});
	await assert.rejects(app.execute("memory.add", { text: "x", source: "user:1", tags: "a,,b" }), {
		code: "invalid_argument",
	});
});

test("an old title taken from the subject is re-derived, a written one is kept", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "identity");
	await mkdir(directory, { recursive: true });
	const file = join(directory, "subject-title.md");
	// Files written before the derivation changed carry the subject as their
	// title. Nobody wrote that, so an edit should replace it.
	await writeFile(
		file,
		[
			"---",
			"type: memory",
			"title: user:7",
			"id: mem_subject_title",
			"layer: identity",
			"subject: user:7",
			"topic: 上班时间",
			"sources:",
			"  - user:1",
			"created_at: 2026-10-01T00:00:00.000Z",
			"updated_at: 2026-10-01T00:00:00.000Z",
			"---",
			"他早上八点上班。",
			"",
		].join("\n"),
	);
	await app.execute("memory.reindex");
	const saved = (await app.execute("memory.get", { resource: "mem_subject_title" })) as Memory;
	const updated = (await app.execute("memory.update", {
		resource: saved.id,
		text: "他早上七点上班。",
		source: "user:2",
		if_match: saved.revision,
	})) as Memory;
	assert.equal(updated.title, "上班时间");

	const written = join(directory, "written-title.md");
	await writeFile(
		written,
		[
			"---",
			"type: memory",
			"title: 自己写的标题",
			"id: mem_written_title",
			"layer: identity",
			"subject: user:8",
			"sources:",
			"  - user:1",
			"created_at: 2026-10-01T00:00:00.000Z",
			"updated_at: 2026-10-01T00:00:00.000Z",
			"---",
			"另一个人的事。",
			"",
		].join("\n"),
	);
	await app.execute("memory.reindex");
	const kept = (await app.execute("memory.get", { resource: "mem_written_title" })) as Memory;
	const edited = (await app.execute("memory.update", {
		resource: kept.id,
		text: "另一个人的另一件事。",
		source: "user:2",
		if_match: kept.revision,
	})) as Memory;
	assert.equal(edited.title, "自己写的标题");
});

test("clearing a field removes its line instead of writing an empty one", async (t) => {
	const { app } = await setup(t);
	const saved = (await app.execute("memory.add", {
		text: "先有话题",
		topic: "话题",
		source: "user:1",
	})) as Memory;
	assert.match(await readFile(saved.file, "utf8"), /^topic: 话题$/m);
	const cleared = (await app.execute("memory.update", {
		resource: saved.id,
		text: "先有话题",
		topic: "",
		source: "user:2",
		if_match: saved.revision,
	})) as Memory;
	assert.doesNotMatch(await readFile(saved.file, "utf8"), /^topic:/m);
	assert.equal(cleared.topic, "");
	// The memory still decodes: the omitted keys fell back to their defaults.
	assert.equal(((await app.execute("memory.get", { resource: saved.id })) as Memory).body, "先有话题");
});

test("profile_ref filters retrieval and scopes context to one person", async (t) => {
	const { app } = await setup(t);
	const owner = (await app.execute("memory.add", {
		text: "主人喜欢喝茶",
		profile_ref: "user:owner",
		layer: "preference",
		source: "user:1",
	})) as Memory;
	await app.execute("memory.add", {
		text: "另一个人喜欢咖啡",
		profile_ref: "user:friend",
		layer: "preference",
		source: "user:2",
	});
	const scoped = (await app.execute("memory.search", { profile_ref: "user:owner" })) as Memory[];
	assert.deepEqual(
		scoped.map((row) => row.id),
		[owner.id],
	);
	const context = (await app.execute("context.show", {
		profile_ref: "user:owner",
	})) as {
		memories: { id: string }[];
		profile_ref: string;
		documents: { file: string; content: string }[];
		omitted_documents: string[];
	};
	assert.equal(context.profile_ref, "user:owner");
	assert.deepEqual(
		context.memories.map((row) => row.id),
		[owner.id],
	);
	assert.deepEqual(
		context.documents.map((doc) => doc.file),
		["AGENTS.md"],
	);
	assert.deepEqual(context.omitted_documents, ["PROFILES.md", "MEMORY.md"]);
	assert.ok(!JSON.stringify(context).includes("另一个人喜欢咖啡"));
	await assert.rejects(app.execute("context.show", { profile_ref: "" }), { code: "invalid_argument" });
	await assert.rejects(app.execute("context.show", { profile_ref: "owner" }), { code: "invalid_argument" });
	const unfiltered = (await app.execute("context.show")) as { documents: { file: string }[] };
	assert.deepEqual(
		unfiltered.documents.map((doc) => doc.file),
		["AGENTS.md", "PROFILES.md", "MEMORY.md"],
	);
});

test("legacy memory files stay readable and index with derived defaults", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(directory, { recursive: true });
	await writeFile(
		join(directory, "legacy.md"),
		[
			"---",
			"id: 11111111-2222-3333-4444-555555555555",
			"layer: note",
			"subject: owner",
			"topic: 旧格式",
			"certainty: observed",
			"confidence: 0.4",
			"sources:",
			"  - video:old",
			"links: []",
			"created_at: 2026-10-01T00:00:00.000Z",
			"updated_at: 2026-10-01T00:00:00.000Z",
			"---",
			"旧格式正文",
			"",
		].join("\n"),
	);
	const read = (await app.execute("memory.get", { resource: "11111111-2222-3333-4444-555555555555" })) as Memory;
	assert.equal(read.body, "旧格式正文");
	assert.equal(read.type, "memory");
	// The topic is what the file is about; the subject is who. A missing title is
	// derived from the former.
	assert.equal(read.title, "旧格式");
	assert.deepEqual(read.tags, []);
	assert.equal(read.profile_ref, "");
});

test("agent-authored concept files retain stable IDs and metadata on ingest", async (t) => {
	const { base, app } = await setup(t);
	const dir = join(new Workspaces(base).root(), "memory", "preference");
	await mkdir(dir, { recursive: true });
	const file = join(dir, "owner-tea.md");
	const content = [
		"---",
		"type: memory",
		"title: Owner likes tea # preserve title note",
		"id: mem_20261027_tea",
		"layer: preference",
		"tags:",
		"  - tea # preserve tag note",
		"confidence: 0.8",
		"timestamp: 2026-10-27T01:02:03Z",
		"hash: old-hash",
		"custom_flag: kept",
		"sources:",
		"  - file:memory/preference/owner-tea.md # preserve source note",
		"metadata:",
		"  profile_ref: user:owner",
		"  topic: tea # preserve topic note",
		"  layer: preference",
		"  confidence: 0.8",
		"  origin:",
		"    channel: conversation",
		"---",
		"",
		"主人喜欢茶。",
		"",
	].join("\n");
	await writeFile(file, content);
	const first = (await app.execute("memory.ingest")) as { ingested: number; failed: unknown[] };
	assert.equal(first.ingested, 1);
	assert.deepEqual(first.failed, []);
	assert.equal(await readFile(file, "utf8"), content);
	const saved = (await app.execute("memory.get", { resource: "mem_20261027_tea" })) as Memory;
	assert.equal(saved.profile_ref, "user:owner");
	assert.equal(saved.topic, "tea");
	assert.deepEqual(saved.sources, ["file:memory/preference/owner-tea.md"]);
	const second = (await app.execute("memory.ingest")) as { ingested: number; skipped: number };
	assert.deepEqual([second.ingested, second.skipped], [0, 1]);
	await app.execute("memory.add", { text: "related", source: "user:1", links: saved.id });
	const updated = (await app.execute("memory.update", {
		resource: saved.id,
		text: "主人喜欢茶和咖啡。",
		source: "user:2",
		confidence: 0.9,
		if_match: saved.revision,
	})) as Memory;
	assert.equal(updated.id, saved.id);
	assert.equal(updated.profile_ref, "user:owner");
	assert.equal(updated.title, "Owner likes tea");
	const firstHeader = parse((await readFile(file, "utf8")).split("---\n")[1]) as {
		timestamp: string;
		hash: string;
		custom_flag: string;
		metadata: { origin: { channel: string }; layer: string; confidence: number };
	};
	assert.match(await readFile(file, "utf8"), /# preserve title note/);
	assert.match(await readFile(file, "utf8"), /# preserve topic note/);
	assert.match(await readFile(file, "utf8"), /# preserve tag note/);
	assert.match(await readFile(file, "utf8"), /# preserve source note/);
	assert.equal(firstHeader.timestamp, "2026-10-27T01:02:03Z");
	assert.equal(firstHeader.custom_flag, "kept");
	assert.equal(firstHeader.metadata.origin.channel, "conversation");
	assert.equal(firstHeader.metadata.layer, "preference");
	assert.equal(firstHeader.metadata.confidence, 0.9);
	assert.equal(firstHeader.hash, createHash("sha256").update("主人喜欢茶和咖啡。").digest("hex"));
	const facts = [{ text: "主人喜欢茶和咖啡与水", sources: ["user:3"], profile_ref: "user:owner" }];
	await app.execute("memory.decide", {
		text: JSON.stringify({
			facts,
			decision: {
				action: "UPDATE",
				source_fact_indices: [0],
				id: saved.id,
				revision: updated.revision,
				text: facts[0].text,
			},
		}),
		apply: true,
		request_id: "metadata-decision-001",
	});
	const afterDecision = parse((await readFile(file, "utf8")).split("---\n")[1]) as typeof firstHeader;
	assert.equal(afterDecision.metadata.origin.channel, "conversation");
	assert.equal(afterDecision.timestamp, firstHeader.timestamp);
	assert.equal(afterDecision.hash, createHash("sha256").update(facts[0].text).digest("hex"));
	const current = (await app.execute("memory.get", { resource: saved.id })) as Memory;
	await app.execute("memory.update", {
		resource: saved.id,
		text: "\u0085[茶](../note/tea.md)\u0085",
		source: "user:4",
		if_match: current.revision,
	});
	const linkedHeader = parse((await readFile(file, "utf8")).split("---\n")[1]) as typeof firstHeader;
	assert.equal(linkedHeader.hash, createHash("sha256").update("[[tea]]").digest("hex"));
	const next = (await app.execute("memory.get", { resource: saved.id })) as Memory;
	await app.execute("memory.update", {
		resource: saved.id,
		text: "[数字](../note/m².md)",
		source: "user:5",
		if_match: next.revision,
	});
	const unicodeHeader = parse((await readFile(file, "utf8")).split("---\n")[1]) as typeof firstHeader;
	assert.equal(unicodeHeader.hash, createHash("sha256").update("[[m]]").digest("hex"));
	const greek = (await app.execute("memory.get", { resource: saved.id })) as Memory;
	await app.execute("memory.update", {
		resource: saved.id,
		text: "[希腊](../note/ΟΣ.md)",
		source: "user:6",
		if_match: greek.revision,
	});
	const greekHeader = parse((await readFile(file, "utf8")).split("---\n")[1]) as typeof firstHeader;
	assert.equal(greekHeader.hash, createHash("sha256").update("[[οσ]]").digest("hex"));
});

test("derived edges cover profile, topic, day and body links without self loops", async (t) => {
	const { base, app } = await setup(t);
	const first = (await app.execute("memory.add", {
		text: "主人喜欢喝茶",
		layer: "preference",
		subject: "owner",
		topic: "饮品",
		profile_ref: "user:owner",
		source: "user:1",
	})) as Memory;
	const second = (await app.execute("memory.add", {
		text: "今天聊到 [[owner]] 的偏好",
		layer: "experience",
		subject: "self",
		topic: "饮品",
		profile_ref: "user:owner",
		source: "user:2",
	})) as Memory;
	const found = relations(base);
	const kinds = new Set(found.map((edge) => edge.relation));
	assert.deepEqual([...kinds].sort(), ["refs", "same_day", "same_profile", "same_topic"]);
	assert.equal(found.find((edge) => edge.relation === "same_profile")?.weight, 1);
	assert.equal(found.find((edge) => edge.relation === "same_topic")?.weight, 0.8);
	assert.ok(found.every((edge) => edge.source_id !== edge.target_id));
	assert.ok(found.every((edge) => edge.source_id < edge.target_id || edge.relation === "refs"));
	// The body link resolves to the entry whose slug is "owner".
	const ref = found.find((edge) => edge.relation === "refs");
	assert.deepEqual([ref?.source_id, ref?.target_id], [second.id, first.id]);
});

test("relative references protect paths from compaction and expose missing targets", async (t) => {
	const { app } = await setup(t);
	const first = (await app.execute("memory.add", { text: "共同事实", subject: "alpha", source: "user:one" })) as Memory;
	let second = (await app.execute("memory.add", {
		text: "共同事实",
		subject: "alpha",
		source: "user:two",
	})) as Memory;
	const moved = join(dirname(second.file), process.platform === "win32" ? "alpha(2)x.md" : "alpha(2)>x.md");
	await rename(second.file, moved);
	second = (await app.execute("memory.get", { resource: second.id })) as Memory;
	const source = (await app.execute("memory.add", {
		text: `锚点信息 [目标](<../note/${encodeURIComponent(basename(second.file))}#section> "说明")`,
		layer: "experience",
		source: "user:three",
		links: first.id,
	})) as Memory;
	const graph = (await app.execute("memory.graph")) as { edges: Edge[]; unresolved: unknown[] };
	assert.ok(
		graph.edges.some(
			(edge) => edge.source_id === source.id && edge.target_id === second.id && edge.relation === "refs",
		),
	);
	for (const link of [
		`[目标](../note/${basename(second.file)} "说明")`,
		`[目标](../note/${basename(second.file)} '说明')`,
		`[目标](../note/${basename(second.file)} (说明))`,
		`[相关][target]\n\n[target]: ../note/${basename(second.file)}`,
		`[target][]\n\n[target]: <../note/${basename(second.file)}>`,
		`[target]\n\n[target]: ../note/${basename(second.file)}`,
		`<a href="../note/${basename(second.file)}">目标</a>`,
	]) {
		const current = (await app.execute("memory.get", { resource: source.id })) as Memory;
		await app.execute("memory.update", {
			resource: source.id,
			text: `锚点信息 ${link}`,
			source: "user:three",
			if_match: current.revision,
		});
		const updatedGraph = (await app.execute("memory.graph")) as { edges: Edge[] };
		assert.ok(
			updatedGraph.edges.some(
				(edge) => edge.source_id === source.id && edge.target_id === second.id && edge.relation === "refs",
			),
			link,
		);
	}
	const context = (await app.execute("context.show", { query: "锚点信息", limit: 10 })) as {
		memories: { id: string; reasons: string[] }[];
	};
	assert.ok(context.memories.some((item) => item.id === second.id && item.reasons.includes("ref_neighbor")));
	const currentSource = (await app.execute("memory.get", { resource: source.id })) as Memory;
	await app.execute("memory.update", {
		resource: source.id,
		text: `锚点信息 [目标](../note/${basename(second.file).toUpperCase()})`,
		source: "user:three",
		if_match: currentSource.revision,
	});
	const plan = (await app.execute("memory.compact", { dry_run: true })) as { merged: number };
	assert.equal(plan.merged, 0);
	await assert.rejects(
		app.execute("memory.update", {
			resource: second.id,
			text: second.body,
			source: "user:two",
			layer: "preference",
			if_match: second.revision,
		}),
		{ code: "revision_conflict" },
	);
	await app.execute("memory.delete", { resource: second.id, if_match: second.revision });
	await app.execute("memory.delete", { resource: first.id, if_match: first.revision });
	const status = (await app.execute("memory.status")) as {
		healthy: boolean;
		unresolved: { source_id: string; kind: string }[];
	};
	assert.equal(status.healthy, false);
	assert.ok(status.unresolved.some((issue) => issue.source_id === source.id && issue.kind === "path"));
	assert.ok(status.unresolved.some((issue) => issue.source_id === source.id && issue.kind === "id"));
	const broken = (await app.execute("memory.get", { resource: source.id })) as Memory;
	await app.execute("memory.update", {
		resource: source.id,
		text: "已移除无效关联",
		source: "user:three",
		links: "",
		if_match: broken.revision,
	});
	assert.equal(((await app.execute("memory.status")) as { healthy: boolean }).healthy, true);
});

test("compaction preserves custom metadata and does not merge distinct metadata", async (t) => {
	const { app } = await setup(t);
	const a = (await app.execute("memory.add", { text: "重复事实", subject: "same", source: "user:one" })) as Memory;
	const b = (await app.execute("memory.add", { text: "重复事实", subject: "same", source: "user:two" })) as Memory;
	for (const [file, value] of [
		[a.file, "one"],
		[b.file, "two"],
	]) {
		const content = await readFile(file, "utf8");
		await writeFile(file, content.replace("---\n", `---\nmetadata:\n  custom: ${value}\n`));
	}
	assert.equal(((await app.execute("memory.compact", { dry_run: true })) as { merged: number }).merged, 0);
	await writeFile(b.file, (await readFile(b.file, "utf8")).replace("custom: two", "custom: one"));
	assert.equal(((await app.execute("memory.compact")) as { merged: number }).merged, 1);
	const remaining = (await app.execute("memory.list")) as Memory[];
	assert.equal(remaining.length, 1);
	assert.match(await readFile(remaining[0].file, "utf8"), /custom: one/);
});

test("ambiguous wiki references prevent compaction from guessing their target", async (t) => {
	const { app } = await setup(t);
	await app.execute("memory.add", { text: "重复内容", subject: "alpha", source: "user:one" });
	await app.execute("memory.add", { text: "重复内容", subject: "alpha", source: "user:two" });
	await app.execute("memory.add", { text: "参见 [[alpha]]", subject: "source", source: "user:three" });
	const graph = (await app.execute("memory.graph")) as { unresolved: { kind: string; reason: string }[] };
	assert.ok(graph.unresolved.some((issue) => issue.kind === "wiki" && issue.reason === "ambiguous"));
	assert.equal(((await app.execute("memory.compact", { dry_run: true })) as { merged: number }).merged, 0);
});

test("compaction checks UTF-8 output size before modifying any files", async (t) => {
	const { app } = await setup(t);
	const a = (await app.execute("memory.add", { text: "相同事实", subject: "same", source: "user:one" })) as Memory;
	const b = (await app.execute("memory.add", { text: "相同事实", subject: "same", source: "user:two" })) as Memory;
	const aContent = (await readFile(a.file, "utf8")).replace("user:one", `user:${"甲".repeat(50000)}`);
	const bContent = (await readFile(b.file, "utf8")).replace("user:two", `user:${"乙".repeat(50000)}`);
	await writeFile(a.file, aContent);
	await writeFile(b.file, bContent);
	await assert.rejects(app.execute("memory.compact"), { code: "state_corrupt" });
	assert.equal(await readFile(a.file, "utf8"), aContent);
	assert.equal(await readFile(b.file, "utf8"), bContent);
});

test("compaction removes its unpublished archives if an active memory changes", async (t) => {
	const { app } = await setup(t);
	const first = (await app.execute("memory.add", { text: "same", source: "user:one" })) as Memory;
	const second = (await app.execute("memory.add", { text: "same", source: "user:two" })) as Memory;
	const plan = (await app.execute("memory.compact", { dry_run: true })) as {
		plan: { keep: string; superseded: string[] }[];
	};
	const keep = plan.plan[0].keep === first.id ? first : second;
	const victim = plan.plan[0].superseded[0] === first.id ? first : second;
	const originalRename = fs.promises.rename;
	let injected = false;
	try {
		fs.promises.rename = async (from, to) => {
			if (to === keep.file && !injected) {
				injected = true;
				await writeFile(victim.file, (await readFile(victim.file, "utf8")).replace("same", "external change"));
			}
			return originalRename(from, to);
		};
		syncBuiltinESMExports();
		await assert.rejects(app.execute("memory.compact"), { code: "revision_conflict" });
	} finally {
		fs.promises.rename = originalRename;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.match(await readFile(victim.file, "utf8"), /external change/);
	const active = (await app.execute("memory.list")) as Memory[];
	assert.equal(active.length, 2);
});

test("archive collisions preserve external data and clean up only owned unpublished archives", async (t) => {
	const { base, app } = await setup(t);
	for (let index = 0; index < 3; index++) await app.execute("memory.add", { text: "same", source: `user:${index}` });
	const plan = (await app.execute("memory.compact", { dry_run: true })) as { plan: { superseded: string[] }[] };
	const directory = join(new Workspaces(base).root(), "memory", "superseded");
	const own = join(directory, `${plan.plan[0].superseded[0]}.json`);
	const conflict = join(directory, `${plan.plan[0].superseded[1]}.json`);
	const originalLink = fs.promises.link;
	let injected = false;
	try {
		fs.promises.link = async (from, to) => {
			if (to === conflict && !injected) {
				injected = true;
				await writeFile(conflict, "external archive", { flag: "wx" });
			}
			return originalLink(from, to);
		};
		syncBuiltinESMExports();
		await assert.rejects(app.execute("memory.compact"), { code: "state_corrupt" });
	} finally {
		fs.promises.link = originalLink;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.equal(await readFile(conflict, "utf8"), "external archive");
	await assert.rejects(access(own), { code: "ENOENT" });
});

test("compaction keeps the archive when an active path is replaced with a different memory", async (t) => {
	const { app } = await setup(t);
	const a = (await app.execute("memory.add", { text: "same", source: "user:one" })) as Memory;
	const b = (await app.execute("memory.add", { text: "same", source: "user:two" })) as Memory;
	const plan = (await app.execute("memory.compact", { dry_run: true })) as {
		plan: { keep: string; superseded: string[] }[];
	};
	const keep = plan.plan[0].keep === a.id ? a : b;
	const victim = plan.plan[0].superseded[0] === a.id ? a : b;
	const originalRename = fs.promises.rename;
	let injected = false;
	try {
		fs.promises.rename = async (from, to) => {
			if (to === keep.file && !injected) {
				injected = true;
				await writeFile(
					victim.file,
					(await readFile(victim.file, "utf8"))
						.replace(victim.id, "mem_replacement")
						.replace("same", "external replacement"),
				);
			}
			return originalRename(from, to);
		};
		syncBuiltinESMExports();
		await assert.rejects(app.execute("memory.compact"), { code: "revision_conflict" });
	} finally {
		fs.promises.rename = originalRename;
		syncBuiltinESMExports();
	}
	assert.equal(injected, true);
	assert.match(await readFile(victim.file, "utf8"), /external replacement/);
	const archived = (await app.execute("memory.get", { resource: victim.id })) as Memory & { superseded_by: string };
	assert.equal(archived.body, "same");
	assert.equal(archived.superseded_by, keep.id);
});

test("moving a memory never overwrites an unrelated target file", async (t) => {
	const { app } = await setup(t);
	const source = (await app.execute("memory.add", { text: "源记忆", subject: "alpha", source: "user:one" })) as Memory;
	const other = (await app.execute("memory.add", {
		text: "必须保留",
		subject: "other",
		layer: "preference",
		source: "user:two",
	})) as Memory;
	const destination = join(dirname(other.file), `alpha-${source.id}.md`);
	await rename(other.file, destination);
	const destinationContent = await readFile(destination, "utf8");
	const sourceContent = await readFile(source.file, "utf8");
	await assert.rejects(
		app.execute("memory.update", {
			resource: source.id,
			text: "新正文",
			source: "user:one",
			layer: "preference",
			if_match: source.revision,
		}),
		{ code: "revision_conflict" },
	);
	assert.equal(await readFile(destination, "utf8"), destinationContent);
	assert.equal(await readFile(source.file, "utf8"), sourceContent);
	assert.equal(((await app.execute("memory.get", { resource: other.id })) as Memory).body, "必须保留");
	const facts = [{ text: "新正文", sources: ["user:one"] }];
	const decision = JSON.stringify({
		facts,
		decision: {
			action: "UPDATE",
			source_fact_indices: [0],
			id: source.id,
			revision: source.revision,
			text: "新正文",
			layer: "preference",
		},
	});
	await assert.rejects(
		app.execute("memory.decide", { text: decision, apply: true, request_id: "collision-update-001" }),
		{ code: "revision_conflict" },
	);
	assert.equal(await readFile(destination, "utf8"), destinationContent);
});

test("code examples and workspace documents do not create false broken-memory status", async (t) => {
	const { app } = await setup(t);
	await app.execute("memory.add", {
		text: "查看 [人格](../../AGENTS.md)\n\n```md\n[示例](missing.md)\n[[missing]]\n```\n<!-- [注释](other.md) -->",
		source: "user:one",
	});
	const status = (await app.execute("memory.status")) as {
		healthy: boolean;
		unresolved: { target: string; reason: string }[];
	};
	assert.equal(status.healthy, true);
	assert.ok(status.unresolved.some((issue) => issue.reason === "outside_memory"));
	assert.ok(!status.unresolved.some((issue) => issue.target.includes("missing") || issue.target.includes("other")));
});

test("a slug shared by two memories resolves to neither", async (t) => {
	const { base, app } = await setup(t);
	await app.execute("memory.add", { text: "第一份", subject: "owner", layer: "note", source: "user:1" });
	await app.execute("memory.add", { text: "第二份", subject: "owner", layer: "note", source: "user:2" });
	await app.execute("memory.add", { text: "引用 [[owner]]", subject: "reader", layer: "note", source: "user:3" });
	assert.equal(
		relations(base).some((edge) => edge.relation === "refs"),
		false,
	);
	const graph = (await app.execute("memory.graph")) as { nodes: { slug: string }[] };
	assert.equal(graph.nodes.filter((node) => node.slug === "owner").length, 2);
});

test("overview, status and usage describe stored memories", async (t) => {
	const { base, app } = await setup(t);
	const saved = (await app.execute("memory.add", {
		text: "主人希望回答简洁",
		layer: "preference",
		subject: "owner",
		profile_ref: "user:owner",
		source: "user:1",
	})) as Memory;
	const overview = await readFile(join(new Workspaces(base).root(), "MEMORY.md"), "utf8");
	assert.match(overview, /^# Memory\n/);
	// No topic was given, so the title comes from the body rather than from the
	// subject: a list of sec_uids is not a navigable overview.
	assert.match(overview, /1\. \[主人希望回答简洁\]\(memory\/preference\/[^)]+\.md\) 主人希望回答简洁/);
	const status = (await app.execute("memory.status")) as {
		memories: number;
		edges: number;
		indexed: number;
		overview_stale: boolean;
		schema_version: number;
		memory_files: number;
	};
	assert.equal(status.memories, 1);
	assert.equal(status.indexed, 1);
	assert.equal(status.memory_files, 1);
	assert.equal(status.overview_stale, false);
	assert.equal(status.schema_version, 4);
	const usage = (await app.execute("memory.usage")) as { count: number; total_text_bytes: number; profiles: number };
	assert.equal(usage.count, 1);
	assert.equal(usage.total_text_bytes, Buffer.byteLength("主人希望回答简洁", "utf8"));
	assert.equal(usage.profiles, 1);
	// Writing the file by hand makes the overview stale until reconciled.
	await writeFile(saved.file, (await readFile(saved.file, "utf8")).replace("简洁", "详尽"));
	const stale = (await app.execute("memory.status")) as { overview_stale: boolean };
	assert.equal(stale.overview_stale, true);
});

test("compact merges identical bodies only and dry run writes nothing", async (t) => {
	const { base, app } = await setup(t);
	const a = (await app.execute("memory.add", {
		text: "完全相同的正文",
		layer: "note",
		subject: "a",
		tags: "x",
		source: "user:1",
	})) as Memory;
	const b = (await app.execute("memory.add", {
		text: "完全相同的正文",
		layer: "note",
		subject: "a",
		tags: "y",
		source: "user:2",
	})) as Memory;
	await app.execute("memory.add", { text: "语义相近但不同的正文", layer: "note", subject: "c", source: "user:3" });
	const plan = (await app.execute("memory.compact", { dry_run: true })) as {
		before: number;
		merged: number;
		plan: { keep: string; superseded: string[] }[];
	};
	assert.equal(plan.before, 3);
	assert.equal(plan.merged, 1);
	assert.equal(plan.plan.length, 1);
	const before = (await readdir(join(new Workspaces(base).root(), "memory", "note"))).length;
	assert.equal(before, 3);
	assert.equal(((await app.execute("memory.list")) as Memory[]).length, 3);
	const applied = (await app.execute("memory.compact")) as { before: number; after: number; merged: number };
	assert.equal(applied.merged, 1);
	assert.equal(applied.after, 2);
	const kept = (await app.execute("memory.graph")) as { nodes: { id: string }[] };
	const ids = kept.nodes.map((node) => node.id);
	const [older, newer] = [a, b].sort((left, right) => left.created_at.localeCompare(right.created_at));
	assert.ok(ids.includes(older.id));
	assert.equal(ids.includes(newer.id), false);
	const survivor = (await app.execute("memory.get", { resource: older.id })) as Memory;
	assert.deepEqual([...survivor.tags].sort(), ["x", "y"]);
	assert.deepEqual([...survivor.sources].sort(), ["user:1", "user:2"]);
	const archived = (await app.execute("memory.get", { resource: newer.id })) as Memory & { superseded_by: string };
	assert.equal(archived.superseded_by, older.id);
	assert.equal(archived.body, newer.body);
	await app.execute("memory.delete", { resource: older.id, if_match: survivor.revision });
	await assert.rejects(app.execute("memory.get", { resource: newer.id }), { code: "not_found" });
	assert.deepEqual(await app.execute("memory.history", { resource: newer.id }), []);
});

test("status reports a malformed memory layer instead of failing", async (t) => {
	const { base, app } = await setup(t);
	const layer = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(join(new Workspaces(base).root(), "memory"), { recursive: true });
	await rm(layer, { recursive: true, force: true });
	await writeFile(layer, "not a directory");
	const state = (await app.execute("memory.status")) as { healthy: boolean; failed: { file: string }[] };
	assert.equal(state.healthy, false);
	assert.ok(state.failed.some((failure) => failure.file === "memory/note"));
});

test("compact respects people, certainty, exact body and incoming links", async (t) => {
	const { app } = await setup(t);
	const common = { text: "same", subject: "person", source: "user:1" };
	const owner = (await app.execute("memory.add", { ...common, profile_ref: "user:owner" })) as Memory;
	await app.execute("memory.add", { ...common, profile_ref: "user:friend" });
	await app.execute("memory.add", { ...common, profile_ref: "user:owner", certainty: "observed" });
	await app.execute("memory.add", { ...common, profile_ref: "user:owner", text: "same " });
	const other = (await app.execute("memory.add", { ...common, profile_ref: "user:owner" })) as Memory;
	const [keep, referenced] = [owner, other].sort(
		(a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id),
	);
	await app.execute("memory.add", { text: "links to old memory", source: "user:2", links: referenced.id });
	const plan = (await app.execute("memory.compact", { dry_run: true })) as { merged: number };
	assert.equal(plan.merged, 0);
	assert.notEqual(keep.id, referenced.id);
	assert.equal(((await app.execute("memory.graph")) as { nodes: unknown[] }).nodes.length, 6);
});

test("compact checks archive conflicts before changing original files", async (t) => {
	const { base, app } = await setup(t);
	const a = (await app.execute("memory.add", { text: "duplicate", source: "user:1" })) as Memory;
	const b = (await app.execute("memory.add", { text: "duplicate", source: "user:2" })) as Memory;
	const plan = (await app.execute("memory.compact", { dry_run: true })) as {
		plan: { keep: string; superseded: string[] }[];
	};
	const directory = join(new Workspaces(base).root(), "memory", "superseded");
	await mkdir(directory, { recursive: true });
	await writeFile(join(directory, `${plan.plan[0].superseded[0]}.json`), "unrelated archive");
	const beforeA = await readFile(a.file, "utf8");
	const beforeB = await readFile(b.file, "utf8");
	await assert.rejects(app.execute("memory.compact"), { code: "state_corrupt" });
	assert.equal(await readFile(a.file, "utf8"), beforeA);
	assert.equal(await readFile(b.file, "utf8"), beforeB);
});

test("compact checks merged size before changing original files", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(directory, { recursive: true });
	const files = ["a", "b"].map((id) => join(directory, `${id}.md`));
	const contents = ["a", "b"].map((id) =>
		[
			"---",
			"type: memory",
			"title: same",
			`id: mem_${id}`,
			"layer: note",
			"certainty: inferred",
			"confidence: 0.5",
			"sources:",
			`  - ${id}${"x".repeat(70000)}`,
			"created_at: 2026-10-27T00:00:00Z",
			"updated_at: 2026-10-27T00:00:00Z",
			"---",
			"same",
			"",
		].join("\n"),
	);
	await Promise.all(files.map((file, index) => writeFile(file, contents[index])));
	await assert.rejects(app.execute("memory.compact"), { code: "state_corrupt" });
	assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), contents);
});

test("ingest rejects reuse of an archived memory ID", async (t) => {
	const { app } = await setup(t);
	const a = (await app.execute("memory.add", { text: "duplicate", source: "user:1" })) as Memory;
	const b = (await app.execute("memory.add", { text: "duplicate", source: "user:2" })) as Memory;
	const originals = new Map([
		[a.id, await readFile(a.file, "utf8")],
		[b.id, await readFile(b.file, "utf8")],
	]);
	const plan = (await app.execute("memory.compact", { dry_run: true })) as { plan: { superseded: string[] }[] };
	const oldId = plan.plan[0].superseded[0];
	const old = oldId === a.id ? a : b;
	await app.execute("memory.compact");
	await writeFile(old.file, originals.get(oldId) ?? "");
	const result = (await app.execute("memory.ingest")) as { failed: { file: string }[] };
	assert.ok(result.failed.some((entry) => old.file.replaceAll("\\", "/").endsWith(entry.file)));
	await assert.rejects(app.execute("memory.reindex"), { code: "state_corrupt" });
});

test("ingest reports valid and malformed files without clearing the rest", async (t) => {
	const { base, app } = await setup(t);
	const valid = (await app.execute("memory.add", { text: "有效记忆", source: "user:1" })) as Memory;
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await writeFile(join(directory, "broken.md"), "---\nid: not-a-uuid\n---\nbroken\n");
	const result = (await app.execute("memory.ingest")) as {
		ingested: number;
		skipped: number;
		failed: { file: string; reason: string }[];
	};
	assert.equal(result.ingested, 0);
	assert.equal(result.skipped, 2);
	assert.deepEqual(result.failed, [{ file: "memory/note/broken.md", reason: "state_corrupt" }]);
	// Ingest keeps valid entries indexed; strict reconcile still refuses.
	withDatabase(base, (_db, sqlite) =>
		assert.deepEqual(sqlite.prepare("SELECT id FROM memory_nodes").all(), [{ id: valid.id }]),
	);
	await assert.rejects(app.execute("memory.reindex"), { code: "state_corrupt" });
	await writeFile(join(directory, "broken.md"), "");
	await rm(join(directory, "broken.md"));
	const clean = (await app.execute("memory.ingest")) as { ingested: number; skipped: number };
	assert.deepEqual([clean.ingested, clean.skipped], [0, 1]);
});

test("damaged indexed memory survives ingest and diagnostics do not rewrite the overview", async (t) => {
	const { base, app } = await setup(t);
	const saved = (await app.execute("memory.add", { text: "已有记忆", source: "user:1" })) as Memory;
	const overview = join(new Workspaces(base).root(), "MEMORY.md");
	const original = await readFile(saved.file, "utf8");
	await writeFile(saved.file, "---\nid: invalid\n---\nbroken\n");
	await writeFile(overview, "user marker\n");
	const result = (await app.execute("memory.ingest")) as { failed: unknown[]; indexed: number };
	assert.equal(result.failed.length, 1);
	assert.equal(result.indexed, 1);
	withDatabase(base, (_db, sqlite) =>
		assert.deepEqual(sqlite.prepare("SELECT id,body FROM memory_nodes").all(), [{ id: saved.id, body: saved.body }]),
	);
	const state = (await app.execute("memory.status")) as { healthy: boolean; failed: unknown[] };
	assert.equal(state.healthy, false);
	assert.equal(state.failed.length, 1);
	const resultUsage = (await app.execute("memory.usage")) as { count: number; failed: unknown[] };
	assert.equal(resultUsage.count, 0);
	assert.equal(resultUsage.failed.length, 1);
	assert.equal(await readFile(overview, "utf8"), "user marker\n");
	await writeFile(saved.file, original);
	const restored = (await app.execute("memory.ingest")) as { ingested: number; skipped: number; failed: unknown[] };
	assert.deepEqual([restored.ingested, restored.skipped, restored.failed.length], [0, 1, 0]);
});
