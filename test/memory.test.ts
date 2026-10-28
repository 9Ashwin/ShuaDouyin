import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { withDatabase } from "../src/database.ts";
import type { memories } from "../src/schema.ts";

type Memory = typeof memories.$inferSelect & { file: string };
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-memory-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init");
	return { base, app };
}

test("memory CRUD keeps IDs, references and revision history", async (t) => {
	const { base, app } = await setup(t);
	const first = (await app.execute("memory.add", {
		text: "主人喜欢喝茶",
		layer: "preference",
		subject: "owner",
		topic: "饮品",
		certainty: "user-stated",
		confidence: 1,
		source: "user:chat-1",
	})) as Memory;
	assert.match(first.file, /memory[/\\]preference[/\\]/);
	const raw = await readFile(first.file, "utf8");
	assert.match(raw, /^---\n/);
	assert.match(raw, /sources:/);
	assert.equal(((await app.execute("memory.search", { query: "茶" })) as Memory[])[0].id, first.id);
	assert.equal(((await app.execute("memory.search", { query: "喜欢喝茶" })) as Memory[])[0].id, first.id);
	await assert.rejects(
		app.execute("memory.add", {
			text: "foreign link",
			source: "user:chat",
			links: "00000000-0000-4000-8000-000000000001",
		}),
		{ code: "not_found" },
	);
	await app.execute("memory.add", {
		text: "今天讨论了饮品",
		layer: "experience",
		source: "user:chat-1",
		links: first.id,
	});
	// The explicit link is stored, and the two entries also share a creation day.
	withDatabase(base, (_db, sqlite) =>
		assert.deepEqual(sqlite.prepare("SELECT relation, weight FROM memory_edges ORDER BY relation").all(), [
			{ relation: "refs", weight: 1 },
			{ relation: "same_day", weight: 0.5 },
		]),
	);
	const changed = (await app.execute("memory.update", {
		resource: first.id,
		text: "主人现在喜欢咖啡",
		source: "user:chat-2",
		if_match: first.revision,
	})) as Memory;
	assert.equal(changed.id, first.id);
	assert.notEqual(changed.revision, first.revision);
	assert.deepEqual(await app.execute("memory.search", { query: "喜欢喝茶" }), []);
	assert.equal(((await app.execute("memory.search", { query: "喜欢咖啡" })) as Memory[])[0].id, first.id);
	await assert.rejects(
		app.execute("memory.update", {
			resource: first.id,
			text: "stale",
			source: "user:chat-3",
			if_match: first.revision,
		}),
		{ code: "revision_conflict" },
	);
	assert.equal(((await app.execute("memory.history", { resource: first.id })) as unknown[]).length, 2);
	await assert.rejects(app.execute("memory.delete", { resource: first.id, if_match: first.revision }), {
		code: "revision_conflict",
	});
	await app.execute("memory.delete", { resource: first.id, if_match: changed.revision });
	await assert.rejects(readFile(first.file));
	assert.deepEqual(await app.execute("memory.history", { resource: first.id }), []);
});

test("manual Markdown edits are indexed and a corrupt file cannot clear the old index", async (t) => {
	const { base, app } = await setup(t);
	const first = (await app.execute("memory.add", { text: "原始经历", source: "user:task" })) as Memory;
	const original = await readFile(first.file, "utf8");
	await writeFile(first.file, original.replaceAll("\n", "\r\n"));
	assert.equal(((await app.execute("memory.get", { resource: first.id })) as Memory).body, "原始经历");
	// Rewrite only the body. The file is `---\n<yaml>---\n<body>` and the title
	// is derived from the body, so replacing the first occurrence of the text in
	// the whole file would hit the frontmatter title and leave the body
	// untouched — the test would then be checking nothing.
	const closing = original.indexOf("\n---\n");
	assert.ok(closing > 0, "frontmatter should close with ---");
	const edited = `${original.slice(0, closing + 5)}${original
		.slice(closing + 5)
		.replace("原始经历", "手工修改的新经历")}`;
	assert.ok(edited.includes("手工修改的新经历"));
	assert.ok(edited.includes("title: 原始经历"));
	await writeFile(first.file, edited);
	assert.equal(((await app.execute("memory.search", { query: "新经历" })) as Memory[])[0].id, first.id);
	await writeFile(first.file, "broken memory");
	await assert.rejects(app.execute("memory.reindex"), { code: "state_corrupt" });
	withDatabase(base, (_db, sqlite) =>
		assert.deepEqual(sqlite.prepare("SELECT body FROM memory_nodes WHERE id = ?").get(first.id), {
			body: "手工修改的新经历",
		}),
	);
	await writeFile(first.file, original);
	await unlink(first.file);
	await app.execute("memory.reindex");
	assert.deepEqual(await app.execute("memory.list"), []);
});

