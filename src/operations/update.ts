import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// How this dy was installed, and what updates it.
//
// The commit answers "am I current" and the version answers "how far behind am I".
// Both are reported because they answer different questions: the version changes
// when a capability layer lands, and several dozen commits can sit inside one
// version. A version alone would say "0.3.0" to a copy twenty commits behind and
// to one a commit behind, which is why it is not the only signal.
//
// Reinstalling is the update mechanism: npm records a git dependency by commit,
// and a plain `npm install` on an already-satisfied range reports "up to date"
// without fetching new commits.

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

// The version this copy was built with, read beside the executable so an installed
// package (which has no src/) can still report it.
function packageVersion(): string | null {
	try {
		const root = packageRoot();
		const info = existsSync(join(root, "package.json")) ? join(root, "package.json") : null;
		if (!info) return null;
		const data: unknown = JSON.parse(readFileSync(info, "utf8"));
		return typeof data === "object" && data !== null && "version" in data ? String(data.version) : null;
	} catch {
		return null;
	}
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
	// An installed copy has no .git, so it records the commit it was built from
	// beside the build. The managed installer writes its own marker; a plain npm
	// install gets one from prepare.
	const marker = existsSync(join(entry, ".dy-build-commit"))
		? join(entry, ".dy-build-commit")
		: join(entry, "..", "commit");
	const head = existsSync(marker) ? readCommit(marker) : null;
	// Which source this came from. A published package has no .git and was never
	// built from a working tree, so updating it from a git spec would switch it to a
	// different source; the registry name is the only one it knows. The build writes
	// `origin` beside the commit for exactly this, and a copy without it predates
	// publishing and can only have come from git.
	const originPath = join(entry, ".dy-build-origin");
	const origin = existsSync(originPath) ? readText(originPath) : "git";
	const managed = existsSync(join(entry, "..", ".dy-release-owner"));
	const global = entry.includes(`${join("lib", "node_modules")}`) || entry.includes(`${join("pnpm", "global")}`);
	return {
		entry,
		kind: managed ? "managed-release" : global ? "npm-global" : "npm-local",
		head,
		// A published copy is updated from the registry by name: a git spec would
		// reinstall from a different source and lose the fact that the version is
		// what npm tracks. A copy installed from git keeps the git spec, because that
		// is the only source it has.
		update: managed
			? "sh scripts/install.sh"
			: origin === "npm"
				? `${global ? "npm install -g" : "npm install"} shuadouyin@latest`
				: `${global ? "npm install -g" : "npm install"} github:9Ashwin/ShuaDouyin@latest`,
		has_source: false,
	};
}

// A one-line marker written beside the build. Absent means a copy built before the
// marker existed, which can only have come from a working tree.
function readText(path: string): string {
	try {
		return readFileSync(path, "utf8").trim() || "git";
	} catch {
		return "git";
	}
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

// The whole answer `dy update` gives, so both the dispatch path and a test can
// call it without inventing a workspace.
export async function updateReport(check: boolean): Promise<unknown> {
	const shape = installShape();
	const version = packageVersion();
	if (!check) return { ...shape, version, latest: null, behind: null, note: null };
	const remote = await latestCommit();
	return {
		...shape,
		version,
		latest: remote.head,
		// null means "cannot tell", which is not the same as false.
		behind: shape.head && remote.head ? shape.head !== remote.head : null,
		note: remote.error,
	};
}
