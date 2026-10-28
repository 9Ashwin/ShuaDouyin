import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { Store } from "../src/store.ts";
import { Workspaces } from "../src/workspace.ts";

async function setup(t: test.TestContext, name: string) {
	const base = await mkdtemp(join(tmpdir(), `dy-${name}-`));
	t.after(() => rm(base, { recursive: true, force: true }));
	return base;
}

test("onboarding is explicit, named and idempotent", async (t) => {
	const base = await setup(t, "onboarding");
	const app = new App({ state_dir: base });
	const first = (await app.execute("init", { name: "小鱼", preset: "curious" })) as {
		created: boolean;
		workspace: string;
		onboarding: { status: string; steps: { key: string; ask: string; required: boolean }[] };
	};
	assert.equal(first.created, true);
	assert.equal(first.workspace, base);
	assert.equal(first.onboarding.status, "pending");
	// The questions are a conversation starter, not a form: every one is optional
	// so an unanswered workspace is still a valid one.
	assert.ok(first.onboarding.steps.length >= 3);
	assert.equal(
		first.onboarding.steps.every((step) => step.required === false),
		true,
	);
	const second = (await app.execute("init", { name: "另一个名字" })) as { created: boolean };
	assert.equal(second.created, false);
	assert.match(await readFile(join(base, "AGENTS.md"), "utf8"), /小鱼/);
	assert.equal(((await app.execute("onboarding.skip")) as { status: string }).status, "skipped");
	assert.equal(((await app.execute("onboarding.complete")) as { status: string }).status, "complete");
	assert.equal(((await app.execute("onboarding.show")) as { status: string }).status, "complete");
});

test("init is a dry run until it is not", async (t) => {
	const base = await setup(t, "init-plan");
	const plan = (await new App({ state_dir: base }).execute("init", { name: "小鱼", dry_run: true })) as {
		executed: boolean;
		effect: string;
	};
	assert.equal(plan.executed, false);
	assert.equal(plan.effect, "local");
	await assert.rejects(readFile(join(base, "AGENTS.md"), "utf8"));
});

test("malformed onboarding status cannot bypass or overwrite onboarding", async (t) => {
	const base = await setup(t, "onboarding-invalid");
	const app = new App({ state_dir: base });
	await app.execute("init");
	const path = join(new Workspaces(base).root(), "onboarding.json");
	const invalid = '{"status":["complete"]}\n';
	await writeFile(path, invalid);
	await assert.rejects(app.execute("onboarding.show"), { code: "state_corrupt" });
	await assert.rejects(app.execute("onboarding.complete"), { code: "state_corrupt" });
	assert.equal(await readFile(path, "utf8"), invalid);
});

test("concurrent initialization converges on one workspace", async (t) => {
	const base = await setup(t, "init-concurrent");
	const results = await Promise.all([
		new App({ state_dir: base }).execute("init"),
		new App({ state_dir: base }).execute("init"),
	]);
	assert.equal(results.length, 2);
	assert.equal(
		((await new App({ state_dir: base }).execute("onboarding.show")) as { status: string }).status,
		"pending",
	);
});

test("initialization preserves an edited persona and repairs missing files", async (t) => {
	const base = await setup(t, "existing-workspace");
	await writeFile(join(base, "AGENTS.md"), "my persona");
	await writeFile(join(base, "onboarding.json"), '{"status":"complete"}\n');
	const app = new App({ state_dir: base });
	const result = (await app.execute("init")) as { onboarding: { status: string } };
	assert.equal(result.onboarding.status, "complete");
	assert.equal(await readFile(join(base, "AGENTS.md"), "utf8"), "my persona");
	await app.execute("init");
	assert.match(await readFile(join(base, "PROFILES.md"), "utf8"), /人物档案/);
	assert.equal(await readFile(join(base, "AGENTS.md"), "utf8"), "my persona");
});

test("growth review sees the events this installation recorded", async (t) => {
	const base = await setup(t, "growth-review");
	const app = new App({ state_dir: base });
	await app.execute("init");
	await new Store(base).append("video.info", { title: "观察" });
	const review = (await app.execute("growth.review")) as {
		events: { bot_id: string; source: string; data: { title: string } }[];
		workflow: string[];
	};
	assert.equal(review.events.length, 1);
	assert.equal(review.events[0].bot_id, "default");
	assert.match(review.events[0].source, /^event:default:/);
	assert.equal(review.events[0].data.title, "观察");
	assert.ok(review.workflow.length > 0);
});
