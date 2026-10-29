import { execFileSync } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// How this dy was installed, and what updates it.
//
// The package version never changes between pushes (it is still 0.1.0), so a
// version number cannot answer "am I current". What does answer it is the git
// commit the installed copy was built from, compared with the repository's
// current main. That is also why reinstalling is the update mechanism: npm
// records a git dependency by commit, and a plain `npm install` on an
// already-satisfied range reports "up to date" without fetching new commits.

export interface InstallShape {
	// Where this executable lives, after resolving symlinks.
	entry: string;
	// Which of the four installs this looks like.
	kind: "checkout" | "npm-global" | "npm-local" | "managed-release" | "unknown";
	// The source commit this copy reports, when it can be read.
	head: string | null;
	// The command that brings this same shape up to date.
	update: string;
	// True when a copy exists beside the executable, which is what `dy source`
	// needs; a published package keeps its source out of the package.
	has_source: boolean;
}

function git(root: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

// The directory the running code is in: dist/operations/update.js after a
// build, src/operations/update.ts from tests. The package root is two levels up.
function packageRoot(): string {
	const entry = fileURLToPath(import.meta.url);
	return resolve(dirname(entry), "..", "..");
}

export function installShape(): InstallShape {
	const root = packageRoot();
	let entry = root;
	try {
		entry = realpathSync(root);
	} catch {
		// A path that cannot be resolved is still worth reporting as-is.
	}
	const hasSource = existsSync(join(entry, "src", "cli.ts"));
	if (hasSource) {
		return {
			entry,
			kind: "checkout",
			head: git(entry, "rev-parse", "HEAD"),
			// A checkout is updated by pulling; a build is what makes the new code
			// the running code, and `pnpm build` also rewrites dist/.
			update: `git -C '${entry}' pull --ff-only && pnpm -C '${entry}' install --frozen-lockfile --ignore-scripts && pnpm -C '${entry}' build`,
			has_source: true,
		};
	}
	// A managed release carries the commit in a file beside the build.
	const marker = join(entry, "..", "commit");
	const head = existsSync(marker) ? readCommit(marker) : null;
	const managed = existsSync(join(entry, "..", ".dy-release-owner"));
	const global = entry.includes(`${join("lib", "node_modules")}`) || entry.includes(`${join("pnpm", "global")}`);
	return {
		entry,
		kind: managed ? "managed-release" : global ? "npm-global" : "npm-local",
		head,
		update: managed
			? "sh scripts/install.sh"
			: `${global ? "npm install -g" : "npm install"} github:9Ashwin/ShuaDouyin@latest`,
		has_source: false,
	};
}

function readCommit(path: string): string | null {
	try {
		return execFileSync("cat", [path], { encoding: "utf8" }).trim() || null;
	} catch {
		return null;
	}
}

// The newest commit on the repository, or null when the network is
// unreachable. Reported rather than thrown: an offline machine still has a
// working dy, and "could not check" is a different answer from "out of date".
export async function latestCommit(timeoutMs = 5000): Promise<{ head: string | null; error: string | null }> {
	try {
		const response = await fetch("https://api.github.com/repos/9Ashwin/ShuaDouyin/commits/main", {
			signal: AbortSignal.timeout(timeoutMs),
			redirect: "error",
			headers: { accept: "application/vnd.github+json" },
		});
		if (!response.ok) return { head: null, error: `GitHub returned HTTP ${response.status}` };
		const data: unknown = await response.json();
		const sha = data && typeof data === "object" && "sha" in data ? String(data.sha) : "";
		return { head: /^[a-f0-9]{40}$/.test(sha) ? sha : null, error: sha ? null : "No commit in the response" };
	} catch (cause) {
		return { head: null, error: cause instanceof Error ? cause.message.split("\n")[0] : "Network unavailable" };
	}
}
