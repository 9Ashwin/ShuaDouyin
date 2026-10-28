import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { withDatabase } from "../src/database.ts";
import { Store } from "../src/store.ts";
import { Workspaces } from "../src/workspace.ts";

type Saved = { id: string; revision: string; file: string; sources: string[]; body: string };
async function setup(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-formation-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	return { base, app: new App({ state_dir: base }) };
}
const facts = [
	{ text: "小林喜欢喝绿茶", sources: ["user:conversation:tea"], keywords: ["绿茶"], profile_ref: "user:owner" },
];
const request = (decision: Record<string, unknown>) => JSON.stringify({ facts, decision });

test("external agent can recall, decide a sourced fact, and recall it next time", async (t) => {
	const { app } = await setup(t);
	const before = (await app.execute("context.show", { query: "小林喜欢什么茶", profile_ref: "user:owner" })) as {
		memories: unknown[];
	};
	assert.equal(before.memories.length, 0);
	await app.execute("memory.candidates", { text: JSON.stringify({ facts }) });
	const saved = (await app.execute("memory.decide", {
		text: request({
			action: "ADD",
			source_fact_indices: [0],
			text: "小林喜欢喝绿茶",
			layer: "preference",
			certainty: "user-stated",
		}),
		apply: true,
		request_id: "agent-recall-flow-001",
	})) as { result: { id: string } };
	const next = (await app.execute("context.show", { query: "小林喜欢什么茶", profile_ref: "user:owner" })) as {
		memories: { id: string; sources: string[] }[];
	};
	assert.ok(
		next.memories.some((memory) => memory.id === saved.result.id && memory.sources.includes("user:conversation:tea")),
	);
});

test("deterministic decision ID never overwrites an unrelated memory path", async (t) => {
	const { base, app } = await setup(t);
	const existing = (await app.execute("memory.add", {
		text: "保留已有内容",
		subject: "other",
		source: "user:existing",
	})) as Saved;
	const requestID = "collision-add-001";
	const id = `mem_${createHash("sha256").update(`default\0${requestID}`).digest("hex").slice(0, 40)}`;
	const destination = join(new Workspaces(base).root(), "memory", "note", `self-${id}.md`);
	await rename(existing.file, destination);
	const before = await readFile(destination, "utf8");
	const facts = [{ text: "新事实", sources: ["user:new"] }];
	const text = JSON.stringify({ facts, decision: { action: "ADD", source_fact_indices: [0], text: "新事实" } });
	await assert.rejects(app.execute("memory.decide", { text, apply: true, request_id: requestID }), {
		code: "revision_conflict",
	});
	assert.equal(await readFile(destination, "utf8"), before);
	assert.equal(((await app.execute("memory.get", { resource: existing.id })) as Saved).body, "保留已有内容");
});

test("candidates use bounded lexical and reference recall without changing state", async (t) => {
	const { base, app } = await setup(t);
	const adjacent = (await app.execute("memory.add", {
		text: "另一条相关记录",
		source: "user:one",
		profile_ref: "user:owner",
		subject: "记录",
	})) as Saved;
	const match = (await app.execute("memory.add", {
		text: "小林经常喝绿茶",
		source: "user:two",
		profile_ref: "user:owner",
		links: adjacent.id,
	})) as Saved;
	await app.execute("memory.add", { text: "朋友也喝绿茶", source: "user:three", profile_ref: "user:friend" });
	const root = new Workspaces(base).root();
	const database = await readFile(join(base, "state.sqlite"));
	const overview = await readFile(join(root, "MEMORY.md"));
	const result = (await app.execute("memory.candidates", {
		text: JSON.stringify({ facts }),
		limit: 20,
		budget: 100,
	})) as {
		candidates: { id: string; reasons: string[]; excerpt: string; profile_ref: string; revision: string }[];
		body_characters: number;
		limitations: string[];
	};
	assert.ok(result.candidates.some((candidate) => candidate.id === match.id && candidate.reasons.includes("lexical")));
	assert.ok(
		result.candidates.some((candidate) => candidate.id === adjacent.id && candidate.reasons.includes("ref_neighbor")),
	);
	assert.ok(result.candidates.every((candidate) => candidate.profile_ref === "user:owner" && candidate.revision));
	assert.ok(result.body_characters <= 100);
	assert.ok(result.limitations.some((line) => line.includes("not semantic")));
	assert.deepEqual(await readFile(join(base, "state.sqlite")), database);
	assert.deepEqual(await readFile(join(root, "MEMORY.md")), overview);
	await writeFile(match.file, "broken");
	await assert.rejects(app.execute("memory.candidates", { text: JSON.stringify({ facts }) }), {
		code: "state_corrupt",
	});
	assert.deepEqual(await readFile(join(base, "state.sqlite")), database);
});

