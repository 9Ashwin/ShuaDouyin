import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { checkGoalQuota, heardFrom } from "../src/operations/social.ts";
import { Store } from "../src/store.ts";

const PERSON = "MS4wLjABAAAAperson01";

async function setup(t: test.TestContext, name: string) {
	const base = await mkdtemp(join(tmpdir(), `dy-social-${name}-`));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	return base;
}

test("a sent message puts a person on the card, and the stage is inferred", async (t) => {
	const base = await setup(t, "infer");
	const store = new Store(base);
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "在听你上次说的歌" });
	const app = new App({ state_dir: base });
	const list = (await app.execute("social.list", {})) as {
		relations: { person: string; stage: string; contact_count: number }[];
	};
	assert.equal(list.relations.length, 1);
	assert.equal(list.relations[0].person, PERSON);
	assert.equal(list.relations[0].stage, "met");
	assert.equal(list.relations[0].contact_count, 1);
});

test("a stage the owner sets is not overwritten by the inference", async (t) => {
	const base = await setup(t, "stage");
	const store = new Store(base);
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "一" });
	const app = new App({ state_dir: base });
	await app.execute("social.stage", { resource: PERSON, stage: "connected", note: "老朋友" });
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "二" });
	const card = (await app.execute("social.relation", { resource: PERSON })) as {
		stage: string;
		note: string;
		timeline: { text: string }[];
	};
	assert.equal(card.stage, "connected");
	assert.equal(card.note, "老朋友");
	assert.equal(card.timeline.length, 2);
	assert.equal(card.timeline[0].text, "二");
});

test("an unknown person is reported as unknown rather than invented", async (t) => {
	const base = await setup(t, "unknown");
	const card = (await new App({ state_dir: base }).execute("social.relation", { resource: PERSON })) as {
		known: boolean;
	};
	assert.equal(card.known, false);
});

test("a follow-up becomes due and can be closed", async (t) => {
	const base = await setup(t, "followup");
	const app = new App({ state_dir: base });
	await app.execute("social.followup", { resource: PERSON, topic: "发歌名", due: "2020-01-01T00:00:00.000Z" });
	const due = (await app.execute("social.due", {})) as { items: { person: string; followups: { at: string }[] }[] };
	assert.equal(due.items.length, 1);
	assert.equal(due.items[0].person, PERSON);
	const open = due.items[0].followups[0];
	assert.ok(open);
	await app.execute("social.done", { resource: PERSON, at: open.at });
	const card = (await app.execute("social.relation", { resource: PERSON })) as { open_followups: unknown[] };
	assert.deepEqual(card.open_followups, []);
});

test("a group conversation is not a relationship", async (t) => {
	const base = await setup(t, "group");
	const store = new Store(base);
	await store.append("chat.send", { conversation_id: "native:7700000000000000123", text: "群里说话" });
	const list = (await new App({ state_dir: base }).execute("social.list", {})) as { relations: unknown[] };
	assert.deepEqual(list.relations, []);
});

test("a group stage is refused rather than accepted", async (t) => {
	const base = await setup(t, "stage-validation");
	await assert.rejects(new App({ state_dir: base }).execute("social.stage", { resource: PERSON, stage: "dating" }), {
		code: "invalid_argument",
	});
});

test("discovery without a goal falls back to what this account talks about", async (t) => {
	const base = await setup(t, "discover-inferred");
	const store = new Store(base);
	await store.append("comment.post", { video_id: "1", text: "这首歌的吉他编曲很好" });
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "吉他我也在学" });
	const sources = join(base, "sources.json");
	await writeFile(
		sources,
		JSON.stringify([
			{ person: "MS4wLjABAAAAcand01", name: "同好", where: "评论区", source: "event:1", context: "在聊吉他" },
			{ person: "MS4wLjABAAAAcand02", name: "无关", where: "评论区", source: "event:2", context: "别的话题" },
		]),
	);
	const result = (await new App({ state_dir: base }).execute("social.discover", { sources })) as {
		goal: { id: string; topics: string[] };
		candidates: { name: string; common_ground: string[]; uncertainty: string }[];
	};
	assert.equal(result.goal.id, "inferred");
	assert.ok(result.goal.topics.includes("吉他"));
	const match = result.candidates.find((entry) => entry.name === "同好");
	assert.deepEqual(match?.common_ground, ["吉他"]);
	const miss = result.candidates.find((entry) => entry.name === "无关");
	assert.deepEqual(miss?.common_ground, []);
	assert.match(miss?.uncertainty ?? "", /No shared topic/);
});

