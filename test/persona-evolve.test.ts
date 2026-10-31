import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import {
	applySection,
	deriveVoice,
	eventsAsComments,
	evolvePersona,
	migratePersona,
	SECTION,
} from "../src/operations/persona-evolve.ts";
import { profileVoice } from "../src/voice.ts";
import { RETIRED_FIXED_LINE, Workspaces } from "../src/workspace.ts";

// The persona is meant to grow from what the account actually wrote. These tests
// pin the two properties that make that safe: only the derived section is
// rewritten, and nothing is written that was not measured.

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-persona-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init", { name: "ShuaDouyin" });
	return { base, workspaces: new Workspaces(base) };
}

// Comments spread across days by default: a voice is what stays the same across
// days, so the section waits for writing that spans more than one session.
const comments = (texts: string[], spanDays = 3) =>
	texts.map((text, index) => ({
		operation: "comment.post",
		bot_id: "default",
		at: new Date(
			Date.parse("2026-01-01T00:00:00.000Z") + index * (spanDays / Math.max(1, texts.length)) * 86_400_000,
		).toISOString(),
		data: { text },
	}));

test("only the named section is replaced, the owner's text is carried through", () => {
	// This is the property that makes an automatic rewrite acceptable: a persona
	// someone edited by hand keeps every word outside the section.
	const original = "# 小抖\n\n## 角色\n\n我是我自己写的角色。\n\n## 行为准则\n\n- 不要乱发。\n";
	const applied = applySection(original, "- 写得短");
	assert.equal(applied.before, null);
	assert.ok(applied.content.startsWith(original));
	assert.ok(applied.content.includes(`${SECTION}\n\n- 写得短`));
	const again = applySection(applied.content, "- 写得更短");
	assert.equal(again.before, `${SECTION}\n\n- 写得短\n`);
	assert.ok(again.content.includes("我是我自己写的角色。"));
	assert.ok(again.content.includes("- 不要乱发。"));
	assert.ok(!again.content.includes("- 写得短\n-"));
});

