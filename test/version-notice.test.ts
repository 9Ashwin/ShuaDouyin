import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { updateNotice } from "../src/version-notice.ts";

// A quiet check for a newer release.
//
// The rules here are about cost and about who acts. `dy` runs many times per
// session, so a request per command would be hundreds a day against a public
// registry; and the notice is for the owner, so it must not read as an
// instruction an agent should carry out mid-task.

const base = async (t: { after: (fn: () => Promise<void>) => void }) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-version-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	return directory;
};

test("a recent check is not repeated", async (t) => {
	const directory = await base(t);
	// A stamp from a minute ago saying nothing is newer: the check must not run, and
	// the way to tell is that no request is made — this test passes offline because
	// of that.
	await writeFile(
		join(directory, "version-check.json"),
		JSON.stringify({ checked_at: new Date(Date.now() - 60_000).toISOString(), latest: "0.0.1" }),
		"utf8",
	);
	const notice = await updateNotice(directory, { now: Date.now(), timeoutMs: 1 });
	assert.equal(notice, null);
});

test("a stamp older than a day checks again", async (t) => {
	const directory = await base(t);
	await writeFile(
		join(directory, "version-check.json"),
		JSON.stringify({ checked_at: new Date(Date.now() - 2 * 24 * 60 * 60_000).toISOString(), latest: "0.0.1" }),
		"utf8",
	);
	// The check runs and fails to reach the registry; what matters is that it tried,
	// which shows as a rewritten stamp.
	await updateNotice(directory, { now: Date.now(), timeoutMs: 1 });
	const stamp = JSON.parse(await readFile(join(directory, "version-check.json"), "utf8")) as { checked_at: string };
	assert.ok(Date.now() - Date.parse(stamp.checked_at) < 60_000, "the stamp records this attempt");
});

test("a failed check is recorded, so it is not retried on every command", async (t) => {
	const directory = await base(t);
	// No route to the registry in a test environment: the call fails, and the point
	// is that the failure is written down rather than retried next time.
	const before = Date.now();
	await updateNotice(directory, { now: before, timeoutMs: 1 });
	const stamp = JSON.parse(await readFile(join(directory, "version-check.json"), "utf8")) as {
		checked_at: string;
		latest: string | null;
	};
	assert.equal(stamp.latest, null);
	assert.equal(Date.parse(stamp.checked_at), before);
});

test("a corrupt stamp costs one request, not a broken command", async (t) => {
	const directory = await base(t);
	await writeFile(join(directory, "version-check.json"), "{ not json", "utf8");
	const notice = await updateNotice(directory, { now: Date.now(), timeoutMs: 1 });
	// Whatever it decides, it decides without throwing.
	assert.equal(notice, null);
	const stamp = JSON.parse(await readFile(join(directory, "version-check.json"), "utf8")) as { latest: unknown };
	assert.equal(stamp.latest, null);
});

test("a version this build already has is not an update", async (t) => {
	const directory = await base(t);
	// The stamped answer is only reported when it is newer than what is running, and
	// 0.0.1 is older than anything published.
	await writeFile(
		join(directory, "version-check.json"),
		JSON.stringify({ checked_at: new Date().toISOString(), latest: "0.0.1" }),
		"utf8",
	);
	assert.equal(await updateNotice(directory, { now: Date.now(), timeoutMs: 1 }), null);
});