test("explicit decisions preview, apply once, retain provenance and enforce revisions", async (t) => {
	const { base, app } = await setup(t);
	const requestID = "formation-add-001";
	const add = request({
		action: "ADD",
		source_fact_indices: [0],
		text: "小林喜欢绿茶",
		layer: "preference",
		subject: "小林",
		topic: "饮品",
		certainty: "user-stated",
		confidence: 1,
	});
	const before = await readFile(join(new Workspaces(base).root(), "MEMORY.md"));
	const preview = (await app.execute("memory.decide", { text: add })) as { applied: boolean; preview: boolean };
	assert.equal(preview.applied, false);
	assert.equal(preview.preview, true);
	const dry = (await app.execute("memory.decide", {
		text: add,
		apply: true,
		dry_run: true,
		request_id: requestID,
	})) as { applied: boolean };
	assert.equal(dry.applied, false);
	assert.deepEqual(await readFile(join(new Workspaces(base).root(), "MEMORY.md")), before);
	await assert.rejects(app.execute("memory.decide", { text: add, apply: true }), { code: "invalid_argument" });
	const created = (await app.execute("memory.decide", { text: add, apply: true, request_id: requestID })) as {
		result: { id: string; revision: string };
		replayed: boolean;
	};
	assert.equal(created.replayed, false);
	assert.match(created.result.id, /^mem_/);
	const repeated = (await app.execute("memory.decide", {
		text: add,
		apply: true,
		request_id: requestID,
	})) as typeof created;
	assert.equal(repeated.replayed, true);
	assert.equal(repeated.result.id, created.result.id);
	await assert.rejects(
		app.execute("memory.decide", {
			text: request({ action: "ADD", source_fact_indices: [0], text: "别的内容" }),
			apply: true,
			request_id: requestID,
		}),
		{ code: "idempotency_conflict" },
	);
	const update = request({
		action: "UPDATE",
		source_fact_indices: [0],
		id: created.result.id,
		revision: created.result.revision,
		text: "小林喜欢绿茶和乌龙茶",
	});
	const updated = (await app.execute("memory.decide", {
		text: update,
		apply: true,
		request_id: "formation-update-001",
	})) as { result: { id: string; revision: string } };
	assert.equal(updated.result.id, created.result.id);
	const current = (await app.execute("memory.get", { resource: created.result.id })) as Saved;
	assert.equal(current.body, "小林喜欢绿茶和乌龙茶");
	assert.ok(current.sources.includes("user:conversation:tea"));
	assert.ok(((await app.execute("memory.history", { resource: current.id })) as unknown[]).length >= 2);
	await assert.rejects(app.execute("memory.decide", { text: update }), { code: "revision_conflict" });
	const remove = request({ action: "DELETE", source_fact_indices: [0], id: current.id, revision: current.revision });
	const removePreview = (await app.execute("memory.decide", { text: remove })) as { warning: string };
	assert.match(removePreview.warning, /removes/);
	await app.execute("memory.decide", { text: remove, apply: true, request_id: "formation-delete-001" });
	await assert.rejects(app.execute("memory.get", { resource: current.id }), { code: "not_found" });
	const deleteReceipt = (await app.execute("memory.decision-status", { request_id: "formation-delete-001" })) as {
		sources: string[];
		source_fact_indices: number[];
	};
	assert.deepEqual(deleteReceipt.sources, ["user:conversation:tea"]);
	assert.deepEqual(deleteReceipt.source_fact_indices, [0]);
	const replay = (await app.execute("memory.decide", {
		text: remove,
		apply: true,
		request_id: "formation-delete-001",
	})) as { replayed: boolean };
	assert.equal(replay.replayed, true);
	const noop = (await app.execute("memory.decide", { text: request({ action: "NOOP" }), apply: true })) as {
		applied: boolean;
	};
	assert.equal(noop.applied, false);
	const addReceiptPath = join(
		new Workspaces(base).root(),
		"decisions",
		`${createHash("sha256").update(requestID).digest("hex")}.json`,
	);
	const malformed = JSON.parse(await readFile(addReceiptPath, "utf8"));
	malformed.result.revision = [malformed.result.revision];
	await writeFile(addReceiptPath, JSON.stringify(malformed));
	await assert.rejects(app.execute("memory.decision-status", { request_id: requestID }), { code: "state_corrupt" });
});

