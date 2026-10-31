import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App, personaNotice } from "../src/app.ts";

// Whether the agent is speaking from the persona it was given.
//
// The skill says to read the persona before the first reply of a session, and a
// CLI cannot see a session. It can see the command sequence, so this note rides
// along with every page answer: never read, stale, or edited since the read.

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
	const base = await mkdtemp(join(tmpdir(), "dy-notice-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	return { base, app };
};

test("before anything is read, the note says so", async (t) => {
	const { base } = await setup(t);
	const notice = (await personaNotice(base)) as { status: string; why: string };
	assert.equal(notice.status, "never_read");
	assert.match(notice.why, /generic assistant/);
});

test("reading the persona clears it", async (t) => {
	const { base, app } = await setup(t);
	await app.execute("persona.show", {});
	assert.equal(await personaNotice(base), null);
});

test("an edit after the read brings it back", async (t) => {
	// The agent is holding the version it read. A persona changed since then is
	// not what it would be speaking from, even if the read was a minute ago.
	const { base, app } = await setup(t);
	await app.execute("persona.show", {});
	const current = (await app.execute("workspace.get", { resource: "AGENTS.md" })) as { revision: string };
	await app.execute("workspace.set", {
		resource: "AGENTS.md",
		text: "# 新名字\n\n## 身份与声音\n\n改了。\n\n## 行为准则\n\n- 一条。\n",
		if_match: current.revision,
	});
	const notice = (await personaNotice(base)) as { status: string };
	assert.equal(notice.status, "changed_since_read");
});

test("the note rides along on a page command rather than needing its own", async (t) => {
	// A caller that never runs persona show still sees it, because one place
	// attaches it — the same way the setup question is attached.
	const { base } = await setup(t);
	const notice = (await personaNotice(base)) as { read: string };
	assert.match(notice.read, /dy persona show/);
});
