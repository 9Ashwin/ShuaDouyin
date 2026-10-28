import assert from "node:assert/strict";
import test from "node:test";
import { classifyComment } from "../src/comment-stance.ts";

test("a remark about the singing is about the work", () => {
	const result = classifyComment("这首歌歌词不错，但原唱的歌声不行");
	assert.equal(result.stance, "about_work");
	assert.ok(result.signals.length > 0);
});

test("a personal reaction is about the commenter, even when it names the work", () => {
	// "每次听到这首歌鸡皮疙瘩都起来了" mentions the song but is a statement about
	// the person hearing it; the first person decides the label.
	assert.equal(classifyComment("每次听到这首歌鸡皮疙瘩都起来了").stance, "about_self");
	assert.equal(classifyComment("我已经断了，荒天帝好久").stance, "about_self");
});

test("a question aimed at the creator is asking", () => {
	assert.equal(classifyComment("姐姐可以唱一下那首吗").stance, "asking");
	assert.equal(classifyComment("这个视频用的是什么镜头？").stance, "asking");
});

test("an advertisement is spam regardless of what else it says", () => {
	assert.equal(classifyComment("互关互赞，主页有惊喜").stance, "spam");
	assert.equal(classifyComment("加v信带你赚钱").stance, "spam");
});

test("no clear signal is reported as unknown, not guessed", () => {
	// Most of a real comment section lands here. A label nobody could defend is
	// worse than admitting the text does not say.
	const result = classifyComment("待我归来带你看尽世间璀璨");
	assert.equal(result.stance, "unknown");
	assert.deepEqual(result.signals, []);
});

test("an empty comment has no stance", () => {
	assert.equal(classifyComment("   ").stance, "unknown");
});
