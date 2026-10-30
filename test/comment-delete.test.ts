import assert from "node:assert/strict";
import test from "node:test";
import { COMMANDS } from "../src/catalog.ts";
import { isWrite } from "../src/operations/validate.ts";

// Deleting a comment is the only operation here the page does not confirm before
// performing. Every guarantee against deleting the wrong one therefore lives in
// this tool, so what the command declares about itself is a safety property.

test("deleting is classified as a write, so it passes the pause and quota gates", () => {
	// A read-classified delete would skip the gates every other outward action
	// passes through.
	assert.equal(isWrite("comment.delete"), true);
});

test("the command requires an explicit acknowledgement", () => {
	const command = COMMANDS.find((entry) => entry.id === "comment.delete");
	assert.ok(command, "the command must be declared");
	assert.equal(command.effect, "account_write");
	const confirm = command.flags?.find((flag) => flag.key === "confirm");
	assert.ok(confirm, "deleting without an acknowledgement must not be possible");
	assert.equal(confirm.type, "boolean");
	// Default off: the caller has to say it means it.
	assert.equal(confirm.default, false);
});

test("the command names the comment it deletes by id, never by name", () => {
	const command = COMMANDS.find((entry) => entry.id === "comment.delete");
	const commentId = command?.flags?.find((flag) => flag.key === "comment_id");
	assert.ok(commentId, "a stable comment id is required");
	assert.equal(commentId.required, true);
	// A display name must not be an accepted handle: two people can share one.
	const names = command?.flags?.filter((flag) => /author|name|user/i.test(String(flag.key))) ?? [];
	assert.deepEqual(names, []);
});

test("the guidance says it cannot be undone and that the page does not ask", () => {
	// The reason this command exists at all: a reader has to know the page will not
	// warn them, because nothing else in the flow will.
	const command = COMMANDS.find((entry) => entry.id === "comment.delete");
	const guidance = command?.guidance ?? "";
	assert.match(guidance, /cannot be undone/i);
	assert.match(guidance, /no confirmation/i);
	assert.match(guidance, /own/i);
});
