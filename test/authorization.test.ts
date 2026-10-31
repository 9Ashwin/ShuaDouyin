import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import {
	covers,
	grantAccess,
	grants,
	parseActions,
	parseTarget,
	revokeAccess,
} from "../src/operations/authorization.ts";
import { Store } from "../src/store.ts";

// Standing permission for one person.
//
// The skill says permission is per round and must not be written into a config
// file. That rule exists because "replies are fine" turns a revocable decision
// into a permanent one. A grant is the other shape: one target, named actions,
// an expiry, and a revocation that keeps the record. It still never decides
// whether a message is worth sending.

const setup = async (t: { after: (fn: () => Promise<void>) => void }) => {
	const base = await mkdtemp(join(tmpdir(), "dy-auth-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	return new Store(base);
};

test("a grant names one target and one set of actions", async (t) => {
	const store = await setup(t);
	const grant = (await grantAccess(store, {
		target: "user:MS4wLjABAAAAperson",
		actions: "reply",
		days: 7,
		reason: "他先私信的我",
	})) as { id: string; active: boolean };
	assert.equal(grant.active, true);
	const listed = grants(await store.events());
	assert.equal(listed.length, 1);
	assert.deepEqual(listed[0]?.actions, ["reply"]);
});

test("a grant covers its target and not a different one", async (t) => {
	// This is the whole reason a grant is not a switch: the person is part of it.
	const store = await setup(t);
	await grantAccess(store, { target: "user:MS4wLjABAAAAperson", actions: "reply", reason: "x" });
	const events = await store.events();
	assert.ok(covers(events, "user:MS4wLjABAAAAperson", "reply"));
	assert.equal(covers(events, "user:MS4wLjABAAAAsomeone_else", "reply"), null);
});

test("a grant for one action does not carry the others", async (t) => {
	const store = await setup(t);
	await grantAccess(store, { target: "user:MS4wLjABAAAAperson", actions: "reply", reason: "x" });
	const events = await store.events();
	assert.equal(covers(events, "user:MS4wLjABAAAAperson", "follow"), null);
});

test("a conversation grant and a user grant are different audiences", async (t) => {
	// A group is not its members. Treating a group grant as covering the people
	// in it would send to someone who was never named.
	const store = await setup(t);
	await grantAccess(store, { target: "conversation:native:123", actions: "reply", reason: "群里聊过" });
	const events = await store.events();
	assert.ok(covers(events, "conversation:native:123", "reply"));
	assert.equal(covers(events, "user:MS4wLjABAAAAmember", "reply"), null);
});

test("an expired grant stops covering without being revoked", async (t) => {
	const store = await setup(t);
	await grantAccess(store, { target: "user:MS4wLjABAAAAperson", actions: "reply", days: 1, reason: "x" });
	const events = await store.events();
	// One day later, to the second.
	assert.equal(covers(events, "user:MS4wLjABAAAAperson", "reply", Date.now() + 86_400_001), null);
});

test("a revocation keeps the record and stops coverage", async (t) => {
	const store = await setup(t);
	const grant = (await grantAccess(store, {
		target: "user:MS4wLjABAAAAperson",
		actions: "reply",
		reason: "x",
	})) as { id: string };
	await revokeAccess(store, grant.id);
	const events = await store.events();
	assert.equal(covers(events, "user:MS4wLjABAAAAperson", "reply"), null);
	// The grant is still there: what it covered already happened, and a later
	// reader needs to know it existed.
	const listed = grants(events);
	assert.equal(listed.length, 1);
	assert.equal(listed[0]?.active, false);
});

test("a grant with no reason is refused", async (t) => {
	// Without a stated reason the next reader sees an approval and nothing to
	// weigh it against, so it cannot be reviewed.
	const store = await setup(t);
	await assert.rejects(grantAccess(store, { target: "user:MS4wLjABAAAAperson", actions: "reply" }), {
		code: "invalid_argument",
	});
});

test("a display name is not a target", () => {
	// A name can be changed or shared; the grant would then cover whoever holds it.
	assert.throws(() => parseTarget("林瑜"), { code: "invalid_argument" });
	assert.equal(parseTarget("user:MS4wLjABAAAAperson"), "user:MS4wLjABAAAAperson");
});

test("an unknown action is refused rather than dropped", () => {
	assert.throws(() => parseActions("reply,message"), { code: "invalid_argument" });
	assert.deepEqual(parseActions("reply, comment"), ["reply", "comment"]);
});

test("granting the same thing twice reports the existing one", async (t) => {
	const store = await setup(t);
	const first = (await grantAccess(store, {
		target: "user:MS4wLjABAAAAperson",
		actions: "reply",
		reason: "x",
	})) as { id: string };
	const second = (await grantAccess(store, {
		target: "user:MS4wLjABAAAAperson",
		actions: "reply",
		reason: "x",
	})) as { id: string; duplicate?: boolean };
	assert.equal(second.id, first.id);
	assert.equal(second.duplicate, true);
});

test("the command path reaches the workspace, not the browser", async (t) => {
	// auth.* used to fall through to the page dispatcher and answer "Unknown
	// operation", which is the same failure the persona group had.
	const base = await mkdtemp(join(tmpdir(), "dy-auth-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	const granted = (await app.execute("auth.grant", {
		target: "user:MS4wLjABAAAAperson",
		actions: "reply",
		days: 3,
		reason: "他先私信的我",
	})) as { id: string };
	const listed = (await app.execute("auth.grants", {})) as { grants: { active: boolean }[] };
	assert.equal(listed.grants.length, 1);
	await app.execute("auth.revoke", { resource: granted.id });
	const after = (await app.execute("auth.grants", {})) as { grants: { active: boolean }[] };
	assert.equal(after.grants[0]?.active, false);
});
