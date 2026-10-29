import assert from "node:assert/strict";
import test from "node:test";
import { checkVoice } from "../src/operations/voice-check.ts";

// The check exists because a catalog of tells is advice, and advice gets
// forgotten. It has to fire on the shapes that are unmistakably machine-written
// and stay quiet on ordinary speech — a check that cries wolf teaches a caller
// to ignore it.

const names = (text: string) => checkVoice(text).tells.map((tell) => tell.name);

test("the reversal frame is caught, comma and all", () => {
	// The most common shape has a comma in the middle. A pattern that stopped at
	// punctuation missed it, which is the bug this test was written after.
	assert.ok(names("这不是技术问题，而是认知问题。").includes("翻案句"));
	assert.ok(names("不在于工具多好，而在于用的人。").includes("翻案句"));
});

test("an era opener and a lifted ending are both caught", () => {
	assert.ok(names("在当今快速发展的AI时代，一切都变了。").includes("时代开场"));
	assert.ok(names("未来已来，值得我们深思。").includes("结尾升华"));
});

test("road signs are caught whether or not a comma follows", () => {
	// "首先要有意识" is the same road sign as "首先，".
	assert.ok(names("首先要有意识，其次要有方法。").includes("显性路标"));
	assert.ok(names("首先，要有意识。").includes("显性路标"));
});

test("an ordinary paragraph is left alone", () => {
	const plain = "这光打得像老电影。我盯着看了三遍才注意到背景里还有一只猫在走。";
	const verdict = checkVoice(plain);
	assert.equal(verdict.verdict, "reads-human");
	assert.equal(verdict.tells.length, 0);
});

test("a sentence starting with a colon is not a definition", () => {
	// "我先说清楚：" is someone beginning to talk, not "本质：一场对话". Matching it
	// was a false positive on ordinary speech.
	assert.ok(!names("我先说清楚：这件事最后是谁拍的板，我还不知道。").includes("定义腔"));
	assert.ok(names("手冲的本质：一场与时间的对话").includes("定义腔"));
});

test("three families together read as still machine-written", () => {
	const verdict = checkVoice("在当今快速发展的时代，这不是工具问题，而是认知问题。这意味着我们首先要改变。");
	assert.equal(verdict.verdict, "still-ai");
	assert.ok(verdict.guidance.length > 0);
});

test("a text scrubbed past natural is called out as over-corrected", () => {
	// The failure the source skill documents: deleting every tell mints new ones.
	const scrubbed = "他说完就走了，我没拦，也没有必要拦，事情到这一步已经很清楚，剩下的只是时间问题，等通知就行。";
	const verdict = checkVoice(scrubbed);
	assert.equal(verdict.verdict, "over-corrected");
	assert.ok(verdict.guidance.some((line) => line.includes("有长有短")));
});

test("a clean text is told to stop editing", () => {
	// The whole point: the check must not become another reason to rewrite. Its
	// own advice on a passing text is "don't go again".
	assert.ok(checkVoice("这光打得像老电影。").guidance.some((line) => line.includes("别为了")));
});

test("every tell carries where it starts and why", () => {
	const verdict = checkVoice("未来已来。");
	assert.equal(verdict.tells[0]?.index, 0);
	assert.equal(verdict.tells[0]?.match, "未来已来");
	assert.ok((verdict.tells[0]?.why.length ?? 0) > 5);
});
