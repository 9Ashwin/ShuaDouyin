import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { withDatabase } from "../src/database.ts";
import { Workspaces } from "../src/workspace.ts";

async function setup(t: test.TestContext, name: string) {
	const base = await mkdtemp(join(tmpdir(), `dy-${name}-`));
	t.after(() => rm(base, { recursive: true, force: true }));
	return base;
}

test("one workspace holds the persona, the profile and the database", async (t) => {
	const base = await setup(t, "workspace");
	const app = new App({ state_dir: base });
	const result = (await app.execute("init", { name: "小鱼", preset: "curious" })) as {
		created: boolean;
		workspace: string;
		created_files: string[];
		onboarding: { status: string };
	};
	assert.equal(result.created, true);
	assert.equal(result.workspace, base);
	assert.deepEqual(result.created_files.sort(), ["AGENTS.md", "MEMORY.md", "PROFILES.md", "onboarding.json"]);
	assert.equal(result.onboarding.status, "pending");
	const workspaces = new Workspaces(base);
	assert.equal(workspaces.root(), base);
	const persona = await readFile(join(base, "AGENTS.md"), "utf8");
	for (const heading of ["## 角色", "## 身份与声音", "## 行为准则", "## 工作区", "## 沟通"])
		assert.ok(persona.includes(heading), `missing ${heading}`);
	assert.match(persona, /^# 小鱼/);
	assert.match(persona, /自然、有意思/);
	assert.match(await readFile(join(base, "PROFILES.md"), "utf8"), /待核对印象/);
	withDatabase(base, (_db, sqlite) => {
		assert.equal(sqlite.pragma("journal_mode", { simple: true }), "wal");
		assert.equal(sqlite.pragma("foreign_keys", { simple: true }), 1);
	});
	if (process.platform !== "win32") assert.equal((await stat(join(base, "state.sqlite"))).mode & 0o777, 0o600);
});

test("init never overwrites a file the owner has edited", async (t) => {
	const base = await setup(t, "persona-keep");
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "小鱼", preset: "curious" });
	const persona = join(base, "AGENTS.md");
	const profiles = join(base, "PROFILES.md");
	await writeFile(persona, "user-owned persona");
	await writeFile(profiles, "user-owned profiles");
	const again = (await app.execute("init", { name: "另一个名字", preset: "analyst" })) as {
		created: boolean;
		created_files: string[];
		bot: { name: string };
	};
	assert.equal(again.created, false);
	assert.deepEqual(again.created_files, []);
	// The edited persona has no heading to read a name from, so the reported name
	// falls back to the default instead of inventing one for the repair.
	assert.equal(again.bot.name, "小抖");
	assert.equal(await readFile(persona, "utf8"), "user-owned persona");
	assert.equal(await readFile(profiles, "utf8"), "user-owned profiles");
});

test("a missing persona is regenerated from the requested preset", async (t) => {
	const base = await setup(t, "persona-preset");
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "小鱼", preset: "curious" });
	const path = join(base, "AGENTS.md");
	await rm(path);
	await app.execute("init");
	assert.match(await readFile(path, "utf8"), /沉稳、有观察力/);
	await rm(path);
	await app.execute("init", { preset: "analyst" });
	assert.match(await readFile(path, "utf8"), /简洁、理性/);
	await assert.rejects(app.execute("init", { preset: "__proto__" }), { code: "invalid_argument" });
});

test("workspace documents require the current revision and refuse generated Memory.md", async (t) => {
	const base = await setup(t, "documents");
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "小鱼" });
	const current = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as {
		revision: string;
		content: string;
	};
	assert.equal(current.content.split("\n")[0], "# 小鱼");
	await assert.rejects(app.execute("workspace.set", { resource: "AGENTS.md", text: "# New persona" }), {
		code: "revision_required",
	});
	await assert.rejects(
		app.execute("workspace.set", { resource: "AGENTS.md", text: "# New persona", if_match: "0".repeat(64) }),
		{ code: "revision_conflict" },
	);
	const saved = (await app.execute("workspace.set", {
		resource: "AGENTS.md",
		text: "# New persona",
		if_match: current.revision,
	})) as { revision: string };
	assert.notEqual(saved.revision, current.revision);
	assert.equal(
		((await app.execute("workspace.get", { resource: "AGENTS.md" })) as { content: string }).content,
		"# New persona",
	);
	await assert.rejects(app.execute("workspace.set", { resource: "MEMORY.md", text: "# Hand written" }), {
		code: "invalid_argument",
	});
	await assert.rejects(app.execute("workspace.get", { resource: "reports/2026-02-30.md" }), {
		code: "invalid_argument",
	});
});

test("a customized persona can be recovered from its saved revision", async (t) => {
	const base = await setup(t, "persona-history");
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "小鱼", preset: "curious" });
	const original = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	const saved = (await app.execute("workspace.set", {
		resource: "AGENTS.md",
		text: "自定义人格",
		if_match: original.revision,
	})) as { revision: string };
	const path = join(base, "AGENTS.md");
	await rm(path);
	// Saved revisions exist, so init refuses to guess a persona and points at
	// history instead of silently writing a template over the record.
	await assert.rejects(app.execute("init"), { code: "revision_required" });
	const history = (await app.execute("workspace.history", { resource: "AGENTS.md" })) as { revision: string }[];
	assert.ok(history.some((record) => record.revision === saved.revision));
	const restored = (await app.execute("workspace.restore", {
		resource: "AGENTS.md",
		revision: saved.revision,
	})) as { content: string };
	assert.equal(restored.content, "自定义人格");
	// Restore only fills a gap; it never replaces a file that now exists.
	await assert.rejects(app.execute("workspace.restore", { resource: "AGENTS.md", revision: saved.revision }), {
		code: "revision_conflict",
	});
	await assert.rejects(app.execute("workspace.restore", { resource: "AGENTS.md", revision: "not-a-revision" }), {
		code: "invalid_argument",
	});
	await assert.rejects(app.execute("workspace.history", { resource: "MEMORY.md" }), {
		code: "invalid_argument",
	});
});

test("reports are dated documents with revision checking", async (t) => {
	const base = await setup(t, "reports");
	const app = new App({ state_dir: base });
	await app.execute("init");
	const report = (await app.execute("report.save", { resource: "2026-10-26", text: "# 实际见闻" })) as {
		revision: string;
	};
	assert.equal(report.revision.length, 64);
	await assert.rejects(app.execute("report.save", { resource: "2026-10-26", text: "overwrite" }), {
		code: "revision_required",
	});
	await app.execute("report.save", { resource: "2026-10-26", text: "# 修订见闻", if_match: report.revision });
	const list = (await app.execute("report.list")) as { file: string }[];
	assert.deepEqual(
		list.map((entry) => entry.file),
		["2026-10-26.md"],
	);
	await assert.rejects(app.execute("report.save", { resource: "2026-02-30", text: "invalid" }), {
		code: "invalid_argument",
	});
});
