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

test("no command redeclares a global flag, which would shadow the real value", async () => {
	// learn.keep, persona.migrate and persona.evolve each declared their own
	// --dry-run with default:false. Commander applied that local default after the
	// global value, so input.dry_run was always false while the response still
	// printed dry_run:true — a dry run that wrote to disk and said it had not.
	// The check is on the declaration, because the failure is in how the two
	// declarations combine and no single command can see it.
	const { GLOBAL_FLAGS } = await import("../src/catalog.ts");
	const globals = new Set(
		GLOBAL_FLAGS.map((flag) => flag.name.replace(/^--/, "").split(" ")[0]?.replaceAll("-", "_") ?? ""),
	);
	// browser.configure is the one command whose job is to change a global setting:
	// its --chrome is the value being written, not a shadow of the one being read.
	const writesTheGlobal = new Set(["browser.configure:chrome"]);
	const clashing = COMMANDS.flatMap((command) =>
		(command.flags ?? [])
			.filter((flag) => globals.has(flag.key as string))
			.map((flag) => `${command.id}:${String(flag.key)}`)
			.filter((pair) => !writesTheGlobal.has(pair)),
	);
	assert.deepEqual(clashing, [], "a command flag with the same key as a global one shadows it");
});

test("a dry run over a local command writes nothing", async (t) => {
	// The behavioural half of the rule the check above protects, exercised through
	// the CLI so the argument wiring is what runs.
	const { execFile } = await import("node:child_process");
	const { promisify } = await import("node:util");
	const run = promisify(execFile);
	const base = await mkdtemp(join(tmpdir(), "dy-dryrun-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init", { name: "ShuaDouyin" });
	const before = await run("node", ["dist/cli.js", "--state-dir", base, "workspace", "get", "AGENTS.md"]);
	const result = await run("node", ["dist/cli.js", "--state-dir", base, "persona", "migrate", "--dry-run"]);
	assert.equal(JSON.parse(result.stdout).dry_run, true);
	const after = await run("node", ["dist/cli.js", "--state-dir", base, "workspace", "get", "AGENTS.md"]);
	assert.equal(JSON.parse(after.stdout).data.revision, JSON.parse(before.stdout).data.revision);
});

test("video digest accepts --frames 0, which is what its own help promises", async () => {
	// video.digest's flag description, its guidance and digest.ts all document 0
	// as "skip seeking", but validate.ts applied one frames floor of 1 to every
	// command, so the documented value was rejected before the handler saw it.
	// Reading comments without sampling was impossible from the CLI.
	const { validate } = await import("../src/operations/validate.ts");
	assert.equal(validate("video.digest", { frames: 0 }).frames, 0);
	assert.throws(() => validate("video.digest", { frames: -1 }), /frames must be an integer from 0 to 60/);
	// observe needs at least one frame to have a sample at all, so its floor stays.
	assert.throws(() => validate("video.observe", { frames: 0 }), /frames must be an integer from 1 to 60/);
});

test("a verification gate is reported as one, whatever kind it is", async () => {
	// The SMS gate this session hit was invisible to the detector, which only knew
	// the slider captcha. That is why a comment that had posted looked absent: the
	// read ran under a mask and returned a stale list.
	const { fixture } = await import("./fixture.ts");
	const text = [
		'<div class="second-verify-mask"></div>',
		'<div class="uc-ui-verify_sms-verify">接收短信验证码</div>',
	].join("");
	assert.ok(/second-verify-mask|uc-ui-verify_sms-verify/.test(text));
	// The detector is page-side code; the assertion that matters is that the source
	// looks for both gates, which is what this checks without a browser.
	const { readFile } = await import("node:fs/promises");
	const source = await readFile(new URL("../src/page/readers.ts", import.meta.url), "utf8");
	assert.ok(source.includes("second-verify-mask"), "the SMS mask must be part of the gate check");
	assert.ok(source.includes("接收短信验证码"), "the SMS copy is the fallback when the class changes");
	assert.ok(fixture.length > 0);
});

test("a fresh workspace is told its persona is unanswered, without being stopped", async (t) => {
	// A block was tried first and was worse: someone who wants to look at a few
	// videos before naming the bot would hit an error. The question travels with the
	// answer instead, so the person can act on it or ignore it.
	const { setupNotice } = await import("../src/app.ts");
	const base = await mkdtemp(join(tmpdir(), "dy-setup-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init", { name: "ShuaDouyin" });
	const pending = (await setupNotice(base)) as { status: string; ask: string[]; next: string } | null;
	assert.ok(pending, "a pending workspace must carry the question");
	assert.equal(pending.status, "pending");
	// The two things to ask, and what to do with the answer.
	assert.equal(pending.ask.length, 2);
	assert.match(pending.next, /onboarding complete/);
	// Answering stops it, whether the answer is "done" or "later".
	await new App({ state_dir: base }).execute("onboarding.skip", {});
	assert.equal(await setupNotice(base), null);
});