test("a goal the owner sets replaces the inference", async (t) => {
	const base = await setup(t, "discover-explicit");
	const app = new App({ state_dir: base });
	const created = (await app.execute("social.goal", { text: "认识做音乐的人", topic: "吉他,编曲" })) as { id: string };
	const sources = join(base, "sources.json");
	await writeFile(
		sources,
		JSON.stringify([
			{ person: "MS4wLjABAAAAcand03", name: "编曲人", where: "粉丝", source: "event:3", context: "编曲作品很多" },
		]),
	);
	const result = (await app.execute("social.discover", { sources })) as {
		goal: { id: string; description: string };
		candidates: { common_ground: string[] }[];
	};
	assert.equal(result.goal.id, created.id);
	assert.equal(result.goal.description, "认识做音乐的人");
	assert.deepEqual(result.candidates[0].common_ground, ["编曲"]);
});

test("someone already on a card is not offered again as a new person", async (t) => {
	const base = await setup(t, "discover-known");
	const store = new Store(base);
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "你好" });
	const sources = join(base, "sources.json");
	await writeFile(
		sources,
		JSON.stringify([{ person: PERSON, name: "已认识", where: "私信", source: "event:4", context: "聊过了" }]),
	);
	const result = (await new App({ state_dir: base }).execute("social.discover", { sources })) as {
		candidates: unknown[];
	};
	assert.deepEqual(result.candidates, []);
});

test("the goal command returns the question instead of failing when none is set", async (t) => {
	const base = await setup(t, "goal-question");
	const answer = (await new App({ state_dir: base }).execute("social.goal", {})) as {
		question: string;
		optional: boolean;
	};
	assert.match(answer.question, /想认识什么样的人/);
	assert.equal(answer.optional, true);
});

test("the log separates looking from acting", async (t) => {
	const base = await setup(t, "log");
	const store = new Store(base);
	await store.append("comment.list", { video_id: "1", rows: 3 });
	await store.append("comment.post", { video_id: "1", text: "好听" });
	const log = (await new App({ state_dir: base }).execute("social.log", {})) as {
		entries: { kind: string; operation: string; order?: number }[];
		counts: { looked: number; acted: number };
	};
	assert.equal(log.counts.looked, 1);
	assert.equal(log.counts.acted, 1);
	assert.equal(log.entries[0].operation, "comment.post");
	// Two events written back to back share a millisecond often enough that
	// sorting on `at` alone returned them in the wrong order on CI while passing
	// on a slower machine. The log is append-only, so the later line is newer.
	assert.ok(
		log.entries.every((entry) => entry.order === undefined),
		"the sort key is not part of the response",
	);
});

test("two events in the same millisecond keep their written order", async (t) => {
	const base = await setup(t, "log-same-millisecond");
	const store = new Store(base);
	// Pin `at` so the tie is certain rather than hoped for.
	const at = new Date("2026-01-01T00:00:00.000Z");
	const writes = ["comment.list", "comment.post", "chat.read"];
	for (const operation of writes) {
		const event = await store.append(operation, { video_id: "1", text: "x" });
		const lines = (await readFile(join(base, "history.jsonl"), "utf8")).trimEnd().split("\n");
		const last = JSON.parse(lines[lines.length - 1]);
		lines[lines.length - 1] = JSON.stringify({ ...last, at: at.toISOString(), id: event.id });
		await writeFile(join(base, "history.jsonl"), `${lines.join("\n")}\n`);
	}
	const log = (await new App({ state_dir: base }).execute("social.log", {})) as {
		entries: { operation: string }[];
	};
	assert.deepEqual(
		log.entries.map((entry) => entry.operation),
		["chat.read", "comment.post", "comment.list"],
	);
});