test("formation validates sources, profile ownership and interrupted receipts", async (t) => {
	const { base, app } = await setup(t);
	const store = new Store(base);
	const event = await store.withLock(() => store.append("video.info", { title: "private" }));
	const eventFact = [{ text: "观察到内容", sources: [`event:other:${event.id}`] }];
	// The account segment in a source must name this installation's account.
	await assert.rejects(app.execute("memory.candidates", { text: JSON.stringify({ facts: eventFact }) }), {
		code: "not_found",
	});
	const ownEventFact = [{ text: "观察到内容", sources: [`event:default:${event.id}`] }];
	const own = (await app.execute("memory.candidates", { text: JSON.stringify({ facts: ownEventFact }) })) as {
		source_checks: { attribution_verified: boolean }[];
	};
	assert.equal(own.source_checks[0].attribution_verified, true);
	await assert.rejects(
		app.execute("memory.decide", {
			text: request({
				action: "UPDATE",
				source_fact_indices: [0],
				id: `mem_${"0".repeat(40)}`,
				revision: "a".repeat(64),
				text: "other",
			}),
		}),
		{ code: "not_found" },
	);
	await assert.rejects(app.execute("memory.decide", { text: request({ action: "ADD", text: "no source" }) }), {
		code: "invalid_argument",
	});
	await assert.rejects(app.execute("memory.candidates", { text: JSON.stringify({ facts, surprise: true }) }), {
		code: "invalid_argument",
	});
	const saved = (await app.execute("memory.add", {
		text: "朋友的茶",
		source: "user:one",
		profile_ref: "user:friend",
	})) as Saved;
	await assert.rejects(
		app.execute("memory.decide", {
			text: request({
				action: "UPDATE",
				source_fact_indices: [0],
				id: saved.id,
				revision: saved.revision,
				text: "misattributed",
			}),
		}),
		{ code: "invalid_argument" },
	);
	const decision = request({ action: "ADD", source_fact_indices: [0], text: "可追踪的记录" });
	const requestID = "formation-uncertain-001";
	await app.execute("memory.decide", { text: decision, apply: true, request_id: requestID });
	const path = join(
		new Workspaces(base).root(),
		"decisions",
		`${createHash("sha256").update(requestID).digest("hex")}.json`,
	);
	const receipt = JSON.parse(await readFile(path, "utf8"));
	receipt.status = "prepared";
	delete receipt.result;
	await writeFile(path, JSON.stringify(receipt));
	await assert.rejects(app.execute("memory.decide", { text: decision, apply: true, request_id: requestID }), {
		code: "decision_uncertain",
	});
	const state = (await app.execute("memory.decision-status", { request_id: requestID })) as {
		status: string;
		id: string;
	};
	assert.equal(state.status, "prepared");
	assert.match(state.id, /^mem_/);
	await assert.rejects(
		app.execute("memory.decide", {
			text: request({ action: "ADD", source_fact_indices: [0], text: "different" }),
			apply: true,
			request_id: requestID,
		}),
		{ code: "idempotency_conflict" },
	);
	receipt.status = ["prepared"];
	await writeFile(path, JSON.stringify(receipt));
	await assert.rejects(app.execute("memory.decision-status", { request_id: requestID }), { code: "state_corrupt" });
	receipt.status = "prepared";
	receipt.id = [receipt.id];
	await writeFile(path, JSON.stringify(receipt));
	await assert.rejects(app.execute("memory.decision-status", { request_id: requestID }), { code: "state_corrupt" });
});

