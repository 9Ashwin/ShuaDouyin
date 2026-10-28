import assert from "node:assert/strict";
import test from "node:test";
import { classifyLine, giftMatches, giftOutcome, parseGiftLabel } from "../src/live-text.ts";

test("a line with an author separator is speech, not a join", () => {
	// "一下就回来了" ends with 来了 and was counted as a join until the separator
	// was taken as the deciding mark.
	assert.equal(classifyLine("示例用户：一下就回来了").kind, "chat");
	assert.equal(classifyLine("示例用户：一下就回来了").author, "示例用户");
	assert.equal(classifyLine("用户8775116667676 来了").kind, "join");
	assert.equal(classifyLine("某个观众 来了").kind, "join");
});

test("a gift keeps its author, because whose gift it was is part of the row", () => {
	const line = classifyLine("示例用户：送出了 人气票 × 1");
	assert.equal(line.kind, "gift");
	assert.equal(line.author, "示例用户");
	assert.equal(line.text, "送出了 人气票 × 1");
});

test("a count alone does not make a line a gift", () => {
	// Someone saying "× 1" in conversation is not sending anything.
	assert.equal(classifyLine("其他观众：这个 × 1 是什么意思").kind, "chat");
});

test("the panel label yields the name between its two prices", () => {
	assert.deepEqual(parseGiftLabel("1钻人气票1钻赠送"), { name: "人气票", price: 1 });
	assert.deepEqual(parseGiftLabel("99钻Thuglife99钻赠送"), { name: "Thuglife", price: 99 });
	assert.equal(parseGiftLabel("更多 >"), null);
});

test("a gift is matched by name and price together", () => {
	// A caller naming a cheaper price for an expensive gift must not send it.
	const item = { name: "人气票", price: 1 };
	assert.equal(giftMatches(item, "人气票", 1), true);
	assert.equal(giftMatches(item, "人气票", 99), false);
	assert.equal(giftMatches(item, "小心心", 1), false);
});

test("what the room reports is compared against what was asked for", () => {
	const sent = [
		{ text: "送出了 人气票 × 1", author: "示例用户" },
		{ text: "送出了 加油鸭 × 1", author: "示例用户" },
		{ text: "送出了 小心心 × 1", author: "其他观众" },
	];
	const outcome = giftOutcome(sent, "示例用户", "人气票");
	assert.deepEqual(outcome.mine, ["送出了 人气票 × 1", "送出了 加油鸭 × 1"]);
	assert.equal(outcome.matched, 1);
	// Anything else the room reports still left the account and is stated, not
	// filtered away.
	assert.deepEqual(outcome.unexpected, ["送出了 加油鸭 × 1"]);
});

test("without a known self name nothing is claimed as ours", () => {
	const sent = [{ text: "送出了 人气票 × 1", author: "示例用户" }];
	assert.deepEqual(giftOutcome(sent, "", "人气票").mine, []);
});