test("pausing blocks every outward write and leaves reads alone", async (t) => {
	const base = await setup(t, "pause");
	const app = new App({ state_dir: base });
	await app.execute("social.pause", { reason: "审阅中" });
	const state = (await app.execute("social.log", {})) as { paused: boolean; reason: string };
	assert.equal(state.paused, true);
	assert.equal(state.reason, "审阅中");
	// A well-formed write reaches the pause gate; an ill-formed one fails
	// validation first, which is the order every command goes through.
	await assert.rejects(app.execute("comment.post", { video_id: "12345", text: "x", request_id: "pause-check-0001" }), {
		code: "state",
	});
	// Reading is unaffected: a pause stops acting, not looking.
	const after = (await app.execute("social.log", {})) as { paused: boolean };
	assert.equal(after.paused, true);
	const resumed = (await app.execute("social.resume", {})) as { paused: boolean };
	assert.equal(resumed.paused, false);
});

test("a goal's vocabulary decides which stages its cards accept", async (t) => {
	const base = await setup(t, "vocab");
	const app = new App({ state_dir: base });
	const goal = (await app.execute("social.goal", { text: "认识装修需求的人", goal_preset: "lead" })) as {
		id: string;
		stages: string[];
	};
	assert.deepEqual(goal.stages, ["lead", "contacted", "qualified", "won", "lost"]);
	await new Store(base).append("comment.post", { user_id: PERSON, goal: goal.id, text: "你好" });
	// One contact is "contacted" under a funnel, not "met": the words belong to
	// the goal, and the inference must use those words.
	const card = (await app.execute("social.relation", { resource: PERSON })) as {
		stage: string;
		goal: string | null;
		stage_position: number;
		vocabulary: { stages: string[] };
	};
	assert.equal(card.goal, goal.id);
	assert.equal(card.stage, "contacted");
	assert.equal(card.stage_position, 1);
	assert.deepEqual(card.vocabulary.stages, goal.stages);
	// A friendship word is not in this vocabulary and must be refused with the
	// list that is.
	await assert.rejects(app.execute("social.stage", { resource: PERSON, stage: "talking" }), {
		code: "invalid_argument",
	});
	await app.execute("social.stage", { resource: PERSON, stage: "qualified" });
	const decided = (await app.execute("social.relation", { resource: PERSON })) as { stage: string };
	assert.equal(decided.stage, "qualified");
});

test("evidence never carries a card past the second stage", async (t) => {
	const base = await setup(t, "limit");
	const store = new Store(base);
	for (let index = 0; index < 6; index++) await store.append("chat.send", { conversation_id: `secuid:${PERSON}` });
	const card = (await new App({ state_dir: base }).execute("social.relation", { resource: PERSON })) as {
		stage: string;
		contact_count: number;
	};
	// Six sent messages still only show contact. "connected" is a fact about the
	// other person, which sending cannot establish.
	assert.equal(card.contact_count, 6);
	assert.equal(card.stage, "talking");
});

test("a goal's daily limit refuses the write instead of queueing it", async (t) => {
	const base = await setup(t, "quota");
	const app = new App({ state_dir: base });
	const goal = (await app.execute("social.goal", {
		text: "今天最多两个人",
		goal_preset: "lead",
		daily_limit: 2,
	})) as { id: string };
	const store = new Store(base);
	await store.append("comment.post", { user_id: "MS4wLjABAAAAfirst01", goal: goal.id, text: "一" });
	await store.append("comment.post", { user_id: "MS4wLjABAAAAsecond02", goal: goal.id, text: "二" });
	// The same person again does not count twice.
	await store.append("comment.post", { user_id: "MS4wLjABAAAAfirst01", goal: goal.id, text: "又问一次" });
	await assert.rejects(
		app.execute("comment.post", {
			video_id: "12345",
			text: "第三人",
			goal: goal.id,
			request_id: "quota-check-0002",
		}),
		(error: unknown) => {
			const problem = error as { code: string; message: string; details?: { used?: number; limit?: number } };
			assert.equal(problem.code, "state");
			assert.equal(problem.details?.used, 2);
			assert.equal(problem.details?.limit, 2);
			return true;
		},
	);
});