test("decision preview marks a truncated old memory", async (t) => {
	const { app } = await setup(t);
	const saved = (await app.execute("memory.add", { text: "a".repeat(500), source: "user:one" })) as Saved;
	const input = JSON.stringify({
		facts: [{ text: "change", sources: ["user:one"] }],
		decision: { action: "UPDATE", id: saved.id, revision: saved.revision, source_fact_indices: [0], text: "new" },
	});
	const result = (await app.execute("memory.decide", { text: input })) as {
		before: { excerpt: string; truncated: boolean };
	};
	assert.equal(result.before.truncated, true);
	assert.equal(result.before.excerpt.length, 360);
});

test("index failure after file write returns decision_uncertain with a recoverable receipt", async (t) => {
	const { base, app } = await setup(t);
	withDatabase(base, (_db, sqlite) =>
		sqlite.exec(
			"CREATE TRIGGER reject_memory BEFORE INSERT ON memory_nodes BEGIN SELECT RAISE(ABORT, 'test failure'); END",
		),
	);
	const input = request({ action: "ADD", source_fact_indices: [0], text: "written before index failure" });
	const id = "formation-index-failure-001";
	await assert.rejects(app.execute("memory.decide", { text: input, apply: true, request_id: id }), {
		code: "decision_uncertain",
	});
	const receipt = (await app.execute("memory.decision-status", { request_id: id })) as { status: string; id: string };
	assert.equal(receipt.status, "prepared");
	const files = await readdir(join(new Workspaces(base).root(), "memory", "note"));
	assert.ok(files.some((file) => file.includes(receipt.id)));
	withDatabase(base, (_db, sqlite) => sqlite.exec("DROP TRIGGER reject_memory"));
	assert.equal(
		((await app.execute("memory.get", { resource: receipt.id })) as Saved).body,
		"written before index failure",
	);
	await assert.rejects(app.execute("memory.decide", { text: input, apply: true, request_id: id }), {
		code: "decision_uncertain",
	});
});

test("oversized updated metadata is rejected before receipt or memory writes", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(directory, { recursive: true });
	const path = join(directory, "large.md");
	const source = `user:${"x".repeat(129500)}`;
	const original = [
		"---",
		"id: mem_large",
		"layer: note",
		"certainty: inferred",
		"confidence: 0.5",
		"sources:",
		`  - ${source}`,
		"created_at: 2026-10-27T00:00:00Z",
		"updated_at: 2026-10-27T00:00:00Z",
		"---",
		"old fact",
		"",
	].join("\n");
	await writeFile(path, original);
	await app.execute("memory.reindex");
	const old = (await app.execute("memory.get", { resource: "mem_large" })) as Saved;
	const longFacts = [{ text: "new fact", sources: [`user:${"z".repeat(1900)}`] }];
	const decision = JSON.stringify({
		facts: longFacts,
		decision: { action: "UPDATE", id: old.id, revision: old.revision, text: "new fact", source_fact_indices: [0] },
	});
	await assert.rejects(
		app.execute("memory.decide", { text: decision, apply: true, request_id: "oversize-update-01" }),
		{ code: "invalid_argument" },
	);
	assert.equal(await readFile(path, "utf8"), original);
	const current = (await app.execute("memory.get", { resource: old.id })) as Saved;
	assert.equal(current.revision, old.revision);
	await assert.rejects(app.execute("memory.decision-status", { request_id: "oversize-update-01" }), {
		code: "not_found",
	});
});

