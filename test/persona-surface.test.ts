import assert from "node:assert/strict";
import test from "node:test";
import { personaSurface } from "../src/operations/persona-surface.ts";

// What a caller reads before it speaks.
//
// The failure this replaces: `context show` truncates a document from the front,
// and the identity and voice sections sit after the role introduction. A budget
// that ran out removed the part the agent is supposed to sound like, and the
// output said nothing about it — so a caller could read a persona and get the
// tool's default voice instead, with no way to tell.

const DOC = [
	"# 阿鱼",
	"",
	"## 角色",
	"",
	"你是一个隔着屏幕看内容、也有自己判断的 bot。".repeat(20),
	"",
	"## 身份与声音",
	"",
	"话多，爱笑，用短句和语气词。",
	"",
	"## 行为准则",
	"",
	"- 只做被授权的事。",
	"",
	"## 人格会生长",
	"",
	"这一节是算出来的。",
	"",
	"## 沟通",
	"",
	"先给结论，再给依据。",
].join("\n");

const surface = (budget = 6000) => personaSurface("bot", "AGENTS.md", "abc123", DOC, budget);
const part = (result: ReturnType<typeof surface>, name: string) => result.parts.find((entry) => entry.name === name);

test("the name comes from the first heading, which is where the template puts it", () => {
	assert.equal(surface().name, "阿鱼");
});

test("identity, conduct, growth and communication are read by section", () => {
	const result = surface();
	assert.equal(part(result, "identity")?.text, "话多，爱笑，用短句和语气词。");
	assert.equal(part(result, "conduct")?.text, "- 只做被授权的事。");
	assert.equal(part(result, "growth")?.text, "这一节是算出来的。");
	assert.equal(part(result, "communication")?.text, "先给结论，再给依据。");
});

test("a section the document does not have is reported, not invented", () => {
	// `voice` only exists once `persona evolve` has measured something. Filling
	// it with a default would give the agent a voice nobody chose.
	const result = surface();
	assert.ok(result.missing.includes("voice"));
	assert.equal(part(result, "voice"), undefined);
});

test("the revision is returned so an edit between read and use is visible", () => {
	// Without it a caller cannot tell that the persona changed under it.
	assert.equal(surface().revision, "abc123");
});

test("a section that does not fit comes back empty rather than half-cut", () => {
	// Half a voice section reads exactly like a whole one. Saying complete:false
	// is the difference between "this is the persona" and "this is part of it".
	// The identity here is longer than the budget, so it cannot fit at all.
	const long = ["# 阿鱼", "", "## 身份与声音", "", "很长的声音设定。".repeat(60), "", "## 沟通", "", "说话。"].join(
		"\n",
	);
	const result = personaSurface("bot", "AGENTS.md", "rev", long, 100);
	const identity = part(result, "identity");
	assert.equal(identity?.complete, false);
	assert.equal(identity?.text, "", "a cut section is not partially returned");
	assert.equal(result.complete, false);
	assert.ok(result.limits.some((line) => /did not fit/.test(line)));
});

test("the budget is spent in template order, so identity survives a tight one", () => {
	// The whole point of ordering: when there is room for one section it is the
	// one that decides how the bot sounds. The budget fits the identity exactly
	// and nothing after it.
	const result = personaSurface("bot", "AGENTS.md", "rev", DOC, 14);
	assert.equal(part(result, "identity")?.text, "话多，爱笑，用短句和语气词。");
	assert.equal(part(result, "identity")?.complete, true);
	assert.equal(part(result, "conduct")?.complete, false);
	assert.equal(part(result, "conduct")?.text, "");
});

test("a document with no sections is reported as needing interpretation", () => {
	// A free-form file is not an empty persona. Returning an empty result silently
	// would let an agent speak with no persona at all.
	const result = personaSurface("bot", "AGENTS.md", "rev", "just a paragraph with no headings", 6000);
	assert.equal(result.needs_interpretation, true);
	assert.match(result.reason ?? "", /No `##` sections/);
	assert.equal(result.parts.length, 0);
	assert.equal(result.complete, false);
});

test("the persona is described as written, not as followed", () => {
	// The tool cannot promise an agent sounds like the file; only a host that
	// builds its own request can. Saying otherwise would be a claim it cannot keep.
	assert.ok(surface().limits.some((line) => /not proof an agent followed it/.test(line)));
});

test("a section present but empty counts as missing rather than as a blank voice", () => {
	const doc = ["# 阿鱼", "", "## 身份与声音", "", "## 行为准则", "", "- 一条。", "", "## 沟通", "", "说话。"].join(
		"\n",
	);
	const result = personaSurface("bot", "AGENTS.md", "rev", doc, 6000);
	assert.ok(result.missing.includes("identity"));
});

test("a core voice section past the old 8000-character cut still arrives", () => {
	// context show sliced from the front at 8000 characters, so a long persona
	// lost its voice section entirely and said nothing about it. The projection
	// spends its budget section by section, so position no longer matters.
	const filler = "这一节是角色介绍。".repeat(900);
	const doc = ["# 阿鱼", "", "## 角色", "", filler, "", "## 身份与声音", "", "话多，爱笑。", ""].join("\n");
	assert.ok(doc.indexOf("话多，爱笑。") > 8000, "the voice section really is past the old cut");
	const result = personaSurface("bot", "AGENTS.md", "rev", doc, 100);
	assert.equal(part(result, "identity")?.text, "话多，爱笑。");
});

test("a workspace with no persona document is not a persona of nothing", () => {
	// The command refuses rather than returning an empty surface, because an agent
	// handed an empty persona speaks in its own voice with no marker anywhere.
	assert.equal(personaSurface("bot", "AGENTS.md", "", "", 6000).needs_interpretation, true);
});

test("a hand-edited revision is carried through untouched", () => {
	// The revision is the caller's only way to notice an edit between reading and
	// using, so it must be the file's own value and never recomputed here.
	const one = personaSurface("bot", "AGENTS.md", "aaa", DOC, 6000);
	const two = personaSurface("bot", "AGENTS.md", "bbb", DOC, 6000);
	assert.equal(one.revision, "aaa");
	assert.equal(two.revision, "bbb");
	assert.equal(one.parts.length, two.parts.length, "the revision does not change the projection");
});

test("a free-form persona is passed through, not emptied", () => {
	// The projection cannot read a file with no sections. Returning empty content
	// would say the persona itself is empty, which is a different and wrong claim:
	// the test that caught this had a file containing only "# My persona".
	const free = "# My persona\n\nI like short sentences.";
	const result = personaSurface("bot", "AGENTS.md", "rev", free, 6000);
	assert.equal(result.needs_interpretation, true);
	assert.equal(result.parts.length, 0);
	// What the caller does with it is in knowledge.ts: it falls back to the raw
	// document rather than to an empty string.
	assert.equal(result.name, "My persona");
});
