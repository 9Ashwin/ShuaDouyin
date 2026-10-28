import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { cp, mkdir, readlink, rm, symlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../errors.ts";

// The skill ships beside the executable, but an agent reads whatever copy is
// installed in its own skills directory. Those two drift silently: the repo's
// guidance improves and the installed copy keeps telling the agent the old
// thing. Each copy is hashed so the difference is visible instead of inferred.

export interface CopyState {
	path: string;
	kind: "symlink" | "directory" | "missing";
	target: string | null;
	digest: string | null;
	matches: boolean | null;
}

function bundled(): string {
	return resolve(fileURLToPath(new URL("../../skills/dy", import.meta.url)));
}

function digestOf(directory: string): string | null {
	if (!existsSync(directory)) return null;
	const files: string[] = [];
	const walk = (root: string, prefix: string) => {
		for (const entry of readdirSync(root, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			if (entry.isDirectory()) walk(join(root, entry.name), relative);
			else if (entry.isFile()) files.push(relative);
		}
	};
	walk(directory, "");
	const hash = createHash("sha256");
	// The path is hashed with the content so a renamed reference still counts as
	// a difference: what an agent loads is the file layout as much as the text.
	for (const file of files) {
		hash.update(`${file}\0`);
		hash.update(readFileSync(join(directory, file)));
		hash.update("\0");
	}
	return hash.digest("hex");
}

function inspect(path: string, expected: string | null): CopyState {
	if (!existsSync(path)) return { path, kind: "missing", target: null, digest: null, matches: null };
	const info = lstatSync(path);
	if (info.isSymbolicLink()) {
		const target = realpathSync(path);
		const digest = digestOf(target);
		return { path, kind: "symlink", target, digest, matches: expected === null ? null : digest === expected };
	}
	if (!info.isDirectory()) throw new CliError("state_corrupt", "Installed skill path is not a directory");
	const digest = digestOf(path);
	return { path, kind: "directory", target: null, digest, matches: expected === null ? null : digest === expected };
}

export function skillStatus(home = homedir()) {
	const source = bundled();
	const expected = digestOf(source);
	const candidates = [
		join(home, ".claude", "skills", "dy"),
		join(home, ".agents", "skills", "dy"),
		join(home, ".codex", "skills", "dy"),
	];
	const copies = candidates.map((path) => inspect(path, expected));
	const drifted = copies.filter((copy) => copy.kind !== "missing" && copy.matches === false);
	return {
		bundled: { path: source, digest: expected, exists: expected !== null },
		copies,
		drifted: drifted.length,
		// A copy that is a symlink to this checkout can never drift; only a real
		// directory can hold an older version, so the hint names that case.
		hint: drifted.length
			? "Copy the bundled skill over the drifted directory, or replace it with a symlink to the checkout."
			: null,
		scope: "installed_skill_copies",
	};
}

// Installing means copying the bundled skill into the directories agents read.
// A symlink back to this checkout is used when one is possible: then the agent
// always reads the current guidance, and there is no copy to drift.
export async function skillInstall(
	home = homedir(),
	options: { force?: boolean } = {},
): Promise<{ installed: string[]; skipped: string[]; source: string }> {
	const source = bundled();
	if (!existsSync(source))
		throw new CliError("not_found", "The bundled skill is missing from this install", {
			hint: "Reinstall dy; the skills directory ships beside the executable.",
		});
	const agents = [".claude", ".agents", ".codex"];
	const installed: string[] = [];
	const skipped: string[] = [];
	for (const agent of agents) {
		const root = join(home, agent);
		const parent = join(root, "skills");
		const target = join(parent, "dy");
		// An agent the user does not have is not this tool's business to create: a
		// skill installed for a program that will never read it leaves a stray
		// directory behind. The test is the agent's own directory, not the skills
		// folder inside it — on a fresh machine `~/.claude` exists and `skills/`
		// does not, and testing the latter made `skill install` report success
		// while installing nothing.
		if (!existsSync(root)) {
			skipped.push(target);
			continue;
		}
		const existing = existsSync(target) ? lstatSync(target) : null;
		if (existing) {
			// An existing copy that is not ours is the user's; replacing it silently
			// would throw away whatever they had. `--force` is the only way past.
			const ours = existing.isSymbolicLink() && (await readlink(target).catch(() => "")) === source;
			if (!options.force && !ours) {
				skipped.push(target);
				continue;
			}
			await rm(target, { recursive: true, force: true });
		}
		try {
			await mkdir(parent, { recursive: true });
			await symlink(source, target, "dir");
		} catch {
			// A symlink can fail across filesystems or without permission; a copy is
			// the fallback, and skill status will report it if it drifts.
			await cp(source, target, { recursive: true });
		}
		installed.push(target);
	}
	return { installed, skipped, source };
}