test("oversized source receipt is rejected before any decision is applied", async (t) => {
	const { app } = await setup(t);
	const inputFacts = Array.from({ length: 6 }, (_, index) => ({
		text: `fact ${index}`,
		sources: Array.from({ length: 4 }, (_, source) => `user:${"长".repeat(1950)}-${index}-${source}`),
	}));
	const input = JSON.stringify({
		facts: inputFacts,
		decision: { action: "ADD", source_fact_indices: [0, 1, 2, 3, 4, 5], text: "a fact" },
	});
	await assert.rejects(app.execute("memory.decide", { text: input, apply: true, request_id: "oversize-receipt-01" }), {
		code: "invalid_argument",
	});
	await assert.rejects(app.execute("memory.decision-status", { request_id: "oversize-receipt-01" }), {
		code: "not_found",
	});
	assert.deepEqual(await app.execute("memory.list"), []);
});

test("large metadata is bounded in candidate output", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(directory, { recursive: true });
	const original = [
		"---",
		"id: mem_metadata",
		"layer: note",
		`title: ${"长".repeat(1000)}`,
		`subject: ${"人".repeat(1000)}`,
		`topic: ${"题".repeat(1000)}`,
		"certainty: inferred",
		"confidence: 0.5",
		"sources:",
		`  - user:${"s".repeat(2000)}`,
		"created_at: 2026-10-27T00:00:00Z",
		"updated_at: 2026-10-27T00:00:00Z",
		"---",
		"interesting fact",
		"",
	].join("\n");
	await writeFile(join(directory, "large.md"), original);
	const result = (await app.execute("memory.candidates", {
		text: JSON.stringify({ facts: [{ text: "fact", sources: ["user:one"] }] }),
		budget: 100,
	})) as {
		candidates: {
			title: string;
			subject: string;
			topic: string;
			metadata_truncated: boolean;
			sources: string[];
			sources_truncated: boolean;
		}[];
	};
	const candidate = result.candidates[0];
	assert.ok(
		Array.from(candidate.title).length <= 200 &&
			Array.from(candidate.subject).length <= 200 &&
			Array.from(candidate.topic).length <= 200,
	);
	assert.equal(candidate.metadata_truncated, true);
	assert.deepEqual(candidate.sources, []);
	assert.equal(candidate.sources_truncated, true);
});

test("cancelling before the decision commit leaves memories unchanged", async (t) => {
	const { base, app } = await setup(t);
	const directory = join(new Workspaces(base).root(), "memory", "note");
	await mkdir(directory, { recursive: true });
	for (let i = 0; i < 80; i++) {
		const content = [
			"---",
			`id: mem_cancel_${i}`,
			"layer: note",
			"certainty: inferred",
			"confidence: 0.5",
			"sources:",
			"  - user:one",
			"created_at: 2026-10-27T00:00:00Z",
			"updated_at: 2026-10-27T00:00:00Z",
			"---",
			"existing fact",
			"",
		].join("\n");
		await writeFile(join(directory, `${i}.md`), content);
	}
	const controller = new AbortController();
	const decision = request({ action: "ADD", source_fact_indices: [0], text: "must not be added" });
	const promise = app.execute(
		"memory.decide",
		{ text: decision, apply: true, request_id: "cancel-before-commit-01" },
		controller.signal,
	);
	setTimeout(() => controller.abort(), 1);
	await assert.rejects(promise, { name: "AbortError" });
	assert.equal((await readdir(directory)).length, 80);
	await assert.rejects(app.execute("memory.decision-status", { request_id: "cancel-before-commit-01" }), {
		code: "not_found",
	});
});

