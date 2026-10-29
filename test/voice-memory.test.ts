import assert from "node:assert/strict";
import test from "node:test";
import type { Memory } from "../src/memory/concept.ts";
import { shapeOf, summarise, voiceMemories, voiceMemoryText } from "../src/operations/voice-memory.ts";
import type { VoiceProfile } from "../src/voice.ts";

function profile(overrides: Partial<VoiceProfile> = {}): VoiceProfile {
	return {
		samples: 10,
		length: { mean: 20, median: 20, p90: 30 },
		exclamation: { samples: 0, repeated: 0 },
		openers: [],
		addresses_author: 0,
		uses_emoji: 0,
		first_person: 0,
		questions: 0,
		...overrides,
	};
}

function memory(body: string): Memory {
	return {
		id: "mem_voice_signature",
		bot_id: "default",
		path: "memory/experience/voice.md",
		type: "insight",
		title: "评论区风格",
		layer: "experience",
		subject: "self",
		topic: "评论区风格",
		tags: ["voice-profile", "comment-style"],
		profile_ref: "",
		certainty: "observed",
		confidence: 0.6,
		sources: ["video:1"],
		links: [],
		body,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		revision: "r1",
	} as Memory;
}

test("a stored profile can be read back from its own text", () => {
	// The memory is what survives a restart, so the numbers have to round-trip
	// through the sentence a reader sees rather than through a hidden field.
	const text = voiceMemoryText({
		video_id: "7701374774395914139",
		sampled: 10,
		at: "2026-01-01T00:00:00.000Z",
		profile: profile({ first_person: 7, questions: 2 }),
	});
	const [record] = voiceMemories([memory(text)]);
	assert.equal(record.video_id, "7701374774395914139");
	assert.equal(record.profile.length.median, 20);
	assert.equal(record.profile.length.p90, 30);
	assert.equal(record.profile.first_person, 7);
	assert.equal(record.profile.questions, 2);
});

test("sections are grouped by shape rather than listed one by one", () => {
	// A list of every section is a pile nobody reads. What accumulates is the
	// comparison: which sections resemble the one in front of you.
	const sections = [
		{
			video_id: "a",
			sampled: 10,
			at: "2026-01-01T00:00:00.000Z",
			profile: profile({ length: { mean: 8, median: 8, p90: 12 } }),
		},
		{
			video_id: "b",
			sampled: 6,
			at: "2026-01-02T00:00:00.000Z",
			profile: profile({ length: { mean: 15, median: 14, p90: 20 } }),
		},
		{
			video_id: "c",
			sampled: 8,
			at: "2026-01-03T00:00:00.000Z",
			profile: profile({ length: { mean: 50, median: 46, p90: 102 }, first_person: 7 }),
		},
	];
	const summary = summarise(sections);
	assert.equal(summary.sections, 3);
	const oneLine = summary.shapes.find((shape) => shape.shape === "one-liner");
	const paragraph = summary.shapes.find((shape) => shape.shape === "paragraph");
	assert.equal(oneLine?.sections, 2);
	assert.deepEqual(oneLine?.median_range, [8, 14]);
	assert.equal(paragraph?.sections, 1);
	assert.ok(paragraph?.habits.includes("speaks in the first person"));
});

test("only a saved profile is read back", () => {
	// An ordinary memory that merely mentions comments is not a measurement.
	const ordinary = { ...memory("评论区很长"), tags: ["comment-style"] } as Memory;
	assert.deepEqual(voiceMemories([ordinary]), []);
});

test("a shape is decided by the spread, not just the middle", () => {
	const base = {
		samples: 10,
		exclamation: { samples: 0, repeated: 0 },
		openers: [],
		addresses_author: 0,
		uses_emoji: 0,
		first_person: 0,
		questions: 0,
	};
	assert.equal(shapeOf({ ...base, length: { mean: 8, median: 8, p90: 20 } }), "one-liner");
	// A section whose median is short but whose tail runs long is not a section
	// of one-liners; the p90 says so.
	assert.equal(shapeOf({ ...base, length: { mean: 20, median: 20, p90: 80 } }), "short-sentence");
	assert.equal(shapeOf({ ...base, length: { mean: 50, median: 40, p90: 90 } }), "paragraph");
});

test("a saved measurement reads back the habits it wrote down", async () => {
	// The text names the repeated openers and the like correlation because a
	// reader needs them. The parser did not read them back, so `--known` lost
	// every one of them and `summarise` never saw the greeting habit at all.
	const { voiceMemoryText, voiceMemories } = await import("../src/operations/voice-memory.ts");
	const body = voiceMemoryText({
		video_id: "7694232961361244347",
		sampled: 20,
		at: "2026-01-01T00:00:00.000Z",
		profile: {
			samples: 20,
			length: { mean: 18, median: 14, p90: 32 },
			exclamation: { samples: 6, repeated: 2 },
			openers: [
				{ text: "龟龟", count: 4 },
				{ text: "宝", count: 2 },
			],
			addresses_author: 3,
			uses_emoji: 5,
			first_person: 2,
			questions: 4,
		},
		engagement: { rated: 12, median_likes: 340, correlation: -0.38 },
	});
	const read = voiceMemories([
		{
			id: "m1",
			file: "memory/experience/x.md",
			title: "评论区风格",
			body,
			tags: ["voice-profile", "comment-style"],
			revision: "abc",
			created_at: "2026-01-01T00:00:00.000Z",
			updated_at: "2026-01-01T00:00:00.000Z",
			type: "insight",
		},
	] as never);
	const record = read[0];
	assert.deepEqual(record?.profile.openers, [
		{ text: "龟龟", count: 4 },
		{ text: "宝", count: 2 },
	]);
	assert.deepEqual(record?.engagement, { rated: 12, median_likes: 340, correlation: -0.38 });
	assert.equal(record?.profile.length.median, 14);
});