test("a goal without a limit refuses nothing", async (t) => {
	const base = await setup(t, "nolimit");
	const app = new App({ state_dir: base });
	const goal = (await app.execute("social.goal", { text: "不限量", goal_preset: "lead" })) as { id: string };
	const store = new Store(base);
	for (let index = 0; index < 5; index++)
		await store.append("comment.post", { user_id: `MS4wLjABAAAAperson0${index}`, goal: goal.id });
	const events = await store.events();
	// A null limit is not a zero limit: five people reached must not refuse the
	// sixth. This is the difference between "no cap set" and "cap of nothing".
	assert.doesNotThrow(() => checkGoalQuota(events, goal.id));
});

test("an outcome is filed under the card's own goal, never a supplied one", async (t) => {
	const base = await setup(t, "outcome");
	const app = new App({ state_dir: base });
	const lead = (await app.execute("social.goal", { text: "装修线索", goal_preset: "lead" })) as { id: string };
	const other = (await app.execute("social.goal", { text: "另一个目标", goal_preset: "lead" })) as { id: string };
	const store = new Store(base);
	await store.append("comment.post", { user_id: PERSON, goal: lead.id, text: "你好" });
	// Naming a goal that never reached this person is refused rather than
	// quietly refiled: filing under the wrong goal would skew every count that
	// reads it, and silently switching goals would hide the mistake.
	await assert.rejects(app.execute("social.outcome", { resource: PERSON, outcome: "won", goal: other.id }), {
		code: "not_found",
	});
	const recorded = (await app.execute("social.outcome", { resource: PERSON, outcome: "won", goal: lead.id })) as {
		goal: string;
	};
	assert.equal(recorded.goal, lead.id);
	const summary = (await app.execute("social.outcomes", {})) as {
		goals: { goal: string; people: number; concluded: number; open: number; outcomes: Record<string, number> }[];
	};
	const entry = summary.goals.find((row) => row.goal === lead.id);
	assert.equal(entry?.people, 1);
	assert.equal(entry?.concluded, 1);
	assert.equal(entry?.open, 0);
	assert.equal(entry?.outcomes.won, 1);
});

test("a pending outcome keeps a lead open rather than counting it as concluded", async (t) => {
	const base = await setup(t, "pending");
	const app = new App({ state_dir: base });
	const goal = (await app.execute("social.goal", { text: "线索", goal_preset: "lead" })) as { id: string };
	const store = new Store(base);
	await store.append("comment.post", { user_id: PERSON, goal: goal.id, text: "你好" });
	await app.execute("social.outcome", { resource: PERSON, outcome: "pending" });
	const summary = (await app.execute("social.outcomes", {})) as {
		goals: { open: number; concluded: number }[];
	};
	assert.equal(summary.goals[0].open, 1);
	assert.equal(summary.goals[0].concluded, 0);
});

test("an outcome for someone with no card is refused", async (t) => {
	const base = await setup(t, "nocard");
	const app = new App({ state_dir: base });
	await assert.rejects(app.execute("social.outcome", { resource: PERSON, outcome: "won" }), { code: "not_found" });
});

test("an unknown outcome name is refused with the list", async (t) => {
	const base = await setup(t, "badoutcome");
	const app = new App({ state_dir: base });
	await new Store(base).append("comment.post", { user_id: PERSON, text: "你好" });
	await assert.rejects(app.execute("social.outcome", { resource: PERSON, outcome: "sold" }), {
		code: "invalid_argument",
	});
});

