import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.ts";
import { validateKnowledge } from "../src/knowledge.ts";
import { DOCUMENTS } from "../src/workspace.ts";

// validateKnowledge is the boundary in front of the local commands — memory,
// workspace documents and reports. Nothing downstream re-checks its input, so a
// rule missing here is a rule that does not exist. The cases below are grouped
// by what they put at risk rather than by which check runs first.

const rejects = (operation: string, input: Record<string, unknown>, code = "invalid_argument") => {
	assert.throws(
		() => validateKnowledge(operation, input as never),
		(error: unknown) => {
			assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
			assert.equal(error.code, code);
			return true;
		},
	);
};

const accepts = (operation: string, input: Record<string, unknown>) => {
	assert.doesNotThrow(() => validateKnowledge(operation, input as never));
};

test("a preset has to be one this tool ships", () => {
	accepts("bot.init", { preset: "observer" });
	rejects("bot.init", { preset: "friendly" });
	// The check is against the object's own keys, so a prototype name is refused
	// rather than found.
	rejects("bot.init", { preset: "constructor" });
});

test("a bot name has to be something a person would type", () => {
	accepts("bot.init", { name: "猫猫" });
	rejects("bot.init", { name: "   " });
	rejects("bot.init", { name: "x".repeat(201) });
});

test("a growth event id has to be the one growth review issued", () => {
	accepts("growth.ack", { event_id: "0f9c1d2e-3a4b-5c6d-7e8f-90a1b2c3d4e5" });
	rejects("growth.ack", { event_id: "42" });
	rejects("growth.event", { event_id: "0F9C1D2E-3A4B-5C6D-7E8F-90A1B2C3D4E5" });
	rejects("growth.event", {});
});

test("a memory id is required for every command that names one", () => {
	for (const operation of ["memory.get", "memory.update", "memory.delete", "memory.history"]) {
		// update and delete also require text and source plus the revision, so the
		// accepted case carries everything the command needs; the id is what
		// varies below.
		accepts(operation, { resource: "mem_a1b2c3d4", text: "一段", source: "user:test", if_match: "rev" });
		rejects(operation, { resource: "一", text: "一段", source: "user:test", if_match: "rev" });
		rejects(operation, { text: "一段", source: "user:test", if_match: "rev" });
	}
});

test("layer, type, certainty and confidence are closed vocabularies", () => {
	accepts("memory.add", { text: "一段", source: "user:test", layer: "note", certainty: "inferred" });
	rejects("memory.add", { text: "一段", source: "user:test", layer: "nowhere" });
	rejects("memory.add", { text: "一段", source: "user:test", memory_type: "guess" });
	rejects("memory.add", { text: "一段", source: "user:test", certainty: "probably" });
	rejects("memory.add", { text: "一段", source: "user:test", confidence: 1.5 });
	rejects("memory.add", { text: "一段", source: "user:test", confidence: -0.1 });
});

test("a memory has to say where it came from", () => {
	// The source is what makes a memory checkable later, so an empty one is a
	// refusal rather than a default of "unknown".
	accepts("memory.add", { text: "一段", source: "user:test" });
	rejects("memory.add", { text: "一段" });
	rejects("memory.add", { text: "一段", source: "   " });
	rejects("memory.add", { text: "一段", source: "line\nbreak" });
	rejects("memory.add", { text: "一段", source: "x".repeat(2049) });
});

test("what the user stated has to cite the user", () => {
	accepts("memory.add", { text: "一段", source: "user:test", certainty: "user-stated" });
	rejects("memory.add", { text: "一段", source: "file:memory/bot/AGENTS.md", certainty: "user-stated" });
});

test("a memory body is required and bounded", () => {
	rejects("memory.add", { text: "   ", source: "user:test" });
	rejects("memory.add", { text: "a\0b", source: "user:test" });
	rejects("memory.add", { text: "x".repeat(65537), source: "user:test" });
});

test("tags are labels, and an empty one is a typo rather than a label", () => {
	accepts("memory.add", { text: "一段", source: "user:test", tags: "旅行, 城市" });
	rejects("memory.add", { text: "一段", source: "user:test", tags: "旅行,,城市" });
	rejects("memory.add", { text: "一段", source: "user:test", tags: "旅行, " });
	rejects("memory.add", { text: "一段", source: "user:test", tags: `${"标".repeat(61)}` });
	rejects("memory.add", {
		text: "一段",
		source: "user:test",
		tags: Array.from({ length: 21 }, (_, index) => `标${index}`).join(","),
	});
});

