import { cp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.ts";

// Starting over has to be reversible. Everything a bot accumulates — the event
// log, the memories, the receipts, the persona — is the only record of what it
// did and who it has met, and a reset that loses it silently makes the whole
// record untrustworthy. So a reset is a move, not a delete: the state is copied
// aside first, and the command reports where it went.

// What counts as bot state. The browser profile is deliberately excluded: it
// holds a login, it is large, and keeping it means a reset does not force
// another scan.
const STATE = [
	"AGENTS.md",
	"PROFILES.md",
	"MEMORY.md",
	"history.jsonl",
	"receipts.json",
	// What earlier rounds learned. It was added after this list was written, so a
	// reset kept it: a "fresh" bot started with everything the previous one had
	// been taught, which is the opposite of starting over.
	"lessons.md",
	"growth.json",
	"onboarding.json",
	"state.sqlite",
];
const DIRECTORIES = ["memory", "decisions", "observations", "captures"];

export interface ResetPlan {
	root: string;
	backup: string;
	moves: string[];
	keep: string[];
	absent: string[];
}

export async function resetPlan(root: string, backup: string): Promise<ResetPlan> {
	const moves: string[] = [];
	const absent: string[] = [];
	for (const name of STATE) {
		const present = await stat(join(root, name)).then(
			() => true,
			() => false,
		);
		if (present) moves.push(name);
		else absent.push(name);
	}
	for (const name of DIRECTORIES) {
		const entries = await readdir(join(root, name)).catch(() => null);
		if (entries?.length) moves.push(`${name}/`);
	}
	// The Chrome profile is the one thing kept: it is a login, not knowledge.
	const keep = (await readdir(join(root, "chrome")).catch(() => null)) ? ["chrome/ (login kept)"] : [];
	return { root, backup, moves, keep, absent };
}

export async function resetApply(plan: ResetPlan): Promise<{ backup: string; moved: string[] }> {
	if (!plan.moves.length)
		throw new CliError("state", "There is no bot state to reset", { details: { root: plan.root } });
	await cp(plan.root, plan.backup, {
		recursive: true,
		// The browser profile is large and is not part of what is being reset.
		filter: (source) => !source.startsWith(join(plan.root, "chrome")),
	});
	// The whole workspace is already copied above; what is left is removing the
	// originals, which is the only destructive step and happens after the copy.
	for (const name of plan.moves) {
		const target = join(plan.root, name.replace(/\/$/, ""));
		await rm(target, { recursive: true, force: true });
	}
	return { backup: plan.backup, moved: plan.moves };
}
