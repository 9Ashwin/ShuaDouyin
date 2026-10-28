import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The CLI is expected to answer for itself from any project, so an agent using
// dy elsewhere can still find the checkout that produced this binary. The
// module location is the only reliable answer: the caller's cwd is their own
// project, and the installed binary may be a copy with no source beside it.

export interface SourceInfo {
	path: string | null;
	entry: string;
	managed: boolean;
	head: string | null;
	branch: string | null;
	dirty: boolean | null;
	error: string | null;
}

function git(root: string, ...args: string[]): string | null {
	try {
		return execFileSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

export function sourceCheckout(override?: string): SourceInfo {
	const entry = fileURLToPath(import.meta.url);
	// This module is <root>/dist/operations/source.js after the build and
	// <root>/src/operations/source.ts from tests, so the package root is two
	// levels up in both layouts.
	const root = resolve(override ?? join(dirname(entry), "..", ".."));
	const managed = existsSync(join(root, "package.json")) && existsSync(join(root, "src", "cli.ts"));
	if (!managed)
		return {
			path: null,
			entry,
			managed: false,
			head: null,
			branch: null,
			dirty: null,
			error: "This dy runs from an installed release with no source checkout.",
		};
	const head = git(root, "rev-parse", "HEAD");
	const branch = git(root, "rev-parse", "--abbrev-ref", "HEAD");
	const status = git(root, "status", "--porcelain");
	return {
		path: root,
		entry,
		managed: true,
		head,
		branch,
		dirty: status === null ? null : status.length > 0,
		error: head ? null : "The source path is not a Git working tree.",
	};
}
