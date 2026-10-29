import assert from "node:assert/strict";
import test from "node:test";
import {
	availablePhrases,
	candidatePhrase,
	measureSameness,
	type Phrase,
	phraseState,
	usePhrase,
} from "../src/operations/phrases.ts";
import { measureWit } from "../src/voice.ts";

function phrase(overrides: Partial<Phrase> = {}): Phrase {
	return {
		text: "下次一起唱",
		kind: "echo",
		from_video: "7694232961361244347",
		learned_at: "2026-01-01T00:00:00.000Z",
		used: 0,
		last_used: null,
		likes: 247,
		...overrides,
	};
}

const now = new Date("2026-02-01T00:00:00.000Z");

test("a phrase used three times is spent rather than offered again", () => {
	// The whole point of the ledger: reaching for the same line every time is
	// what makes a bot read as a bot.
	let used = phrase();
	assert.equal(phraseState(used, now).status, "fresh");
	for (let index = 0; index < 3; index++) used = usePhrase(used, now);
	assert.equal(used.used, 3);
	assert.equal(phraseState(used, now).status, "spent");
	// Spent is reported, not hidden — otherwise the same suggestion returns.
	const { usable, spent } = availablePhrases([used], now);
	assert.equal(usable.length, 0);
	assert.equal(spent.length, 1);
});

test("silence brings a spent phrase back", () => {
	// Repetition is about proximity. The same line once a month is a habit a
	// person could have; three times in a week is a tic.
	const spent = phrase({ used: 3, last_used: "2026-01-01T00:00:00.000Z" });
	const state = phraseState(spent, new Date("2026-02-01T00:00:00.000Z"));
	assert.equal(state.status, "usable");
	assert.ok(state.idle_days >= 14);
});

test("the least recently said phrase is offered first", () => {
	const fresh = phrase({ text: "欧克", used: 0, likes: 120 });
	const rested = phrase({ text: "笑死我了", used: 1, last_used: "2026-01-20T00:00:00.000Z", likes: 50 });
	const { usable } = availablePhrases([rested, fresh], now);
	assert.deepEqual(
		usable.map((entry) => entry.text),
		["欧克", "笑死我了"],
	);
});

test("a phrase naming a work or a person is not kept", () => {
	// It landed because of the referent, and the referent does not travel.
	const named = "这首歌有一点像王朝1982的《我本将心向明月》";
	assert.equal(candidatePhrase({ text: named, likes: 63 }, measureWit(named), "1"), null);
	const person = "这个不是泽国同学的歌吗";
	assert.equal(candidatePhrase({ text: person, likes: 4 }, measureWit(person), "1"), null);
	// The shape without the referent is what can be reused.
	const echo = candidatePhrase({ text: "下次一起唱", likes: 247 }, measureWit("下次一起唱"), "1");
	assert.equal(echo?.kind, "echo");
});

test("an unliked comment is not a candidate however well formed", () => {
	// Copying a line nobody reacted to is worse than having no line at all.
	assert.equal(candidatePhrase({ text: "笑死我了真的", likes: 1 }, measureWit("笑死我了真的"), "1"), null);
});

test("repeating one phrase across comments is called a template", () => {
	const template = measureSameness(
		["下次一起唱", "下次一起唱啊", "下次一起唱吧", "下次一起唱呀"].map((text) => ({ text })),
	);
	assert.equal(template.verdict, "template");
	assert.ok(template.repeated_phrases.some((entry) => entry.phrase === "下次一起"));
});

test("varied comments are not accused of repeating", () => {
	const varied = measureSameness(
		["下次一起唱", "这个编曲真的顶，副歌部分层次分明", "哈哈哈哈笑死", "我妹说她也想听"].map((text) => ({ text })),
	);
	assert.equal(varied.verdict, "varied");
	assert.deepEqual(varied.repeated_phrases, []);
});

test("comments of near-identical length look like a template", () => {
	// Different words, same size, every time: a reader can predict the next one.
	const same = measureSameness(["今天天气真不错", "这首歌听着还行", "刚才那个好厉害"].map((text) => ({ text })));
	assert.equal(same.length_spread <= same.average_length / 3, true);
	assert.notEqual(same.verdict, "varied");
});
