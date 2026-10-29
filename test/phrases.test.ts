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

// A memory as the ledger stores one, so the parser in phraseMemories is what the
// test exercises rather than a mock of its output.
function phraseMemory(overrides: { used?: number }) {
	const value = phrase({ used: overrides.used ?? 0, last_used: null });
	return {
		id: "m1",
		file: "memory/experience/x.md",
		title: "可用句式",
		body: [
			`可用句式（${value.kind}，来自作品 ${value.from_video}，${value.likes} 赞）：`,
			`「${value.text}」`,
			`已用 ${value.used} 次。`,
		].join(""),
		tags: ["phrase-ledger", "comment-style"],
		revision: "abc",
		created_at: value.learned_at,
		updated_at: value.learned_at,
	};
}

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

test("a send records the use itself, so the count does not depend on a caller remembering", async () => {
	// The ledger is only worth having if every use is counted. Asking a caller to
	// run `comment phrases --use` after each send made the count as reliable as
	// that caller's memory, which is the failure the ledger exists to prevent.
	const { recordPhraseUse } = await import("../src/operations/comments.ts");
	const called: { operation: string; input: Record<string, unknown> }[] = [];
	const known = {
		execute: async (operation: string, input: Record<string, unknown>) => {
			called.push({ operation, input });
			if (operation === "memory.list") return [phraseMemory({ used: 1 })];
			return { updated: true };
		},
	};
	const result = await recordPhraseUse(known, "下次一起唱", now);
	assert.equal(result?.used, 2);
	assert.equal(called[1]?.operation, "memory.update");
	assert.ok(String(called[1]?.input.text).includes("已用 2 次"));
});

test("a comment that is not from the ledger is not an error", async () => {
	// Most comments are not quotes from the ledger, and a send that fails because
	// nothing matched would make the ledger a gate rather than a record.
	const { recordPhraseUse } = await import("../src/operations/comments.ts");
	const known = { execute: async () => [phraseMemory({})] };
	assert.equal(await recordPhraseUse(known, "这家店我常去", now), null);
});

test("a ledger entry with nothing to update is refused rather than counted into nothing", async () => {
	// phraseMemories only returns tagged entries, so an untagged one cannot reach
	// here; the state that can is a tagged memory whose body no longer parses.
	// Counting a use into a file that will not be found would lose the record.
	const { recordPhraseUse } = await import("../src/operations/comments.ts");
	const orphan = phraseMemory({});
	const known = {
		execute: async (operation: string) =>
			operation === "memory.list"
				? [{ ...orphan, tags: ["phrase-ledger"], body: orphan.body.replace(`「${phrase().text}」`, "「换过的」") }]
				: undefined,
	};
	assert.equal(await recordPhraseUse(known as never, phrase().text, now), null);
});