test("persona, profiles and report updates preserve edits and require current revisions", async (t) => {
	const { app } = await setup(t);
	const file = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	await assert.rejects(app.execute("workspace.set", { resource: "AGENTS.md", text: "# New persona" }), {
		code: "revision_required",
	});
	await app.execute("workspace.set", { resource: "AGENTS.md", text: "# My persona", if_match: file.revision });
	const context = (await app.execute("context.show")) as { bot: { id: string }; documents: { content: string }[] };
	assert.equal(context.bot.id, "default");
	assert.equal(context.documents[0].content, "# My persona");
	const report = (await app.execute("report.save", { resource: "2026-10-26", text: "# 实际见闻" })) as {
		revision: string;
	};
	await assert.rejects(app.execute("report.save", { resource: "2026-10-26", text: "overwrite" }), {
		code: "revision_required",
	});
	await app.execute("report.save", { resource: "2026-10-26", text: "# 修订见闻", if_match: report.revision });
	assert.equal(((await app.execute("report.list")) as unknown[]).length, 1);
	await assert.rejects(app.execute("report.save", { resource: "2026-02-30", text: "invalid" }), {
		code: "invalid_argument",
	});
	assert.match(await readFile(join(app.store.base, "PROFILES.md"), "utf8"), /待核对印象/);
	// A hand edit to PROFILES.md survives, because no command regenerates it.
	await writeFile(join(app.store.base, "PROFILES.md"), "# 我的人物档案\n");
	const restored = (await app.execute("workspace.get", { resource: "PROFILES.md" })) as { content: string };
	assert.equal(restored.content, "# 我的人物档案\n");
});

test("context returns explicit excerpts without rewriting long memory bodies", async (t) => {
	const { app } = await setup(t);
	const body = "长期经历".repeat(400);
	const saved = (await app.execute("memory.add", { text: body, source: "user:long-note" })) as Memory;
	const context = (await app.execute("context.show")) as {
		memories: { id: string; body: string; truncated: boolean }[];
	};
	assert.equal(context.memories[0].id, saved.id);
	assert.equal(context.memories[0].body.length, 1000);
	assert.equal(context.memories[0].truncated, true);
	assert.equal(((await app.execute("memory.get", { resource: saved.id })) as Memory).body, body);
});

test("context budget bounds document and memory bodies across the whole response", async (t) => {
	const { app } = await setup(t);
	const saved = (await app.execute("memory.add", { text: "长记忆🙂".repeat(100), source: "user:note" })) as Memory;
	const context = (await app.execute("context.show", { budget: 100 })) as {
		documents: { content: string; truncated: boolean }[];
		memories: { body: string; truncated: boolean }[];
		body_budget: number;
		body_characters: number;
	};
	const total =
		context.documents.reduce((sum, item) => sum + Array.from(item.content).length, 0) +
		context.memories.reduce((sum, item) => sum + Array.from(item.body).length, 0);
	assert.equal(context.body_budget, 100);
	assert.equal(context.body_characters, total);
	assert.ok(total <= 100);
	assert.ok(context.documents.some((item) => item.truncated));
	assert.ok(context.memories[0].truncated);
	assert.equal(((await app.execute("memory.get", { resource: saved.id })) as Memory).body, saved.body);
	await assert.rejects(app.execute("context.show", { budget: 99 }), { code: "invalid_argument" });
});

test("an insight is a separate kind of memory from the observation it came from", async (t) => {
	const { app } = await setup(t);
	const profile = "user:MS4wLjABAAAAperson01";
	const insight = (await app.execute("memory.add", {
		text: "他两次提到价格，一次问报价，一次说预算有限。",
		layer: "relationship",
		profile_ref: profile,
		subject: "MS4wLjABAAAAperson01",
		memory_type: "insight",
		source: "event:default:aaa",
		topic: "价格",
	})) as { id: string; type: string };
	assert.equal(insight.type, "insight");
	const summed = (await app.execute("memory.add", {
		text: "比起外观，他更在意预算。",
		layer: "relationship",
		profile_ref: profile,
		subject: "MS4wLjABAAAAperson01",
		memory_type: "profile",
		links: insight.id,
		source: "event:default:bbb",
		topic: "画像",
	})) as { id: string; type: string };
	assert.equal(summed.type, "profile");
	// Deleting the insight leaves the profile readable, but it must say the
	// support is gone rather than letting the conclusion stand unbacked.
	const current = (await app.execute("memory.get", { resource: insight.id })) as { revision: string };
	const removed = (await app.execute("memory.delete", {
		resource: insight.id,
		if_match: current.revision,
	})) as { dependents: { id: string; type: string }[] };
	assert.equal(removed.dependents.length, 1);
	assert.equal(removed.dependents[0].id, summed.id);
	assert.equal(removed.dependents[0].type, "profile");
});

test("an unknown memory type is refused with the list", async (t) => {
	const { app } = await setup(t);
	await assert.rejects(
		app.execute("memory.add", {
			text: "x",
			memory_type: "guess",
			source: "event:default:ccc",
		}),
		{ code: "invalid_argument" },
	);
});
