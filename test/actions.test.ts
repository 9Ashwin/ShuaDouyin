import assert from "node:assert/strict";
import test from "node:test";
import { coveringGrant, derive, type Grant, type Proposal } from "../src/operations/actions.ts";
import type { Event } from "../src/store.ts";

// derive() turns the event log into proposals and grants. The log is the only
// source of truth for what was approved, so this function decides two things a
// person relies on: what is waiting for them, and how much of a grant has been
// spent. Both are tested here against events built by hand, because going
// through the commands would test the write path instead of the projection.

const at = (iso: string) => iso;

const event = (operation: string, data: Record<string, unknown>, when = "2026-01-01T00:00:00Z"): Event =>
	({ operation, at: at(when), data }) as Event;

// A proposal with no stated window expires at the moment it was proposed, so
// every case here gives one unless it is testing the default.
const proposalEvent = (id: string, kind = "comment.post", extra: Record<string, unknown> = {}) =>
	event("action.proposed", {
		id,
		kind,
		target: "video-1",
		draft: "一句话",
		reason: "想说",
		expires_at: new Date(Date.now() + 3600_000).toISOString(),
		...extra,
	});

test("a proposal is visible until it is acted on", () => {
	const { proposals } = derive([proposalEvent("p1")]);
	assert.equal(proposals.length, 1);
	assert.equal(proposals[0]?.status, "proposed");
	assert.equal(proposals[0]?.risk, "high");
});

test("risk comes from the action kind, never from the event", () => {
	// A caller able to label its own post "low" could grant itself the right to
	// post, so a risk field in the event is ignored.
	const { proposals } = derive([proposalEvent("p1", "comment.post", { risk: "low" })]);
	assert.equal(proposals[0]?.risk, "high");
});

test("an event naming a kind this tool does not know is skipped, not stored", () => {
	const { proposals } = derive([proposalEvent("p1", "video.download")]);
	assert.deepEqual(proposals, []);
});

test("a proposal id missing from the event is skipped", () => {
	assert.deepEqual(derive([event("action.proposed", { kind: "comment.post" })]).proposals, []);
});

test("each terminal event sets the status it names", () => {
	for (const [operation, status] of [
		["action.approved", "approved"],
		["action.rejected", "rejected"],
		["action.canceled", "canceled"],
		["action.executed", "executed"],
		["action.failed", "failed"],
	] as const) {
		const { proposals } = derive([proposalEvent("p1"), event(operation, { proposal_id: "p1" })]);
		assert.equal(proposals[0]?.status, status, operation);
	}
});

test("an approval carries the grant and an execution carries the receipt", () => {
	// These ids are how a later reader answers "what was done under this grant".
	const { proposals } = derive([
		proposalEvent("p1"),
		event("action.approved", { proposal_id: "p1", grant_id: "g1" }),
		event("action.executed", { proposal_id: "p1", receipt_id: "r1" }),
	]);
	assert.equal(proposals[0]?.status, "executed");
	assert.equal(proposals[0]?.grant_id, "g1");
	assert.equal(proposals[0]?.receipt_id, "r1");
});

test("a failure records the error it failed with", () => {
	const { proposals } = derive([proposalEvent("p1"), event("action.failed", { proposal_id: "p1", error: "timeout" })]);
	assert.equal(proposals[0]?.error, "timeout");
});

test("an event for a proposal that was never proposed does not invent one", () => {
	// This is what a truncated or reordered log looks like, and inventing a
	// proposal here would show someone an approval for something they never saw.
	assert.deepEqual(derive([event("action.approved", { proposal_id: "ghost" })]).proposals, []);
});

test("a proposal expires on its own once its window has passed", () => {
	const past = new Date(Date.now() - 3600_000).toISOString();
	const future = new Date(Date.now() + 3600_000).toISOString();
	assert.equal(derive([proposalEvent("p1", "comment.post", { expires_at: past })]).proposals[0]?.status, "expired");
	assert.equal(derive([proposalEvent("p2", "comment.post", { expires_at: future })]).proposals[0]?.status, "proposed");
});

test("a grant that has been acted on is not reported expired", () => {
	// Expiry is only for proposals still waiting; one already executed happened.
	const past = new Date(Date.now() - 3600_000).toISOString();
	const { proposals } = derive([
		proposalEvent("p1", "comment.post", { expires_at: past }),
		event("action.executed", { proposal_id: "p1" }),
	]);
	assert.equal(proposals[0]?.status, "executed");
});

