import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { withLease } from "../src/lease.ts";

// The lock is a directory, created with mkdir and removed with rmdir. A process
// that dies, or a release that is skipped, leaves it behind — and rmdir refuses a
// directory that holds anything, which reported ENOTEMPTY as an internal error and
// made the workspace look permanently locked. These tests pin both halves: a live
// lock still refuses, and a stale one is reclaimed whatever is inside it.

async function workspace(t: { after: (fn: () => Promise<void>) => void }) {
	const base = await mkdtemp(join(tmpdir(), "dy-lease-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	return base;
}

const age = async (path: string, minutes: number) => {
	// utimes on a directory is what the library reads when it decides staleness.
	const when = new Date(Date.now() - minutes * 60_000);
	await utimes(path, when, when);
};

test("a lease is released, leaving no directory behind", async (t) => {
	const base = await workspace(t);
	const target = join(base, "operation");
	await withLease(target, async () => undefined);
	await assert.rejects(stat(`${target}.lock`), "the lock directory must be gone");
});

test("a live lock is refused with something a reader can act on", async (t) => {
	const base = await workspace(t);
	const target = join(base, "operation");
	await mkdir(`${target}.lock`, { recursive: true });
	await assert.rejects(
		withLease(target, async () => undefined),
		(error: unknown) => {
			assert.equal((error as { code: string }).code, "busy");
			// The failure has to say what to do; a raw errno cannot.
			assert.match((error as { hint: string }).hint, /Wait/);
			return true;
		},
	);
});

test("a stale lock is reclaimed even when it holds a file", async (t) => {
	// This is the state that looked unreclaimable: the file was deletable by hand
	// and the directory was not, because release reached for rmdir.
	const base = await workspace(t);
	const target = join(base, "operation");
	await mkdir(`${target}.lock`, { recursive: true });
	await writeFile(join(`${target}.lock`, "leftover"), "x");
	await age(`${target}.lock`, 10);
	let ran = false;
	await withLease(target, async () => {
		ran = true;
	});
	assert.equal(ran, true);
	await assert.rejects(stat(`${target}.lock`));
});

test("a directory left behind from an earlier run is swept", async (t) => {
	// A machine that already accumulated these recovers without anyone deleting
	// files by hand.
	const base = await workspace(t);
	const target = join(base, "operation");
	const leftover = `${target}.lock.1700000000000000000`;
	await mkdir(leftover, { recursive: true });
	await age(leftover, 120);
	await withLease(target, async () => undefined);
	const entries = await readdir(base);
	assert.deepEqual(
		entries.filter((entry) => entry.startsWith("operation.lock.")),
		[],
	);
});

test("a fresh leftover is left alone", async (t) => {
	// Sweeping is for things that cannot belong to a live command. A directory from
	// a moment ago may be exactly that.
	const base = await workspace(t);
	const target = join(base, "operation");
	const recent = `${target}.lock.1700000000000000000`;
	await mkdir(recent, { recursive: true });
	await withLease(target, async () => undefined);
	const entries = await readdir(base);
	assert.ok(entries.includes("operation.lock.1700000000000000000"));
});

test("a command that throws still releases the lease", async (t) => {
	const base = await workspace(t);
	const target = join(base, "operation");
	await assert.rejects(
		withLease(target, async () => {
			throw new Error("command failed");
		}),
		/command failed/,
	);
	await assert.rejects(stat(`${target}.lock`));
});