test("a section already saying the same thing is not rewritten", async (t) => {
	const { workspaces } = await setup(t);
	const events = comments(["这条不错", "挺有意思的", "哈哈哈", "说得对", "确实这样"]);
	const first = await evolvePersona(workspaces, { events: async () => events });
	assert.equal(first.changed, true);
	const second = await evolvePersona(workspaces, { events: async () => events });
	assert.equal(second.changed, false);
	// The file is byte-identical after the second run, so nothing churned. The
	// heading appears twice on purpose — once in 人格会生长 explaining the
	// section, once as the section itself — so the check counts the section.
	const document = await workspaces.document("AGENTS.md");
	assert.equal(document.content.match(/^## 长出来的声音$/gm)?.length, 1);
});

test("one comment is not a voice", async (t) => {
	const { workspaces } = await setup(t);
	await assert.rejects(evolvePersona(workspaces, { events: async () => comments(["就这一条"]) }), {
		code: "not_found",
	});
});

test("no comments at all is a refusal, not an empty section", async (t) => {
	const { workspaces } = await setup(t);
	await assert.rejects(evolvePersona(workspaces, { events: async () => [] }), { code: "not_found" });
});

test("only this account's own comment operations are evidence", () => {
	const events = [
		{ operation: "comment.post", data: { text: "我发的" } },
		{ operation: "comment.list", data: { text: "别人的评论被读到了" } },
		{ operation: "chat.send", data: { text: "私信不算公开写作" } },
		{ operation: "comment.reply", data: { text: "我的回复" } },
		{ operation: "comment.post", data: { text: "   " } },
	];
	assert.deepEqual(eventsAsComments(events), ["我发的", "我的回复"]);
});

test("a dry run measures without writing", async (t) => {
	const { workspaces } = await setup(t);
	const before = await workspaces.document("AGENTS.md");
	const events = comments(["这条不错", "挺有意思的", "哈哈哈", "说得对", "确实这样"]);
	const preview = await evolvePersona(workspaces, { events: async () => events }, { write: false });
	const after = await workspaces.document("AGENTS.md");
	assert.equal(preview.changed, true);
	assert.equal(after.content, before.content);
	assert.ok(preview.after.includes(SECTION));
});

test("the derived lines only state what was measured", () => {
	const profile = profileVoice([
		{ text: "短" },
		{ text: "也短" },
		{ text: "还是短" },
		{ text: "真的短" },
		{ text: "短得很" },
	]);
	const lines = deriveVoice(profile);
	// Every line names its own evidence, so a reader can check the rule.
	assert.ok(lines.some((line) => line.includes("中位数")));
	assert.ok(lines.some((line) => line.includes("5 条样本")));
	// Nothing invented: no claim about taste, history or personality.
	assert.ok(!lines.some((line) => /喜欢|热爱|擅长|经历/.test(line)));
});

test("the evolved section lands where a caller reads the persona", async (t) => {
	const { workspaces } = await setup(t);
	const events = comments(["这条不错", "挺有意思的", "哈哈哈", "说得对", "确实这样"]);
	await evolvePersona(workspaces, { events: async () => events });
	const document = await workspaces.document("AGENTS.md");
	assert.ok(document.content.includes(SECTION));
	// The preset text the workspace was created with is still there: the derived
	// section is added, not substituted for the persona.
	assert.ok(document.content.includes("## 身份与声音"));
});

test("the retired fixed-settings line is replaced where it stood", () => {
	// A workspace created before the persona could grow still says "keep the
	// owner's settings fixed, do not rewrite the persona" — the opposite of what
	// the same document now says further down. An agent reading both is told to
	// grow and never to change, and the concrete older line wins.
	const old =
		"# 旧\n\n## 工作区\n\n- 记录事实。\n- 保留用户已固定的设定，不因一次任务改写人格。\n\n## 从零开始\n\n开始。\n";
	const migrated = migratePersona(old);
	assert.equal(migrated.changed, true);
	assert.equal(migrated.placement, "after-workspace");
	assert.ok(!migrated.after.includes(RETIRED_FIXED_LINE));
	assert.ok(migrated.after.includes("## 人格会生长"));
	// The section lands before 从零开始 and after 工作区, which is where the line
	// it replaced was.
	assert.ok(migrated.after.indexOf("## 人格会生长") < migrated.after.indexOf("## 从零开始"));
	assert.ok(migrated.after.indexOf("## 人格会生长") > migrated.after.indexOf("## 工作区"));
	assert.ok(migrated.after.includes("- 记录事实。"));
});

test("migrating twice changes nothing the second time", () => {
	const old = "# 旧\n\n## 工作区\n\n- 保留用户已固定的设定，不因一次任务改写人格。\n";
	const once = migratePersona(old);
	const twice = migratePersona(once.after);
	assert.equal(twice.changed, false);
	assert.equal(twice.after, once.after);
});

test("a persona whose owner already replaced the line is left alone", () => {
	// Someone who rewrote this themselves made a decision; removing their words
	// would be the tool overruling the owner.
	const own = "# 我的\n\n## 工作区\n\n- 我说了算，按我的判断来。\n";
	assert.equal(migratePersona(own).changed, false);
});

test("a persona that already has the growth section only loses the old line", () => {
	const both = `# 混合\n\n## 工作区\n\n- 保留用户已固定的设定，不因一次任务改写人格。\n\n## 人格会生长\n\n已经有了。\n`;
	const migrated = migratePersona(both);
	assert.equal(migrated.changed, true);
	assert.equal(migrated.placement, null);
	assert.ok(!migrated.after.includes(RETIRED_FIXED_LINE));
	// The existing section is kept as written rather than duplicated or replaced.
	assert.equal(migrated.after.match(/## 人格会生长/g)?.length, 1);
	assert.ok(migrated.after.includes("已经有了。"));
});

test("evolve keeps the state it replaces, so it can be moved back", async (t) => {
	// A persona that drifts somewhere worse has to have a way back; otherwise
	// "it evolves" only ever means "it moves forward".
	const { workspaces } = await setup(t);
	const events = comments(["这条不错", "挺有意思的", "哈哈哈", "说得对", "确实这样"]);
	const result = await evolvePersona(workspaces, { events: async () => events });
	assert.equal(result.changed, true);
	assert.equal(typeof result.snapshot, "number");
	const kept = workspaces.snapshots("AGENTS.md");
	assert.equal(kept.length, 1);
	// The snapshot is the state before the rewrite, which had no derived section.
	const restored = await workspaces.rollback("AGENTS.md", kept[0]?.version ?? 0);
	assert.ok(!restored.content.includes(SECTION));
});

test("versions only increase and a rollback keeps what it replaced", async (t) => {
	const { workspaces } = await setup(t);
	const original = (await workspaces.document("AGENTS.md")).content;
	const first = await workspaces.snapshot("AGENTS.md", original);
	// A second state, different from the first, so rolling back actually replaces
	// something and the archive step has work to do.
	const before = await workspaces.document("AGENTS.md");
	await workspaces.setDocument("AGENTS.md", `${original}\n## 临时\n\n后加的。\n`, before.revision);
	const second = await workspaces.snapshot("AGENTS.md", (await workspaces.document("AGENTS.md")).content);
	assert.equal(second, first + 1);
	// Rolling back archives the current state first, so a wrong rollback is
	// undone the same way.
	await workspaces.rollback("AGENTS.md", first);
	assert.equal((await workspaces.document("AGENTS.md")).content, original);
	const versions = workspaces.snapshots("AGENTS.md").map((entry) => entry.version);
	assert.equal(versions[0], second + 1);
	assert.ok(versions.includes(first));
});

test("rolling back to a version that was never kept is a refusal", async (t) => {
	const { workspaces } = await setup(t);
	await assert.rejects(workspaces.rollback("AGENTS.md", 99), { code: "not_found" });
});

test("one sitting is not a voice, however many comments it holds", async (t) => {
	// Five comments written in one evening describe one mood. Rewriting the
	// persona after every round would make it swing with whichever hour the
	// account happened to write in — drift, not growth.
	const { workspaces } = await setup(t);
	const sameSession = ["一", "二", "三", "四", "五"].map((text) => ({
		operation: "comment.post",
		at: "2026-01-01T00:30:00.000Z",
		data: { text },
	}));
	await assert.rejects(evolvePersona(workspaces, { events: async () => sameSession }), { code: "not_found" });
	// The same count spread over days is a voice and is accepted.
	const spread = comments(["一", "二", "三", "四", "五"], 4);
	assert.equal((await evolvePersona(workspaces, { events: async () => spread })).changed, true);
});

test("a missing timestamp does not make one session look like a long history", async () => {
	// Old events may carry no time at all; treating that as day zero would pass
	// the span check on a single sitting.
	const { writtenComments } = await import("../src/operations/persona-evolve.ts");
	const withoutTime = writtenComments([
		{ operation: "comment.post", data: { text: "a" } },
		{ operation: "comment.post", data: { text: "b" } },
	]);
	assert.equal(withoutTime.length, 2);
	assert.equal(withoutTime[0]?.at, "");
});

test("a core setting written after the derived section survives a rewrite", () => {
	// Order is what makes this dangerous. When the owner's core setting comes
	// after the derived section, a rewrite that slices to the end of the document
	// takes it with it — and the file still parses, so nothing looks wrong.
	const original = [
		"# 小抖",
		"",
		SECTION,
		"",
		"- 以前量出来的：一句就收",
		"",
		"## 身份与声音",
		"",
		"可爱、活泼，用户亲手写的核心设定。",
		"",
		"## 沟通",
		"",
		"- 先给结论。",
		"",
	].join("\n");
	const applied = applySection(original, "- 新量出来的：两句");
	assert.ok(applied.content.includes("可爱、活泼，用户亲手写的核心设定。"), "the core setting is untouched");
	assert.ok(applied.content.includes("- 先给结论。"), "text after the section is untouched");
	assert.ok(applied.content.includes("- 新量出来的：两句"));
	assert.ok(!applied.content.includes("- 以前量出来的"), "the old derived line is gone");
});

test("a document with two derived sections replaces the first and leaves the second", () => {
	// A duplicate could only get there by hand. Only the first is this command's
	// to rewrite; the second is something the owner left there, and touching it
	// would be rewriting a section twice over.
	const original = ["# 小抖", "", SECTION, "", "- 第一段", "", SECTION, "", "- 第二段", ""].join("\n");
	const applied = applySection(original, "- 新的");
	assert.ok(applied.content.includes("- 新的"));
	assert.ok(!applied.content.includes("- 第一段"), "the first derived section is replaced");
	assert.ok(applied.content.includes("- 第二段"), "the second is left as the owner wrote it");
});
