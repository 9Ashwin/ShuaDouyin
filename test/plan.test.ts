import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { CliError } from "../src/errors.ts";
import { startRound } from "../src/operations/browsing.ts";
import { parsePlan, planIdentity } from "../src/operations/plan.ts";
import { Store } from "../src/store.ts";

// A round's plan says what it delivers and how a candidate is judged. It is
// written once: changing what counts as done halfway through is how a caller
// that is not finding anything lowers the bar and calls it progress.

const valid = {
	version: 1,
	mode: "people",
	objective: "找到可以交流独立游戏开发经验的候选人",
	deliverable: { unit: "person", target: 3 },
	criteria: [
		{ id: "relevant", description: "原作品支持其有独立游戏开发经历" },
		{ id: "topic", description: "能指出一个可具体交流的共同话题" },
	],
	constraints: ["本轮只读，交付候选及话题"],
	policy: {
		batch_size: 5,
		max_inspections_per_batch: 2,
		max_no_progress_batches: 2,
		max_route_changes: 2,
		max_browser_calls: 40,
	},
};

const rejects = (raw: unknown, pattern?: RegExp) => {
	assert.throws(
		() => parsePlan(raw),
		(error: unknown) => {
			assert.ok(error instanceof CliError);
			assert.equal(error.code, "invalid_argument");
			if (pattern) assert.match(error.message, pattern);
			return true;
		},
	);
};

test("a well-formed plan parses with every field intact", () => {
	const plan = parsePlan(valid);
	assert.equal(plan.mode, "people");
	assert.equal(plan.deliverable.target, 3);
	assert.equal(plan.criteria.length, 2);
});

test("an unknown field is refused rather than ignored", () => {
	// A misspelled `max_route_changes` would otherwise run with the default and
	// never change route, and nothing in the output would say why.
	rejects({ ...valid, max_route_changes: 2 }, /Unknown plan field/);
});

test("a plan from another version is not read as this one", () => {
	rejects({ ...valid, version: 2 });
});

test("the mode has to be one of the four this tool knows", () => {
	rejects({ ...valid, mode: "browse" });
});

test("delivery target and policy bounds are input limits, not suggestions", () => {
	rejects({ ...valid, deliverable: { unit: "person", target: 0 } });
	rejects({ ...valid, deliverable: { unit: "person", target: 101 } });
	rejects({ ...valid, deliverable: { unit: "user", target: 3 } });
	rejects({ ...valid, policy: { ...valid.policy, batch_size: 21 } });
	rejects({ ...valid, policy: { ...valid.policy, max_browser_calls: 0 } });
});

test("inspecting more than the batch is refused, because it means inspecting twice", () => {
	rejects({ ...valid, policy: { ...valid.policy, max_inspections_per_batch: 6 } });
});

test("criteria ids have to be unique, because a checkpoint cites them", () => {
	rejects(
		{ ...valid, criteria: [...valid.criteria, { id: "relevant", description: "另一个说法" }] },
		/appears more than once/,
	);
});

test("a criterion needs a description, and there have to be one to ten", () => {
	rejects({ ...valid, criteria: [] });
	rejects({ ...valid, criteria: [{ id: "a", description: "" }] });
});

test("plan identity ignores key order but not criterion content", () => {
	// Two writers producing the same plan must compare equal; rewording a
	// criterion is a different round.
	const reordered = {
		policy: valid.policy,
		constraints: valid.constraints,
		criteria: valid.criteria,
		deliverable: valid.deliverable,
		objective: valid.objective,
		mode: "people",
		version: 1,
	};
	assert.equal(planIdentity(parsePlan(valid)), planIdentity(parsePlan(reordered)));
	const reworded = { ...valid, criteria: [{ id: "relevant", description: "换个说法" }, valid.criteria[1]] };
	assert.notEqual(planIdentity(parsePlan(valid)), planIdentity(parsePlan(reworded)));
});

test("resuming with the same plan returns the open round", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-plan-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new Store(base);
	const plan = parsePlan(valid);
	const first = (await startRound(store, { works: 5, plan })) as { id: string };
	const second = (await startRound(store, { works: 5, plan })) as { id: string; resumed?: boolean };
	assert.equal(second.id, first.id);
	assert.equal(second.resumed, true);
});

test("resuming with a different plan is a conflict, not a merge", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-plan-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new Store(base);
	await startRound(store, { plan: parsePlan(valid) });
	const different = parsePlan({ ...valid, objective: "找别的人" });
	await assert.rejects(startRound(store, { plan: different }), { code: "revision_conflict" });
});

test("a stated budget that disagrees with the open round is a conflict", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-plan-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new Store(base);
	await startRound(store, { works: 5 });
	await assert.rejects(startRound(store, { works: 9, explicit: { works: true } }), { code: "revision_conflict" });
});

test("a default the parser filled in is not a stated budget", async (t) => {
	// Commander puts 30 in the field when nothing was typed. Treating that as a
	// requirement would widen a resumed five-minute round to thirty minutes.
	const base = await mkdtemp(join(tmpdir(), "dy-plan-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new Store(base);
	await startRound(store, { works: 5 });
	const resumed = (await startRound(store, { works: 30, explicit: { works: false } })) as { resumed?: boolean };
	assert.equal(resumed.resumed, true);
});

test("a plan file goes through the same validation as an inline plan", async (t) => {
	// The command path is where a caller actually arrives; testing only parsePlan
	// would leave the wiring unproven.
	const base = await mkdtemp(join(tmpdir(), "dy-plan-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	const file = join(base, "plan.json");
	await writeFile(file, JSON.stringify(valid), "utf8");
	const started = (await app.execute("browse.start", { budget: 5, text_file: file })) as {
		id: string;
		plan?: { mode: string };
	};
	assert.equal(started.plan?.mode, "people");
	// A bad plan is refused before any round is written.
	const bad = join(base, "bad.json");
	await writeFile(bad, JSON.stringify({ ...valid, version: 9 }), "utf8");
	await assert.rejects(app.execute("browse.start", { text_file: bad }), { code: "invalid_argument" });
});
