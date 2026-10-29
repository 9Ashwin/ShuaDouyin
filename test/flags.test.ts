import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { COMMANDS } from "../src/catalog.ts";
import type { Input } from "../src/operations/validate.ts";

// A flag that is accepted and then ignored is worse than a missing one: the
// caller believes it took effect and nothing says otherwise. Two were found this
// way — `learn keep --since` filtered nothing while claiming to, and a document
// list had drifted apart in three places.
//
// A static scan for "is this key read anywhere" was tried first and was useless:
// every key appears somewhere, so it reported either everything or nothing useful.
// These tests run the command with the flag and without it, and compare. That is
// slower and it is the only version that can be wrong in the direction that
// matters.

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-flags-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	return app;
}

const items = (result: unknown) => {
	const data = result as { items?: unknown[] } | unknown[];
	return Array.isArray(data) ? data : (data?.items ?? []);
};

test("memory list --limit changes how many come back", async (t) => {
	const app = await workspace(t);
	for (const text of ["一", "二", "三", "四", "五"])
		await app.execute("memory.add", { text, source: "user:test", layer: "note" });
	const all = items(await app.execute("memory.list", {}));
	const two = items(await app.execute("memory.list", { limit: 2 }));
	assert.equal(all.length, 5);
	assert.equal(two.length, 2);
});

test("memory list --layer actually filters rather than being accepted", async (t) => {
	const app = await workspace(t);
	await app.execute("memory.add", { text: "简短的偏好", source: "user:test", layer: "preference" });
	await app.execute("memory.add", { text: "在写作", source: "user:test", layer: "activity" });
	const layer = async (input: Input) =>
		items(await app.execute("memory.list", input)).map((row) => (row as { layer?: string }).layer);
	const all = await layer({});
	const only = await layer({ layer: "preference" });
	assert.equal(all.length, 2);
	assert.deepEqual(only, ["preference"]);
});

test("learn keep --since leaves out activity from before it", async (t) => {
	// The specific bug this guards: the flag reached the handler, was echoed into
	// a source label, and filtered nothing.
	const app = await workspace(t);
	await app.execute("learn.keep", { note: "现在这条" });
	const found = (result: unknown) => (result as { findings?: { text: string }[] }).findings ?? [];
	const fromNow = found(
		await app.execute("learn.keep", { note: "未来的事", since: new Date(Date.now() + 86_400_000).toISOString() }),
	);
	// Nothing is after tomorrow, so only the note itself (which is caller-authored,
	// not measured from activity) can appear — and it must not echo old activity.
	assert.equal(fromNow.filter((finding) => finding.text !== "未来的事").length, 0);
});

test("persona evolve --dry-run writes nothing", async (t) => {
	const app = await workspace(t);
	const before = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	// A dry run answers a plan rather than running the command, so the way to see
	// that it wrote nothing is the document's own revision.
	await app.execute("persona.evolve", { dry_run: true });
	const after = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	assert.equal(after.revision, before.revision);
});

test("every command declares an effect the dispatcher understands", () => {
	// An effect the app does not route means the command falls through to the
	// browser dispatcher and can only answer "Unknown operation" — which is what
	// persona.migrate did until the local list was widened.
	const known = new Set(["read", "navigation", "local", "account_write"]);
	for (const command of COMMANDS) assert.ok(known.has(command.effect), `${command.id} has effect ${command.effect}`);
});
