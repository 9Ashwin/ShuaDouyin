import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { checkpointProgress, recordCheckpoint, roundRevision, startRound } from "../src/operations/browsing.ts";
import { parseCheckpoint, qualifies } from "../src/operations/checkpoint.ts";
import { parsePlan } from "../src/operations/plan.ts";
import { Store } from "../src/store.ts";

// One batch as the caller judged it.
//
// The rules worth a test are the refusals. A checkpoint that cites a criterion
// the plan does not have is evidence for an unasked question. A claim with no
// source is the exact thing this command exists to stop. And progress has to be
// derived rather than asserted, or a caller could manufacture it by repeating
// itself.

const plan = parsePlan({
	version: 1,
	mode: "people",
	objective: "找可以聊独立游戏开发的人",
	deliverable: { unit: "person", target: 2 },
	criteria: [
		{ id: "relevant", description: "有开发经历" },
		{ id: "topic", description: "有可聊的话题" },
	],
	constraints: [],
	policy: {
		batch_size: 5,
		max_inspections_per_batch: 2,
		max_no_progress_batches: 2,
		max_route_changes: 2,
		max_browser_calls: 40,
	},
});

const SOURCE = "event:default:00000000-0000-4000-8000-000000000001";

const batch = (overrides: Record<string, unknown> = {}) => ({
	version: 1,
	checkpoint_id: "batch-1",
	route: { kind: "search", query: "独立游戏", reason: "直接找发过开发内容的人" },
	observation_sources: [SOURCE],
	diagnostic_sources: [],
	assessments: [
		{
			entity_ref: "person:MS4wLjABAAAAauthor01",
			shortlisted: true,
			excluded: false,
			criteria: [
				{ id: "relevant", status: "supported", sources: [{ source: SOURCE, entity_ref: "work:111" }], note: "" },
				{ id: "topic", status: "supported", sources: [{ source: SOURCE, entity_ref: "work:111" }], note: "" },
			],
		},
	],
	next: { step: "finish", reason: "够了" },
	...overrides,
});

const rejects = (raw: unknown, pattern?: RegExp, code = "invalid_argument") => {
	assert.throws(
		() => parseCheckpoint(raw, plan),
		(error: unknown) => {
			assert.ok(error instanceof Error && "code" in error);
			assert.equal((error as { code: string }).code, code);
			if (pattern) assert.match((error as Error).message, pattern);
			return true;
		},
	);
};

test("a well-formed batch parses", () => {
	const parsed = parseCheckpoint(batch(), plan);
	assert.equal(parsed.checkpoint_id, "batch-1");
	assert.equal(parsed.assessments.length, 1);
});

test("a criterion the plan does not have is refused", () => {
	// Supporting a question nobody asked is not evidence, and storing it would
	// make the round look further along than it is. The batch keeps the plan's
	// length so the count check does not answer first, which would hide this one.
	const raw = batch();
	const criteria = (raw.assessments as { criteria: Record<string, unknown>[] }[])[0]?.criteria;
	if (criteria)
		criteria[1] = { id: "charming", status: "supported", sources: [{ source: SOURCE, entity_ref: "work:111" }] };
	rejects(raw, /not in the plan/);
});

test("an assessment that skips a criterion is refused before the criterion is even read", () => {
	// The count check runs first and says something more useful than "criterion
	// not in plan" would: it names what is wrong with the batch, not with an id.
	const raw = batch();
	(raw.assessments as { criteria: unknown[] }[])[0]?.criteria.pop();
	rejects(raw, /must assess all/);
});

test("a criterion marked supported with no source is refused", () => {
	// This is the one assertion the whole command exists to prevent.
	const raw = batch();
	const first = (raw.assessments as { criteria: { status: string; sources: unknown[] }[] }[])[0];
	const criterion = first?.criteria[0];
	if (!criterion) throw new Error("fixture shape changed");
	criterion.sources.splice(0);
	rejects(raw, /cites no source/);
});

test("unknown is how a missing answer is recorded, and needs no source", () => {
	const raw = batch();
	const criterion = (raw.assessments as { criteria: Record<string, unknown>[] }[])[0]?.criteria[1];
	if (criterion) {
		criterion.status = "unknown";
		criterion.sources = [];
	}
	assert.equal(parseCheckpoint(raw, plan).assessments[0]?.criteria[1]?.status, "unknown");
});

test("a partial assessment is refused when the round has a plan", () => {
	// "Assessed two of three criteria" cannot be told apart from "forgot one".
	const raw = batch();
	(raw.assessments as { criteria: unknown[] }[])[0]?.criteria.pop();
	rejects(raw, /must assess all/);
});