test("decisions retain only selected fact sources and do not acknowledge activity", async (t) => {
	const { base, app } = await setup(t);
	const store = new Store(base);
	const event = await store.withLock(() => store.append("video.info", { title: "sample" }));
	const selectedSource = `event:default:${event.id}`;
	const inputFacts = [
		{ text: "irrelevant fact", sources: ["user:other"] },
		{ text: "observed fact", sources: [selectedSource] },
	];
	const input = JSON.stringify({
		facts: inputFacts,
		decision: { action: "ADD", source_fact_indices: [1], text: "observed fact", certainty: "observed" },
	});
	const result = (await app.execute("memory.decide", {
		text: input,
		apply: true,
		request_id: "event-formation-001",
	})) as { result: { id: string } };
	const memory = (await app.execute("memory.get", { resource: result.result.id })) as Saved;
	assert.deepEqual(memory.sources, [selectedSource]);
	const pending = (await app.execute("growth.review")) as { events: { id: string }[] };
	assert.deepEqual(
		pending.events.map((item) => item.id),
		[event.id],
	);
});

test("receipt sources verify bot and account attribution without asserting delivery", async (t) => {
	const { base, app } = await setup(t);
	const store = new Store(base);
	const receipt = {
		request_id: "share:test:123",
		fingerprint: "fixture",
		operation: "chat.forward",
		status: "dispatching" as const,
		bot_id: "default",
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	};
	await store.saveReceipt(receipt);
	const source = "receipt:default:share:test:123";
	const input = JSON.stringify({ facts: [{ text: "尝试分享，结果未确认", sources: [source, "user:owner"] }] });
	const result = (await app.execute("memory.candidates", { text: input })) as {
		source_checks: { source: string; attribution_verified: boolean; status_at_check?: string }[];
	};
	assert.deepEqual(result.source_checks, [
		{ source, kind: "receipt", attribution_verified: true, status_at_check: "dispatching" },
		{ source: "user:owner", kind: "caller_provided", attribution_verified: false },
	]);
	const decision = JSON.stringify({
		facts: [{ text: "一次分享未确认", sources: [source] }],
		decision: { action: "ADD", source_fact_indices: [0], text: "一次分享未确认" },
	});
	const preview = (await app.execute("memory.decide", { text: decision })) as {
		source_checks: { status_at_check?: string }[];
	};
	assert.equal(preview.source_checks[0].status_at_check, "dispatching");
	const applied = (await app.execute("memory.decide", {
		text: decision,
		apply: true,
		request_id: "receipt-memory-test",
	})) as { source_checks: { status_at_check?: string }[] };
	assert.equal(applied.source_checks[0].status_at_check, "dispatching");
	const replay = (await app.execute("memory.decide", {
		text: decision,
		apply: true,
		request_id: "receipt-memory-test",
	})) as { source_checks: { status_at_check?: string }[] };
	assert.equal(replay.source_checks[0].status_at_check, "dispatching");
	await store.saveReceipt({ ...receipt, status: "confirmed" });
	const replayAfterChange = (await app.execute("memory.decide", {
		text: decision,
		apply: true,
		request_id: "receipt-memory-test",
	})) as { source_checks_scope: string; source_checks: { status_at_check?: string }[] };
	assert.equal(replayAfterChange.source_checks_scope, "decision_snapshot");
	assert.equal(replayAfterChange.source_checks[0].status_at_check, "dispatching");
	const decisionPath = join(
		new Workspaces(base).root(),
		"decisions",
		`${createHash("sha256").update("receipt-memory-test").digest("hex")}.json`,
	);
	const corrupt = JSON.parse(await readFile(decisionPath, "utf8"));
	corrupt.source_checks[0].source = "receipt:default:another-request";
	await writeFile(decisionPath, JSON.stringify(corrupt));
	await assert.rejects(app.execute("memory.decision-status", { request_id: "receipt-memory-test" }), {
		code: "state_corrupt",
	});
	await store.saveReceipt(receipt);
	await assert.rejects(
		app.execute("memory.candidates", {
			text: JSON.stringify({ facts: [{ text: "x", sources: ["receipt:missing:valid-request"] }] }),
		}),
		{ code: "not_found" },
	);
	await assert.rejects(
		app.execute("memory.candidates", {
			text: JSON.stringify({ facts: [{ text: "x", sources: ["receipt:default:bad"] }] }),
		}),
		{ code: "invalid_argument" },
	);
});
