import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { skillInstall, skillStatus } from "../src/operations/skill.ts";

async function home(t: { after: (fn: () => Promise<void>) => void }, agents: string[]) {
	const directory = await mkdtemp(join(tmpdir(), "dy-skill-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	for (const agent of agents) await mkdir(join(directory, agent), { recursive: true });
	return directory;
}

test("an agent that exists gets the skill even when its skills folder does not", async (t) => {
	// A fresh machine has ~/.claude but no ~/.claude/skills. Testing the latter
	// made install skip every target and still report success, so nothing was
	// installed and nothing said so.
	const directory = await home(t, [".claude"]);
	const result = await skillInstall(directory);
	assert.deepEqual(result.installed, [join(directory, ".claude", "skills", "dy")]);
	assert.ok(existsSync(result.installed[0]));
	const info = await stat(result.installed[0]);
	assert.ok(info.isSymbolicLink() || info.isDirectory());
});

test("an agent the user does not have is skipped rather than created", async (t) => {
	const directory = await home(t, [".claude"]);
	const result = await skillInstall(directory);
	assert.ok(result.skipped.includes(join(directory, ".agents", "skills", "dy")));
	assert.equal(existsSync(join(directory, ".agents")), false);
});

test("a copy that is not ours is left alone unless forced", async (t) => {
	const directory = await home(t, [".claude"]);
	const target = join(directory, ".claude", "skills", "dy");
	await mkdir(target, { recursive: true });
	const kept = await skillInstall(directory);
	assert.deepEqual(kept.installed, []);
	assert.ok(kept.skipped.includes(target), "an existing foreign copy must not be replaced");
	const replaced = await skillInstall(directory, { force: true });
	assert.deepEqual(replaced.installed, [target]);
});

test("status reports a copy that has drifted from the bundled skill", async (t) => {
	const directory = await home(t, [".claude"]);
	await skillInstall(directory);
	const clean = skillStatus(directory);
	assert.equal(clean.drifted, 0);
	const copy = clean.copies.find((entry) => entry.path === join(directory, ".claude", "skills", "dy"));
	assert.ok(copy);
	// The copy is a symlink to the checkout, so it cannot drift; status still has
	// to say it matches rather than leaving the field null.
	assert.equal(copy.matches, true);
});
