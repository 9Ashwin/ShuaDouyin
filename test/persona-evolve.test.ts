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

const comments = (texts: string[]) =>
	texts.map((text) => ({ operation: "comment.post", bot_id: "default", data: { text } }));

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