test("an exclusion needs a reason, because it has to be revisitable", () => {
	const raw = batch();
	(raw.assessments as Record<string, unknown>[])[0]!.excluded = true;
	rejects(raw, /exclude_reason is required/);
});

test("the same entity twice in one batch is refused", () => {
	const raw = batch();
	const first = (raw.assessments as unknown[])[0];
	(raw.assessments as unknown[]).push(structuredClone(first));
	rejects(raw, /more than once/);
});

test("a batch with no sources cannot carry assessments", () => {
	// Otherwise a caller can submit findings for a batch that never looked.
	rejects(batch({ observation_sources: [], diagnostic_sources: [] }), /cannot carry assessments/);
});

test("a batch with no sources can still finish", () => {
	const parsed = parseCheckpoint(
		batch({
			observation_sources: [],
			diagnostic_sources: [],
			assessments: [],
			next: { step: "finish", reason: "没找到" },
		}),
		plan,
	);
	assert.equal(parsed.next.step, "finish");
});

test("only every criterion supported counts as a qualified delivery", () => {
	const parsed = parseCheckpoint(batch(), plan);
	assert.equal(qualifies(parsed.assessments[0]!, plan), true);
	const partial = batch();
	(partial.assessments as { criteria: Record<string, unknown>[] }[])[0]!.criteria[1]!.status = "unknown";
	assert.equal(qualifies(parseCheckpoint(partial, plan).assessments[0]!, plan), false);
});

test("an excluded candidate is not a delivery even when it meets everything", () => {
	const parsed = parseCheckpoint(batch(), plan);
	assert.equal(qualifies({ ...parsed.assessments[0]!, excluded: true }, plan), false);
});

test("progress is derived: repeating a batch is not progress", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-cp-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const store = new Store(base);
	const round = (await startRound(store, { plan })) as { id: string };
	await recordCheckpoint(store, round.id, batch(), roundRevision(await store.events(), round.id));
	const revision = roundRevision(await store.events(), round.id);
	const second = (await recordCheckpoint(store, round.id, batch({ checkpoint_id: "batch-2" }), revision)) as {
		progress: { no_progress_batches: number; qualified: number; batches: number };
	};
	assert.equal(second.progress.batches, 2);
	assert.equal(second.progress.qualified, 1, "the same person twice is one delivery");
	assert.equal(second.progress.no_progress_batches, 1);
});

test("assessing the same entity again updates it rather than adding a delivery", () => {
	const first = parseCheckpoint(batch(), plan);
	const second = parseCheckpoint(
		batch({
			checkpoint_id: "batch-2",
			assessments: [
				{
					entity_ref: "person:MS4wLjABAAAAauthor01",
					shortlisted: true,
					excluded: true,
					exclude_reason: "聊过，不合适",
					criteria: [
						{ id: "relevant", status: "supported", sources: [{ source: SOURCE, entity_ref: "work:111" }] },
						{ id: "topic", status: "supported", sources: [{ source: SOURCE, entity_ref: "work:111" }] },
					],
				},
			],
		}),
		plan,
	);
	const round = {
		id: "r",
		started_at: "",
		ended_at: null,
		budget: { works: 30, minutes: 30, idle: 5 },
		goal: null,
		status: "open" as const,
		end_reason: null,
		plan,
	};
	const progress = checkpointProgress([first, second], round);
	assert.equal(progress.batches, 2);
	assert.equal(progress.qualified, 0, "the later assessment replaces the earlier one");
	assert.equal(progress.excluded, 1);
});

test("a route is a change only when it actually differs from the last one", () => {
	const round = {
		id: "r",
		started_at: "",
		ended_at: null,
		budget: { works: 30, minutes: 30, idle: 5 },
		goal: null,
		status: "open" as const,
		end_reason: null,
		plan,
	};
	const same = [parseCheckpoint(batch(), plan), parseCheckpoint(batch({ checkpoint_id: "b2" }), plan)];
	assert.equal(checkpointProgress(same, round).route_changes, 0, "the first route is not a change");
	const changed = [
		...same,
		parseCheckpoint(batch({ checkpoint_id: "b3", route: { kind: "feed", reason: "换个来源" } }), plan),
	];
	assert.equal(checkpointProgress(changed, round).route_changes, 1);
});

test("the command refuses a closed round", async (t) => {
	// The whole path: plan file, start, close, then a batch arriving too late.
	const base = await mkdtemp(join(tmpdir(), "dy-cp-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	const round = (await startRound(new Store(base), { plan })) as { id: string };
	await app.execute("browse.end", { resource: round.id, reason: "done" });
	const checkpoint = join(base, "cp.json");
	await writeFile(checkpoint, JSON.stringify(batch()), "utf8");
	await assert.rejects(app.execute("browse.checkpoint", { resource: round.id, text_file: checkpoint }), {
		code: "state",
	});
});
