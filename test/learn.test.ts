import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { candidateFindings, keepFindings } from "../src/operations/learn.ts";
import { Workspaces } from "../src/workspace.ts";

// What a round taught has to survive into the next round, or the bot relearns
// the same thing every session. These tests pin what counts as a finding and
// what makes the same finding twice.

async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-learn-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init", { name: "ShuaDouyin" });
	return new Workspaces(base);
}

const failure = (operation: string, code: string) => ({
	id: `e-${operation}-${code}`,
	operation,
	data: { ok: false, error_code: code, error_message: "x" },
});

test("one failure is an incident, two are a property of the page", () => {
	assert.deepEqual(candidateFindings([failure("feed.next", "selector_changed")]), []);
	const twice = candidateFindings([failure("feed.next", "selector_changed"), failure("feed.next", "selector_changed")]);
	assert.equal(twice.length, 1);
	assert.equal(twice[0]?.kind, "gotcha");
	assert.ok(twice[0]?.text.includes("2 次"));
});

test("a failure is read from the event's data, where the store puts it", () => {
	// The first version looked for error_code at the top level; the store writes
	// it inside data, so every failure was silently skipped.
	const event = { id: "x", operation: "chat.send", data: { ok: false, error_code: "draft_conflict", elapsed_ms: 10 } };
	assert.equal(candidateFindings([event]).length, 0);
	assert.equal(candidateFindings([event, event]).length, 1);
});

test("a comment that carried a signal is worth keeping", () => {
	const finding = candidateFindings([
		{ id: "c1", operation: "comment.post", data: { text: "笑死 这不就是我上班的样子" } },
	]);
	assert.equal(finding.length, 1);
	assert.equal(finding[0]?.kind, "method");
	assert.ok(finding[0]?.source.startsWith("event:"));
});

test("a round that mostly skipped says what this account does not want", () => {
	const finding = candidateFindings([
		{ id: "b1", operation: "browse.end", data: { watched: [1], skipped: [1, 2, 3, 4] } },
	]);
	assert.equal(finding.length, 1);
	assert.equal(finding[0]?.kind, "preference");
});

test("a caller's own conclusion is recorded verbatim and marked as authored", async (t) => {
	const workspaces = await setup(t);
	const result = await keepFindings(workspaces, [], { note: "推荐页先读五条再开口" });
	assert.equal(result.findings.length, 1);
	const document = await workspaces.document("lessons.md");
	assert.ok(document.content.includes("推荐页先读五条再开口"));
	// The source says who said it: the tool did not measure this one.
	assert.ok(document.content.includes("caller:note"));
});

test("the same lesson is not recorded twice", async (t) => {
	const workspaces = await setup(t);
	const events = [failure("feed.next", "selector_changed"), failure("feed.next", "selector_changed")];
	await keepFindings(workspaces, events, { note: "先读再动手" });
	const second = await keepFindings(workspaces, events, { note: "先读再动手" });
	assert.equal(second.findings.length, 0);
	assert.equal(second.duplicates.length, 2);
	const document = await workspaces.document("lessons.md");
	assert.equal(document.content.match(/先读再动手/g)?.length, 1);
});

test("a new lesson appends without disturbing the old one", async (t) => {
	const workspaces = await setup(t);
	await keepFindings(workspaces, [], { note: "第一条" });
	await keepFindings(workspaces, [], { note: "第二条" });
	const document = await workspaces.document("lessons.md");
	assert.ok(document.content.indexOf("第一条") < document.content.indexOf("第二条"));
	// Two batches, two headings, one file header.
	assert.equal(document.content.match(/^# 学到的东西$/gm)?.length, 1);
});

test("nothing worth keeping is a refusal, not an empty file", async (t) => {
	const workspaces = await setup(t);
	await assert.rejects(keepFindings(workspaces, []), { code: "not_found" });
});

test("a dry run reports without writing", async (t) => {
	const workspaces = await setup(t);
	const result = await keepFindings(workspaces, [], { note: "只看不写", write: false });
	assert.equal(result.findings.length, 1);
	await assert.rejects(workspaces.document("lessons.md"), { code: "not_found" });
});

test("lessons.md is readable and editable like any other workspace document", async (t) => {
	const workspaces = await setup(t);
	await keepFindings(workspaces, [], { note: "可以改" });
	const document = await workspaces.document("lessons.md");
	// The point of keeping it as a document: a human who disagrees deletes the
	// line, and the tool does not put it back.
	const edited = document.content.replace("- [convention] 可以改", "- 我自己改过的");
	await workspaces.setDocument("lessons.md", edited, document.revision);
	assert.ok((await workspaces.document("lessons.md")).content.includes("我自己改过的"));
});

test("--since limits what counts as this round, rather than only labelling it", async (t) => {
	// The flag was accepted and echoed into a source label while every event was
	// still considered, so a caller that named a start time got findings from
	// everything ever recorded.
	const workspaces = await setup(t);
	const old = {
		id: "old",
		at: "2026-01-01T00:00:00.000Z",
		operation: "feed.next",
		data: { ok: false, error_code: "selector_changed" },
	};
	const recent = { ...old, id: "new", at: "2026-06-01T00:00:00.000Z" };
	const scoped = await keepFindings(workspaces, [old, old, recent, recent], {
		since: "2026-05-01T00:00:00.000Z",
		write: false,
	});
	// Two recent failures are enough for a gotcha; the old pair is out of scope.
	assert.equal(scoped.findings.filter((finding) => finding.kind === "gotcha").length, 1);
	const all = await keepFindings(workspaces, [old, old], { write: false });
	assert.equal(all.findings.filter((finding) => finding.kind === "gotcha").length, 1);
});

test("an invalid --since is refused rather than ignored", async (t) => {
	const workspaces = await setup(t);
	await assert.rejects(keepFindings(workspaces, [], { since: "last tuesday", note: "x" }), {
		code: "invalid_argument",
	});
});
