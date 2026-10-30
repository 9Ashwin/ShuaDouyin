import assert from "node:assert/strict";
import test from "node:test";
import type { ResponseWindow } from "../src/operations/response-window.ts";
import type { Card, Vocabulary } from "../src/operations/social.ts";
import { advise, wouldSetStage } from "../src/operations/social-advice.ts";

// This proposes and stops. The stage command already refuses to infer a
// connection from anything but a stated decision, and an advice module that
// quietly wrote a stage would be the back door to that.

const card = (overrides: Partial<Card> = {}): Card => ({
	person: "p1",
	stage: "talking",
	first_seen: "2026-01-01T00:00:00.000Z",
	last_contact: "2026-01-01T00:00:00.000Z",
	contact_count: 3,
	last_text: "",
	open_followups: [],
	decided_at: null,
	note: "",
	goal: null,
	stage_position: null,
	...overrides,
});

const window = (overrides: Partial<ResponseWindow> = {}): ResponseWindow => ({
	answered: 0,
	unanswered: [],
	median_reply_hours: null,
	last_incoming_at: null,
	last_outgoing_at: null,
	only_outgoing: false,
	limits: "",
	...overrides,
});

test("an answer means continuing is supported", () => {
	const advice = advise(card(), window({ answered: 2, median_reply_hours: 3 }));
	assert.equal(advice.kind, "continue");
	assert.match(advice.say, /回过话/);
	// What to say is judgement, and this says so rather than proposing words.
	assert.match(advice.say, /说什么/);
});

test("silence has to be both repeated and old before it means stop", () => {
	// One message from this morning is not being ignored.
	const recent = advise(
		card(),
		window({ only_outgoing: true, unanswered: [{ id: null, kind: "text", at: "", hours_waiting: 2 }] }),
	);
	assert.equal(recent.kind, "wait");
	// Two messages, still today.
	const both = advise(
		card(),
		window({
			only_outgoing: true,
			unanswered: [
				{ id: null, kind: "text", at: "", hours_waiting: 5 },
				{ id: null, kind: "text", at: "", hours_waiting: 3 },
			],
		}),
	);
	assert.equal(both.kind, "wait");
	// Two messages, oldest well past a day.
	const old = advise(
		card(),
		window({
			only_outgoing: true,
			unanswered: [
				{ id: null, kind: "text", at: "", hours_waiting: 40 },
				{ id: null, kind: "text", at: "", hours_waiting: 30 },
			],
		}),
	);
	assert.equal(old.kind, "stop");
	assert.match(old.say, /打扰/);
});

test("one old message is still not a pattern", () => {
	// A single share that nobody opened is not evidence of being ignored by a
	// person; it may not even have been opened.
	const advice = advise(
		card(),
		window({ only_outgoing: true, unanswered: [{ id: null, kind: "share", at: "", hours_waiting: 200 }] }),
	);
	assert.equal(advice.kind, "wait");
});

test("nothing loaded is unknown, not silence", () => {
	const advice = advise(card(), window());
	assert.equal(advice.kind, "unknown");
	assert.match(advice.reasons.join(" "), /没有对方的消息/);
});

test("the reply being theirs means the ball is in my court", () => {
	const advice = advise(
		card(),
		window({ answered: 1, last_incoming_at: "2026-01-02T00:00:00.000Z", last_outgoing_at: "2026-01-01T00:00:00.000Z" }),
	);
	assert.equal(advice.kind, "continue");
});

test("every advice states what it could not see", () => {
	for (const advice of [advise(card(), window({ answered: 1 })), advise(card(), window())]) {
		assert.match(advice.limits, /never opened/);
		assert.match(advice.limits, /does not read what any reply said/);
	}
});

test("a suggested stage never goes past what the vocabulary allows evidence to reach", () => {
	const vocabulary: Vocabulary = {
		id: "lead",
		stages: ["discovered", "contacted", "talking", "connected"],
		evidence_stops_at: 2,
	};
	const suggested = wouldSetStage(
		card({ stage: "contacted", contact_count: 1 }),
		advise(card(), window({ answered: 1 })),
		vocabulary,
	);
	assert.equal(suggested, "talking");
	// At the evidence ceiling, nothing further is suggested: "connected" is a fact
	// about the other person, not something timing can establish.
	const ceiling = wouldSetStage(
		card({ stage: "talking", contact_count: 5 }),
		advise(card(), window({ answered: 1 })),
		vocabulary,
	);
	assert.equal(ceiling, null);
});

test("a proposal only suggests a stage when it says continue", () => {
	const vocabulary: Vocabulary = { id: "lead", stages: ["discovered", "contacted"], evidence_stops_at: 1 };
	assert.equal(
		wouldSetStage(card({ stage: "discovered" }), advise(card(), window({ only_outgoing: true })), vocabulary),
		null,
	);
});
