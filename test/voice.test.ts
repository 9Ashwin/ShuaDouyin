import assert from "node:assert/strict";
import test from "node:test";
import { profileVoice, voiceGuidance } from "../src/voice.ts";

test("a section that writes in paragraphs is not described as short", () => {
	// The same code reported a median of 11 characters on one work and 46 on
	// another, minutes apart. A profile is per work, and the advice has to follow
	// the measurement rather than a house style.
	const long = profileVoice([
		{ text: "感觉龟龟去的那个地点都有一种电影里的画面的感觉！！！！好唯美！！" },
		{ text: "龟龟！你去内蒙古啦！是不是超级好玩！内蒙古的秋天好美呀！好喜欢北方的秋天～" },
		{ text: "美的不可方物呀，这就是我想象中秋天的样子，刚开头的bgm也是超级的戳我" },
	]);
	assert.ok(long.length.median > 20, `median was ${long.length.median}`);
	assert.ok(voiceGuidance(long).some((line) => /run long/.test(line)));

	const short = profileVoice([{ text: "可惜南方没有秋天" }, { text: "嘻嘻嘻" }, { text: "好听" }]);
	assert.ok(short.length.median < 12);
	assert.ok(voiceGuidance(short).some((line) => /are short/.test(line)));
});

test("a repeated opener is only reported when it repeats", () => {
	const once = profileVoice([{ text: "龟龟！你去内蒙古啦" }, { text: "好美" }]);
	assert.deepEqual(once.openers, []);
	const twice = profileVoice([{ text: "龟龟！你去内蒙古啦" }, { text: "龟龟！我也想去" }, { text: "好美" }]);
	assert.deepEqual(twice.openers, [{ text: "龟龟", count: 2 }]);
});

test("a line of poetry is not mistaken for a greeting", () => {
	// Running on a real section, "人闲桂花落，夜静春山空" appeared twice and was
	// reported as a name people open their comments with. A greeting ends in an
	// exclamation mark; a poem ends its clause at a comma.
	const poetry = profileVoice([{ text: "人闲桂花落，夜静春山空" }, { text: "人闲桂花落，月出惊山鸟" }]);
	assert.deepEqual(poetry.openers, []);
});

test("every guidance line names the measurement behind it", () => {
	const profile = profileVoice([
		{ text: "姐姐好美！！！" },
		{ text: "宝贝这是哪里呀！！！" },
		{ text: "我也想去" },
		{ text: "姐姐下次去哪" },
	]);
	const lines = voiceGuidance(profile).join(" ");
	// A caller deciding whether to imitate needs the number, not an adjective.
	assert.match(lines, /\d+%/);
	assert.match(lines, /exclamation|address|first person|question|characters/i);
});

test("nothing read is said rather than guessed", () => {
	const empty = profileVoice([]);
	assert.equal(empty.samples, 0);
	assert.deepEqual(voiceGuidance(empty), ["No comments were read, so there is nothing to imitate."]);
});