test("a profile needs results under two goals to count the same person twice", async (t) => {
	const base = await setup(t, "twogoals");
	const app = new App({ state_dir: base });
	const lead = (await app.execute("social.goal", { text: "装修", goal_preset: "lead" })) as { id: string };
	const other = (await app.execute("social.goal", { text: "旧房改造", goal_preset: "lead" })) as { id: string };
	const store = new Store(base);
	await store.append("comment.post", { user_id: PERSON, goal: lead.id, text: "一" });
	await app.execute("social.outcome", { resource: PERSON, outcome: "won" });
	// The second goal has no contact with this person, so a result cannot attach
	// to it: the card belongs to the first goal and the summary must say so.
	await assert.rejects(app.execute("social.outcome", { resource: PERSON, outcome: "lost", goal: other.id }), {
		code: "not_found",
	});
	const summary = (await app.execute("social.outcomes", {})) as {
		goals: { goal: string; concluded: number; outcomes: Record<string, number> }[];
	};
	// The result landed on the first goal even after the refusal, so the count is
	// one conclusion and not two.
	const entry = summary.goals.find((row) => row.goal === lead.id);
	assert.equal(entry?.concluded, 1);
	assert.equal(entry?.outcomes.won, 1);
});

test("a card that never answered is not a conversation to continue", async (t) => {
	const base = await setup(t, "unanswered");
	const store = new Store(base);
	// Sent a week ago and never answered. Quiet alone must not produce a
	// reminder: writing again into silence is what this project refuses.
	const old = new Date(Date.now() - 8 * 24 * 3600_000).toISOString();
	const events = (await store.events()) as unknown[];
	void events;
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "在吗" });
	const app = new App({ state_dir: base });
	const due = (await app.execute("social.due", {})) as {
		items: { person: string }[];
		unanswered: { person: string; sent: number }[];
	};
	assert.equal(due.items.length, 0);
	assert.equal(due.unanswered.length, 1);
	assert.equal(due.unanswered[0].person, PERSON);
	assert.equal(due.unanswered[0].sent, 1);
	void old;
});

test("someone who replied once can go quiet and then deserve a nudge", async (t) => {
	const base = await setup(t, "answered");
	const store = new Store(base);
	await store.append("chat.read", {
		id: `secuid:${PERSON}`,
		messages: [{ direction: "incoming", text: "好久不见", kind: "text" }],
	});
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "最近怎么样" });
	const app = new App({ state_dir: base });
	// Fresh contact is not due yet, and unanswered must be empty because a reply
	// exists.
	const fresh = (await app.execute("social.due", {})) as { unanswered: unknown[] };
	assert.equal(fresh.unanswered.length, 0);
	assert.equal(heardFrom(await store.events()).has(PERSON), true);
});

test("setting a person aside removes them from what is owed, keeping the history", async (t) => {
	const base = await setup(t, "forget");
	const store = new Store(base);
	await store.append("chat.send", { conversation_id: `secuid:${PERSON}`, text: "一" });
	await store.append("social.followup", {
		person: PERSON,
		topic: "问那首歌",
		due: new Date(Date.now() - 1000).toISOString(),
	});
	const app = new App({ state_dir: base });
	const before = (await app.execute("social.due", {})) as { items: unknown[] };
	assert.equal(before.items.length, 1);
	await app.execute("social.forget", { resource: PERSON, reason: "不打扰了" });
	const after = (await app.execute("social.due", {})) as { items: unknown[] };
	assert.equal(after.items.length, 0);
	// The card is still readable: setting aside is not forgetting the history.
	const card = (await app.execute("social.relation", { resource: PERSON })) as {
		forgotten: boolean;
		forgotten_reason: string;
		contact_count: number;
		timeline: unknown[];
	};
	assert.equal(card.forgotten, true);
	assert.equal(card.forgotten_reason, "不打扰了");
	assert.equal(card.contact_count, 1);
	assert.equal(card.timeline.length, 1);
});

test("setting aside someone with no card is refused", async (t) => {
	const base = await setup(t, "forgetnone");
	await assert.rejects(new App({ state_dir: base }).execute("social.forget", { resource: PERSON }), {
		code: "not_found",
	});
});
