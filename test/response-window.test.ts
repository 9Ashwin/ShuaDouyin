import assert from "node:assert/strict";
import test from "node:test";
import { type Message, responseWindow } from "../src/operations/response-window.ts";

// Whether anything came back is the one part of the social loop that is a fact.
// These tests pin the arithmetic, and just as importantly pin what it refuses to
// claim: a reply is not a relationship, and an unloaded window is not silence.

const at = (hours: number) => new Date(Date.UTC(2026, 0, 1, 0, 0) + hours * 3_600_000).toISOString();
const now = Date.parse(at(100));

const message = (direction: "incoming" | "outgoing", hours: number, extra: Partial<Message> = {}): Message => ({
	id: `${direction}-${hours}`,
	direction,
	timestamp: at(hours),
	kind: "text",
	...extra,
});

test("an incoming message after an outgoing one counts as an answer", () => {
	const window = responseWindow([message("outgoing", 0), message("incoming", 2)], now);
	assert.equal(window.answered, 1);
	assert.equal(window.median_reply_hours, 2);
	assert.equal(window.unanswered.length, 0);
});

test("a reply belongs to the message just before it, not to every earlier one", () => {
	// Counting one incoming as an answer to both outgoing messages would double the
	// exchange and make a one-sided conversation look mutual.
	const window = responseWindow([message("outgoing", 0), message("outgoing", 1), message("incoming", 2)], now);
	assert.equal(window.answered, 1);
	assert.equal(window.unanswered.length, 1);
});

test("a conversation that is only outgoing says so", () => {
	// This is the state that decides whether to keep trying, and it is not the same
	// as a conversation that happens to be quiet today.
	const window = responseWindow([message("outgoing", 0), message("outgoing", 5)], now);
	assert.equal(window.only_outgoing, true);
	assert.equal(window.answered, 0);
	assert.equal(window.unanswered.length, 2);
});

test("how long a message has waited is measured, not guessed", () => {
	const window = responseWindow([message("outgoing", 90)], now);
	assert.equal(window.unanswered[0]?.hours_waiting, 10);
});

test("a pending or failed message is not evidence either way", () => {
	const window = responseWindow(
		[message("outgoing", 0, { pending: true }), message("outgoing", 1, { failed: true }), message("incoming", 2)],
		now,
	);
	assert.equal(window.only_outgoing, false);
	assert.equal(window.unanswered.length, 0);
});

test("the median reply delay is over the pairs that have one", () => {
	const window = responseWindow(
		[message("outgoing", 0), message("incoming", 1), message("outgoing", 10), message("incoming", 15)],
		now,
	);
	assert.equal(window.answered, 2);
	// 1 hour and 5 hours: the lower middle, so 1.
	assert.equal(window.median_reply_hours, 1);
});

test("an empty window claims nothing about silence", () => {
	// The distinction that matters: no loaded messages is not proof nobody replied.
	const window = responseWindow([], now);
	assert.equal(window.only_outgoing, false);
	assert.match(window.limits, /No messages are loaded/);
});

test("the limits say what this cannot conclude", () => {
	const window = responseWindow([message("outgoing", 0)], now);
	assert.match(window.limits, /not here/);
	assert.match(window.limits, /does not decide whether the relationship moved/);
});
