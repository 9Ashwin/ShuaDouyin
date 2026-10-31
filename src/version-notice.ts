import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { packageVersion } from "./operations/update.ts";

// A quiet weekly check for a newer release.
//
// `dy` ships as a package the owner installs once and then runs for months, and
// the failure that costs the most is the quiet one: a command that broke in a
// release and was fixed in the next, while the copy on disk stayed behind. The
// owner does not read changelogs mid-task, so nothing says so.
//
// What this is not: an updater. It reports, and the owner decides. An agent that
// replaced the running binary mid-session would change the tool under a task that
// is halfway through it, and the versions in its own transcript would stop
// matching the ones it is running.
//
// The cost is bounded on purpose. `dy` runs many times per session and an agent
// runs many sessions, so a request per command would be hundreds a day against a
// public API and a per-command wait on a network that may be absent. One check a
// day, recorded on disk, and silence on every failure.

const INTERVAL_MS = 24 * 60 * 60_000;
const STAMP = "version-check.json";

interface Stamp {
	/** When the check was last attempted, so a failure is not retried every command. */
	checked_at: string;
	/** The newest version GitHub reported, or null when the check could not run. */
	latest: string | null;
}

// The version this copy was built with. A package with no version cannot be
// compared to anything, and guessing would make the one claim this file makes
// unreliable.
function currentVersion(): string {
	return packageVersion() ?? "0.0.0";
}

function isNewer(latest: string, current: string): boolean {
	// Semver only as far as this project uses it: three numeric parts. Anything else
	// is not comparable, and a comparison that guesses would produce a wrong answer
	// about the one thing this is for.
	const split = (value: string): number[] | null => {
		const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
		return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
	};
	const a = split(latest);
	const b = split(current);
	if (!a || !b) return false;
	for (let index = 0; index < 3; index++) {
		if (a[index] !== b[index]) return (a[index] as number) > (b[index] as number);
	}
	return false;
}

async function newestRelease(timeoutMs: number): Promise<string | null> {
	try {
		// The registry rather than the repository: what an owner installs is the
		// published package, and a commit that has not been published is not an
		// upgrade they can act on.
		const response = await fetch("https://registry.npmjs.org/shuadouyin/latest", {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "error",
			headers: { accept: "application/json" },
		});
		if (!response.ok) return null;
		const data: unknown = await response.json();
		const version = data && typeof data === "object" && "version" in data ? String(data.version) : "";
		return /^\d+\.\d+\.\d+/.test(version) ? version : null;
	} catch {
		return null;
	}
}

// The notice, or null.
//
// Never throws: a version check that fails must not turn a command that worked
// into one that did not.
export async function updateNotice(
	base: string,
	options: { now?: number; timeoutMs?: number } = {},
): Promise<object | null> {
	const now = options.now ?? Date.now();
	const path = join(base, STAMP);
	let stamp: Stamp | null = null;
	try {
		stamp = JSON.parse(await readFile(path, "utf8")) as Stamp;
	} catch {
		// No stamp, or one that cannot be read: check now. A corrupt stamp costs one
		// request, not a broken command.
		stamp = null;
	}
	const checkedAt = stamp ? Date.parse(stamp.checked_at) : Number.NaN;
	if (stamp && Number.isFinite(checkedAt) && now - checkedAt < INTERVAL_MS) {
		// Already checked recently. Report the last answer rather than asking again —
		// the point of the stamp is that a session full of commands costs one request.
		const current = currentVersion();
		if (!stamp.latest || !isNewer(stamp.latest, current)) return null;
		return noticeFor(current, stamp.latest);
	}
	const latest = await newestRelease(options.timeoutMs ?? 3000);
	// A failed check is recorded too. Without it, a machine with no route to the
	// registry would retry on every command, which is the one behaviour this exists
	// to avoid.
	try {
		await writeFile(path, JSON.stringify({ checked_at: new Date(now).toISOString(), latest }), "utf8");
	} catch {
		// Recording is a courtesy to the next run, not part of the answer.
	}
	const current = currentVersion();
	if (!latest || !isNewer(latest, current)) return null;
	return noticeFor(current, latest);
}

function noticeFor(current: string, latest: string): object {
	return {
		current,
		latest,
		// Written for the owner, not for an agent: it names the command and stops.
		// Nothing here invites an agent to run it, because replacing the binary
		// under a task in progress is the thing this notice is careful not to cause.
		message: `A newer release is available: ${current} → ${latest}. Update with: npm install -g shuadouyin@latest`,
	};
}
