import { mkdir, readdir, rm, rmdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { CliError } from "./errors.ts";

// A lease for the workspace, and the cleanup nobody was doing.
//
// proper-lockfile creates a directory and removes it with rmdir on release. When
// the process is killed, or the release path is skipped, the directory stays —
// empty, on disk, and indistinguishable from a lock someone holds. Every later
// command then answers busy until the stale timer expires two minutes later. In
// practice that read as "the lock cannot be reclaimed", and the workaround was to
// move the directory aside by hand before every command.
//
// Three things are added on top of the library. A release that fails is no longer
// silent. A lock directory older than the stale window is removed before acquiring
// rather than only being noticed by the library's own check. And leftovers from
// earlier runs are swept, so a machine that has already accumulated them recovers
// without anyone deleting files.

const STALE_MS = 120_000;
// Leftovers are swept rather than only the one about to be acquired: a directory
// from a killed process belongs to no live command, and finding it later is what
// made the workspace look permanently locked.
const SWEEP_MS = 60 * 60_000;

async function sweep(lockPath: string): Promise<string[]> {
	const directory = dirname(lockPath);
	const prefix = `${lockPath.slice(directory.length + 1)}.`;
	const removed: string[] = [];
	let entries: string[];
	try {
		entries = await readdir(directory);
	} catch {
		return removed;
	}
	for (const entry of entries) {
		if (!entry.startsWith(prefix)) continue;
		const path = join(directory, entry);
		try {
			const info = await stat(path);
			// A directory with content is not ours to remove: the library never puts
			// anything inside, so a non-empty one is something else's data.
			if (Date.now() - info.mtimeMs < SWEEP_MS) continue;
			await rmdir(path);
			removed.push(path);
		} catch {
			// A path that vanished between listing and stat is already gone, and one
			// that cannot be removed is not a reason to refuse the command.
		}
	}
	return removed;
}

// Remove a lock directory whatever is inside it.
//
// The contents are the library's own bookkeeping, never a user's data: this path
// is `<state>/.operation.lock`, and it only ever holds what a lock implementation
// put there. rm with recursive is used because rmdir refuses a non-empty
// directory, and that refusal is the whole bug.
async function forceRemove(lockPath: string): Promise<void> {
	await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
}

// The lock directory still being there after release means the next command will
// report busy for something this process already finished with. Removing it here,
// and saying so, is what turns a silent leak into something that cleans itself up.
async function releaseAndVerify(release: () => Promise<void>, lockPath: string): Promise<CliError | null> {
	let failure: CliError | null = null;
	try {
		await release();
	} catch {
		// A throw here does not mean the lock survived: the library's internal state
		// and the directory on disk disagree often enough that reporting the throw
		// printed a warning on nearly every command while the data was correct. The
		// only thing worth telling a caller is that the directory is still there,
		// which is checked below.
	}
	// The same removal the acquire path uses: rmdir alone leaves a directory that
	// holds one stray file behind, and that is the state a later command reads as
	// busy.
	await forceRemove(lockPath);
	// The check that matters: does a later command have to wait on this?
	const stillThere = await stat(lockPath).then(
		() => true,
		() => false,
	);
	if (stillThere)
		failure = new CliError("busy", "The workspace lock was left behind", {
			hint: `Remove ${lockPath} before the next command, or wait for it to be reclaimed.`,
		});
	return failure;
}

// Infinity would turn a lock that cannot be removed into a command that never
// returns, which is worse than one that fails. Two attempts is what one recovery
// needs: one to remove the stale lock, one to acquire it.
const MAX_RECOVERIES = 2;

export async function withLease<T>(path: string, run: (signal: AbortSignal) => Promise<T>, recoveries = 0): Promise<T> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	await sweep(`${path}.lock`);
	const ownership = new AbortController();
	let release: () => Promise<void>;
	try {
		release = await lockfile.lock(path, {
			realpath: false,
			stale: STALE_MS,
			update: 10_000,
			retries: 0,
			onCompromised: (cause) => ownership.abort(new CliError("busy", "Workspace lock ownership was lost", { cause })),
		});
	} catch (error) {
		// A lock left behind by a killed process is older than the stale window, and
		// the library only removes it if it actually tries to acquire. This is that
		// try, with the same age test the library uses.
		// ENOTEMPTY arrives on the same path: the library judges a lock stale itself
		// and then removes it with rmdir, which refuses a directory holding anything.
		// Its own stale handling therefore failed with the system's wording, which is
		// what made this look like a filesystem problem rather than a lock one.
		const code = typeof error === "object" && error !== null && "code" in error ? String(error.code) : "";
		if (code === "ELOCKED" || code === "ENOTEMPTY") {
			const lockPath = `${path}.lock`;
			const aged =
				code === "ENOTEMPTY"
					? true
					: await stat(lockPath)
							.then((info) => Date.now() - info.mtimeMs >= STALE_MS)
							.catch(() => true);
			if (aged) {
				// The library created this with mkdir and removes it with rmdir, so a
				// directory holding anything at all cannot be removed — and rmdir
				// answers ENOTEMPTY, which surfaced as an internal error with the
				// system's wording. That is the state that made the lock look
				// unreclaimable: files inside were deletable by hand, the directory
				// was not.
				if (recoveries >= MAX_RECOVERIES)
					throw new CliError("busy", "The workspace lock could not be cleared", {
						hint: `Remove ${lockPath} by hand. Nothing else is holding it.`,
						details: { path: lockPath, recoveries },
					});
				await forceRemove(lockPath);
				return withLease(path, run, recoveries + 1);
			}
			throw new CliError("busy", "Another command owns this workspace", {
				hint: "Wait for that command to finish.",
			});
		}
		throw error;
	}
	let outcome: { ok: true; value: T } | { ok: false; error: unknown } | undefined;
	try {
		const result = await run(ownership.signal);
		ownership.signal.throwIfAborted();
		outcome = { ok: true, value: result };
	} catch (error) {
		outcome = { ok: false, error };
	} finally {
		// The release problem is reported on stderr, not raised: a command that did
		// its work and then failed to clean up still did its work, and turning that
		// into a failure would make a delivered comment look undelivered.
		const releaseFailure = await releaseAndVerify(release, `${path}.lock`);
		if (releaseFailure) process.stderr.write(`${JSON.stringify({ ok: false, warning: releaseFailure.message })}\n`);
	}
	if (!outcome) throw new CliError("internal", "The lease produced no result");
	if (!outcome.ok) throw outcome.error;
	return outcome.value;
}