test("an unknown grant kind is dropped from the grant rather than kept", () => {
	// Keeping it would put a kind in the grant that no proposal can ever match,
	// and the person who granted it would have no way to see it was dead weight.
	const { grants } = derive([
		event("action.granted", { id: "g1", kinds: ["comment.post", "video.download"], per_day: 3 }),
	]);
	assert.deepEqual(grants[0]?.kinds, ["comment.post"]);
	assert.equal(grants[0]?.per_day, 3);
});

test("a revoked grant keeps its record and gains the revocation time", () => {
	// A revocation arrives as a proposal event naming the grant; it does not
	// remove the grant, because the history of what it covered still matters.
	const { grants } = derive([
		event("action.granted", { id: "g1", kinds: ["comment.post"], per_day: 3 }),
		proposalEvent("p1"),
		event("action.grant.revoked", { proposal_id: "p1", grant_id: "g1" }, "2026-01-02T00:00:00Z"),
	]);
	assert.equal(grants[0]?.revoked_at, "2026-01-02T00:00:00Z");
});

test("a grant covers a proposal only within its kinds, its budget and its window", () => {
	const now = Date.parse("2026-01-01T12:00:00Z");
	const grant = (overrides: Partial<Grant> = {}): Grant => ({
		id: "g1",
		kinds: ["comment.post"],
		per_day: 2,
		expires_at: "2026-01-02T00:00:00Z",
		created_at: "2026-01-01T00:00:00Z",
		...overrides,
	});
	const proposal = (overrides: Partial<Proposal> = {}): Proposal => ({
		id: "p1",
		kind: "comment.post",
		target: "video-1",
		draft: "一句话",
		reason: "",
		risk: "high",
		status: "proposed",
		created_at: "2026-01-01T00:00:00Z",
		expires_at: "2026-01-02T00:00:00Z",
		...overrides,
	});
	const executed = (id: string, grantId = "g1", when = "2026-01-01T01:00:00Z") =>
		proposal({ id, status: "executed", grant_id: grantId, created_at: when });

	assert.ok(coveringGrant([grant()], [], proposal(), now));
	// A kind the grant does not list is not covered by it.
	assert.equal(coveringGrant([grant()], [], proposal({ kind: "user.follow" }), now), null);
	// A revoked grant covers nothing.
	assert.equal(coveringGrant([grant({ revoked_at: "2026-01-01T02:00:00Z" })], [], proposal(), now), null);
	// An expired grant covers nothing.
	assert.equal(coveringGrant([grant({ expires_at: "2026-01-01T00:00:00Z" })], [], proposal(), now), null);
	// The budget is spent by executions under this grant, on this day.
	assert.ok(coveringGrant([grant()], [executed("p1")], proposal({ id: "p2" }), now));
	assert.equal(coveringGrant([grant()], [executed("p1"), executed("p2")], proposal({ id: "p3" }), now), null);
	// Spending under another grant does not consume this one's budget.
	assert.ok(coveringGrant([grant()], [executed("p1"), executed("p2", "other")], proposal({ id: "p3" }), now));
	// Yesterday's executions do not count against today.
	assert.ok(coveringGrant([grant()], [executed("p1", "g1", "2025-12-31T01:00:00Z")], proposal({ id: "p2" }), now));
	// Only executed proposals spend the budget: a failed one did not happen. The
	// budget here is one, so counting a failure would leave nothing.
	assert.ok(
		coveringGrant(
			[grant({ per_day: 1 })],
			[proposal({ id: "p9", status: "failed", grant_id: "g1" })],
			proposal({ id: "p2" }),
			now,
		),
	);
});

test("a proposal already marked executed does not spend a grant twice", () => {
	// Each executed proposal is one use; the count is of proposals, not events.
	const now = Date.parse("2026-01-01T12:00:00Z");
	const grant: Grant = {
		id: "g1",
		kinds: ["comment.post"],
		per_day: 1,
		expires_at: "2026-01-02T00:00:00Z",
		created_at: "2026-01-01T00:00:00Z",
	};
	const used = (id: string): Proposal => ({
		id,
		kind: "comment.post",
		target: "video-1",
		draft: "",
		reason: "",
		risk: "high",
		status: "executed",
		created_at: "2026-01-01T01:00:00Z",
		expires_at: "2026-01-02T00:00:00Z",
		grant_id: "g1",
	});
	const next = { ...used("p2"), id: "p2", status: "proposed" as const };
	assert.equal(coveringGrant([grant], [used("p1")], next, now), null);
});
