import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import {
	browsingContext,
	noteSkipped,
	noteWatched,
	roundCandidates,
	roundSummary,
	rounds,
	startRound,
} from "../src/operations/browsing.ts";
import { Store } from "../src/store.ts";

async function setup(t: test.TestContext, name: string) {
	const base = await mkdtemp(join(tmpdir(), `dy-browse-${name}-`));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	return base;
}

test("a round left open is resumed rather than duplicated", async (t) => {
	const base = await setup(t, "resume");
	const store = new Store(base);
	const first = (await startRound(store, { works: 5 })) as { id: string; resumed?: boolean };
	assert.equal(first.resumed, undefined);
	const second = (await startRound(store, { works: 99 })) as { id: string; resumed?: boolean };
	// Two open rounds would each claim a budget and neither would be true.
	assert.equal(second.id, first.id);
	assert.equal(second.resumed, true);
	const all = rounds(await store.events());
	assert.equal(all.length, 1);
	assert.equal(all[0].budget.works, 5);
});

test("a round counts what it watched and why it skipped, from events", async (t) => {
	const base = await setup(t, "summary");
	const store = new Store(base);
	const round = (await startRound(store, { works: 2 })) as { id: string };
	await noteWatched(store, round.id, "7000000000000000001");
	await noteSkipped(store, round.id, "7000000000000000002", "seen");
	await noteSkipped(store, round.id, "7000000000000000003", "live");
	const summary = roundSummary(await store.events(), round.id);
	assert.equal(summary?.watched, 1);
	assert.equal(summary?.skipped, 2);
	assert.deepEqual(summary?.skip_reasons, { seen: 1, live: 1 });
	// The budget is advisory: spending it is reported, not enforced.
	assert.equal(summary?.over_budget, true);
	assert.ok(summary?.suggest);
	assert.equal(summary?.status, "open");
});

test("a work recorded twice still counts once", async (t) => {
	const base = await setup(t, "dedupe");
	const store = new Store(base);
	const round = (await startRound(store, {})) as { id: string };
	await noteWatched(store, round.id, "7000000000000000001");
	await noteWatched(store, round.id, "7000000000000000001");
	const summary = roundSummary(await store.events(), round.id);
	assert.equal(summary?.watched, 1);
});

test("a skip without a known reason is refused", async (t) => {
	const base = await setup(t, "badreason");
	const store = new Store(base);
	const round = (await startRound(store, {})) as { id: string };
	await assert.rejects(noteSkipped(store, round.id, "7000000000000000001", "因为累了"), {
		code: "invalid_argument",
	});
});

test("the browsing context says which works were already acted on", async (t) => {
	const base = await setup(t, "context");
	const store = new Store(base);
	await store.append("video.info", { video: { id: "7000000000000000001" } });
	await store.append("video.like", { video_id: "7000000000000000001", enabled: true });
	// Seen twice through reads; the second observation must not add a row.
	await store.append("video.info", { video: { id: "7000000000000000001" } });
	await store.append("video.info", { video: { id: "7000000000000000002" } });
	const context = browsingContext(await store.events(), { limit: 10 });
	assert.equal(context.works.length, 2);
	const first = context.works.find((work) => work.video_id === "7000000000000000001");
	assert.equal(first?.already_acted, true);
	assert.deepEqual(first?.interactions, ["video.like"]);
	const second = context.works.find((work) => work.video_id === "7000000000000000002");
	assert.equal(second?.already_acted, false);
});

test("a skipped work stays marked as skipped in the context", async (t) => {
	const base = await setup(t, "skipped");
	const store = new Store(base);
	const round = (await startRound(store, {})) as { id: string };
	await noteWatched(store, round.id, "7000000000000000001");
	await noteSkipped(store, round.id, "7000000000000000002", "live");
	const context = browsingContext(await store.events(), { limit: 10 });
	const skipped = context.works.find((work) => work.video_id === "7000000000000000002");
	assert.equal(skipped?.skipped, "live");
	assert.equal(context.open_round?.id, round.id);
});

test("a closed round offers what it saw as candidates, without writing anything", async (t) => {
	const base = await setup(t, "candidates");
	const store = new Store(base);
	const round = (await startRound(store, { works: 5 })) as { id: string };
	await store.append("video.info", {
		video: { id: "7000000000000000001", title: "标题一", author: "作者一" },
	});
	await noteWatched(store, round.id, "7000000000000000001");
	await store.append("video.like", { video_id: "7000000000000000001", enabled: true });
	await noteSkipped(store, round.id, "7000000000000000002", "seen");
	const candidates = roundCandidates(await store.events(), round.id);
	assert.equal(candidates?.candidates.length, 2);
	const kept = candidates?.candidates.find((item) => item.video_id === "7000000000000000001");
	assert.equal(kept?.title, "标题一");
	assert.deepEqual(kept?.interactions, ["video.like"]);
	assert.match(kept?.memory_hint ?? "", /Acted on/);
	const skipped = candidates?.candidates.find((item) => item.video_id === "7000000000000000002");
	assert.equal(skipped?.skipped, "seen");
	assert.match(skipped?.memory_hint ?? "", /not as "liked"/);
	// Nothing was written: the round offers material, the caller decides.
	assert.equal((await store.events()).filter((event) => event.operation.startsWith("memory.")).length, 0);
});

test("the round's own id is not a work, and neither is a route alias", async (t) => {
	const base = await setup(t, "ids");
	const store = new Store(base);
	const round = (await startRound(store, {})) as { id: string };
	// A profile read reports its own subject as the literal alias "self", which is
	// a route name and cannot be a work.
	await store.append("video.info", { video: { id: "self", title: "主页" } });
	await store.append("user.get", { id: "self", name: "主页" });
	const candidates = roundCandidates(await store.events(), round.id);
	assert.equal(candidates?.candidates.length, 0);
});

test("growth review groups events by round without changing the event order", async (t) => {
	const base = await setup(t, "growth-rounds");
	const round = (await startRound(new Store(base), { works: 2 })) as { id: string };
	const app = new App({ state_dir: base });
	await noteWatched(new Store(base), round.id, "7000000000000000001");
	await new Store(base).append("video.like", { video_id: "7000000000000000001", enabled: true });
	await app.execute("browse.end", { resource: round.id, reason: "done" });
	const review = (await app.execute("growth.review", { since: "2000-01-01T00:00:00Z", limit: 200 })) as {
		events: { id: string; source: string }[];
		rounds: {
			round_id: string;
			status: string;
			watched: number;
			interacted: number;
			events: { id: string; source: string }[];
		}[];
	};
	const grouped = review.rounds.find((entry) => entry.round_id === round.id);
	assert.ok(grouped);
	assert.equal(grouped.status, "closed");
	assert.equal(grouped.watched, 1);
	assert.equal(grouped.interacted, 1);
	// Grouping is a view: the flat list is still there, still ordered, and every
	// event still carries its own source for the checkpoint.
	assert.ok(review.events.length > 0);
	const sources = new Set(review.events.map((event) => event.source));
	for (const event of grouped.events) assert.ok(sources.has(event.source));
	assert.equal(review.events[0].source.startsWith("event:"), true);
});
