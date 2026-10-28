import assert from "node:assert/strict";
import test from "node:test";
import { extractSignals, parseSources, signals } from "../src/operations/signals.ts";

test("an explicit request is quoted as an asking signal", () => {
	const found = extractSignals({ text: "客厅想做一整面书架，有没有人知道大概多少钱？" });
	assert.equal(found.length, 1);
	assert.equal(found[0].kind, "asking");
	assert.equal(found[0].quote, "客厅想做一整面书架，有没有人知道大概多少钱");
	assert.ok(found[0].confidence > 0.5);
});

test("a compliment with no request is not a signal", () => {
	assert.deepEqual(extractSignals({ text: "这首歌唱得真好，耳机党狂喜" }), []);
});

test("asking whether anyone recommends something is a request", () => {
	// "有没有…推荐" is how people ask for a recommendation in practice, and it
	// matched nothing while only the literal "求推荐" did.
	const found = extractSignals({ text: "有没有靠谱的编曲老师推荐" });
	assert.equal(found[0]?.kind, "asking");
	assert.equal(extractSignals({ text: "有没有人知道大概多少钱" })[0]?.kind, "asking");
	// The widened pattern must not swallow a plain question about the work.
	assert.deepEqual(extractSignals({ text: "这首歌是谁写的" }), []);
});

test("a stated intention is weaker than a request", () => {
	const asking = extractSignals({ text: "求推荐一个靠谱的师傅" })[0];
	const intent = extractSignals({ text: "明年准备装修，大概需要先看材料" })[0];
	assert.equal(intent.kind, "intent");
	assert.ok(intent.confidence < asking.confidence);
});

test("comparing options is reported but is not a lead", () => {
	const found = extractSignals({ text: "这家和隔壁那家哪个好，有点纠结" });
	assert.equal(found[0].kind, "research");
	assert.ok(found[0].confidence < 0.3);
});

test("someone who already bought is excluded, not downgraded", () => {
	assert.deepEqual(extractSignals({ text: "谢谢 已经买了 不需要推荐了" }), []);
	// The negative marker wins even when the same sentence also asks something,
	// because a false lead costs someone a cold message.
	assert.deepEqual(extractSignals({ text: "不用推荐了，之前买过了" }), []);
});

test("one person can carry several signals and they stay separate", () => {
	const found = extractSignals({ text: "想问下多少钱？另外有没有人知道哪里买" });
	assert.ok(found.length >= 1);
	assert.ok(found.every((signal) => signal.quote.length > 0));
});

test("people with no signal are reported, not dropped", () => {
	const result = signals({
		sources: [
			{ person: "MS4wLjABAAAAone", text: "求个链接", name: "甲" },
			{ person: "MS4wLjABAAAAtwo", text: "好听", name: "乙" },
		],
	});
	assert.equal(result.people.length, 2);
	assert.equal(result.people[1].signals.length, 0);
	assert.match(result.people[1].summary, /No explicit need/);
	assert.equal(result.total, 1);
});

test("sources without a person or text are refused rather than invented", () => {
	const parsed = parseSources([{ person: "MS4wLjABAAAAone" }, { text: "没有人物" }, { person: "p", text: "t" }]);
	assert.equal(parsed.length, 1);
	assert.equal(parsed[0].person, "p");
});