test("a link has to point at a memory that could exist", () => {
	accepts("memory.add", { text: "一段", source: "user:test", links: "mem_a1b2c3d4, mem_e5f6a7b8" });
	rejects("memory.add", { text: "一段", source: "user:test", links: "mem_a1b2c3d4, 一" });
});

test("changing or removing a memory requires the revision that was read", () => {
	// Without it a correction overwrites an edit that happened in between.
	accepts("memory.update", { resource: "mem_a1b2c3d4", text: "一段", source: "user:test", if_match: "rev" });
	rejects("memory.update", { resource: "mem_a1b2c3d4", text: "一段", source: "user:test" });
	rejects("memory.delete", { resource: "mem_a1b2c3d4" });
});

test("a profile reference has to name a person or a group", () => {
	accepts("memory.list", { profile_ref: "user:author_123" });
	accepts("memory.list", { profile_ref: "group:friends" });
	rejects("memory.list", { profile_ref: "author_123" });
	rejects("memory.list", { profile_ref: "user:" });
});

test("the context budget is bounded on both ends", () => {
	accepts("context.show", { budget: 100 });
	accepts("context.show", { budget: 20000 });
	rejects("context.show", { budget: 99 });
	rejects("context.show", { budget: 20001 });
	rejects("context.show", { budget: 500.5 });
});

test("a candidates payload has to be supplied as text", () => {
	for (const operation of ["memory.candidates", "memory.decide"]) {
		accepts(operation, { text: "[]" });
		rejects(operation, {});
		rejects(operation, { text: "   " });
	}
	rejects("memory.decision-status", {});
	accepts("memory.decision-status", { request_id: "abcdefgh" });
});

test("MEMORY.md is generated, so it cannot be written or restored by hand", () => {
	// Writing it directly would be undone by the next reindex and would disagree
	// with the memory files until then.
	rejects("workspace.set", { resource: "MEMORY.md", text: "内容" });
	rejects("workspace.history", { resource: "MEMORY.md" });
	rejects("workspace.restore", { resource: "MEMORY.md", revision: "a".repeat(64) });
});

test("a workspace document has to be one that exists", () => {
	// MEMORY.md is on the list of documents but is generated, so writing it is
	// refused by the rule above — the list and the writable set are not the same.
	for (const document of DOCUMENTS.filter((name) => name !== "MEMORY.md"))
		accepts("workspace.set", { resource: document, text: "内容" });
	rejects("workspace.set", { resource: "MEMORY.md", text: "内容" });
	rejects("workspace.set", { resource: "NOTES.md", text: "内容" });
	rejects("workspace.get", { resource: "NOTES.md" });
	rejects("workspace.get", {});
});

test("a restore names a revision by its hash", () => {
	accepts("workspace.restore", { resource: "AGENTS.md", revision: "a".repeat(64) });
	rejects("workspace.restore", { resource: "AGENTS.md", revision: "abc" });
	rejects("workspace.restore", { resource: "AGENTS.md" });
});

test("a document write needs text and a bounded amount of it", () => {
	rejects("workspace.set", { resource: "AGENTS.md" });
	rejects("workspace.set", { resource: "AGENTS.md", text: "   " });
	rejects("workspace.set", { resource: "AGENTS.md", text: "x".repeat(65537) });
	rejects("report.save", { resource: "2026-01-01", text: "" });
});

test("a report is addressed by a date", () => {
	accepts("report.get", { resource: "2026-01-01" });
	rejects("report.get", { resource: "yesterday" });
	rejects("report.get", { resource: "2026-13-01" });
});

test("a later page of a report needs the revision from the first", () => {
	rejects("report.prepare", { resource: "2026-01-01", offset: 20 }, "revision_required");
	accepts("report.prepare", { resource: "2026-01-01", offset: 20, if_match: "rev-1" });
});

test("commands outside these families are left to their own validation", () => {
	// Membership in the catalogue is what decides whether a command runs at all;
	// this function only adds rules for the families it knows.
	accepts("video.info", {});
	accepts("feed.next", {});
});
