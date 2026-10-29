import assert from "node:assert/strict";
import test from "node:test";
import { stableId } from "../src/page/dom.ts";

// stableId exists because the conversation record's id has been renamed more
// than once: a direct chat keeps conversationId/conversationShortId, a group
// keeps plain id/shortId, and all of them live on the prototype. Each rename
// silently broke a lookup that named the field.

test("the same id under either naming is found", () => {
	const direct = { conversationId: "0:1:105358793304:1543352384762973" };
	const group = { id: "7701367822991049270" };
	assert.equal(stableId(direct), "0:1:105358793304:1543352384762973");
	assert.equal(stableId(group), "7701367822991049270");
});

test("an id on the prototype is found, not only an own property", () => {
	const proto = { id: "7701367822991049270", shortId: "7701367822991049270" };
	const record = Object.create(proto) as object;
	Object.assign(record, { name: "a group" });
	assert.equal(stableId(record), "7701367822991049270");
});

test("a renamed field is found by its shape", () => {
	// The failure this guards: a future build calls it something new and every
	// lookup by name returns nothing.
	assert.equal(stableId({ chatId: "7701367822991049270" }), "7701367822991049270");
	assert.equal(stableId({ conversationShortId: "7641224563304546851" }), "7641224563304546851");
});

test("two different ids are refused rather than guessed", () => {
	// Picking one would send to whichever field happened to come first.
	assert.equal(stableId({ id: "7701367822991049270", otherId: "7641224563304546851" }), null);
});

test("a count is not an identity", () => {
	// participantCount and similar fields are numbers too; a five-digit floor is
	// what keeps them out.
	assert.equal(stableId({ participantCount: 11 }), null);
	assert.equal(stableId({ memberId: 42 }), null);
});

test("a getter is read, and a throwing getter does not break the scan", () => {
	const withGetter = {
		get id() {
			return "7701367822991049270";
		},
	};
	assert.equal(stableId(withGetter), "7701367822991049270");
	const hostile = {
		get id(): string {
			throw new Error("page code");
		},
		someId: "7701367822991049270",
	};
	assert.equal(stableId(hostile), "7701367822991049270");
});

test("a preferred name wins when it is unambiguous", () => {
	const record = { id: "7701367822991049270", groupId: "7701367822991049270" };
	assert.equal(stableId(record, ["groupId"]), "7701367822991049270");
});
