import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS } from "../src/catalog.ts";
import { fingerprintOf } from "../src/operations/steer.ts";
import { isWrite, validate } from "../src/operations/validate.ts";

// Steering the recommender is the first write here that changes the account's own
// feed rather than reaching a person. The guarantees are different from a send:
// nobody can see it, and nobody can tell from a second press whether the first
// worked. So what is checked here is that the command cannot act by accident — no
// default direction, no write without a request id, and a request id that carries
// the requested state rather than only the work.

test("steering is classified as a write, so it passes the pause and quota gates", () => {
	// A read-classified steer would skip every gate an outward action passes
	// through, and would be the one command that changes the account quietly.
	assert.equal(isWrite("video.steer"), true);
});

test("the catalog declares it as an account write with a required direction", () => {
	const command = COMMANDS.find((entry) => entry.id === "video.steer");
	assert.ok(command, "the command must be declared");
	assert.equal(command.effect, "account_write");
	const direction = command.flags?.find((flag) => flag.key === "direction");
	assert.ok(direction, "a direction is the whole instruction");
	assert.equal(direction.required, true);
	// No default: the two directions are opposites, and a caller that forgot to
	// say which one must not get one chosen for it.
	assert.equal(direction.default, undefined);
});

test("the state flag is not required, and defaults to on for the more switch", () => {
	const command = COMMANDS.find((entry) => entry.id === "video.steer");
	const value = command?.flags?.find((flag) => flag.key === "enabled");
	assert.ok(value, "--value is how the more switch is turned off");
	assert.equal(value.required, undefined);
	assert.equal(value.default, true);
});

test("a missing direction is refused before Chrome starts", () => {
	// Refused in validation, which runs before a connection: the failure names the
	// argument instead of surfacing as a page error.
	assert.throws(() => validate("video.steer", { video_id: "12345", request_id: "abcdefgh" }), {
		code: "invalid_argument",
	});
	assert.throws(() => validate("video.steer", { video_id: "12345", direction: "maybe" }), {
		code: "invalid_argument",
	});
});

test("both directions are accepted", () => {
	for (const direction of ["less", "more"])
		assert.equal(
			validate("video.steer", { video_id: "12345", direction, request_id: "abcdefgh" }).direction,
			direction,
		);
});

test("a write needs a request id, and a dry run does not", () => {
	assert.throws(() => validate("video.steer", { video_id: "12345", direction: "less" }), {
		code: "invalid_argument",
	});
	const planned = validate("video.steer", { video_id: "12345", direction: "less", dry_run: true });
	assert.equal(planned.dry_run, true);
});

test("the work is required, and it is resolved the same way every other work is", () => {
	assert.throws(() => validate("video.steer", { direction: "less", request_id: "abcdefgh" }), {
		code: "invalid_argument",
	});
	// A URL is accepted and reduced to the id, so a caller does not have to parse
	// it. This is the same rule comments and likes follow.
	assert.equal(
		validate("video.steer", {
			video_id: "https://www.douyin.com/video/7696822995482682003",
			direction: "less",
			request_id: "abcdefgh",
		}).video_id,
		"7696822995482682003",
	);
});

test("the requested state is part of the request's identity", () => {
	// Asking for "more" and then for "not more" on the same work are opposite
	// instructions. If the fingerprint ignored the state, the second would replay
	// the first's receipt and report success without pressing anything.
	const on = fingerprintOf("7696822995482682003", "more", true);
	const off = fingerprintOf("7696822995482682003", "more", false);
	const less = fingerprintOf("7696822995482682003", "less", true);
	assert.notEqual(on, off);
	assert.notEqual(on, less);
	// The same request is stable, or a retry could never be recognised.
	assert.equal(on, fingerprintOf("7696822995482682003", "more", true));
	// A different work is a different request even in the same direction.
	assert.notEqual(on, fingerprintOf("7696822995482682004", "more", true));
});
