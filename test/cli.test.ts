import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { COMMANDS } from "../src/catalog.ts";
import { createProgram, packageVersion, run } from "../src/main.ts";

async function invoke(args: string[]) {
	let stdout = "";
	let stderr = "";
	const exit = await run(args, {
		stdout: {
			write: (text) => {
				stdout += text;
			},
		},
		stderr: {
			write: (text) => {
				stderr += text;
			},
		},
	});
	return { exit, stdout, stderr };
}

test("schema and help come from the same command catalog", async () => {
	const result = await invoke(["schema"]);
	assert.equal(result.exit, 0);
	assert.equal(result.stderr, "");
	const envelope = JSON.parse(result.stdout);
	assert.equal(envelope.ok, true);
	assert.deepEqual(
		envelope.data.commands.map((command: { id: string }) => command.id),
		COMMANDS.map((command) => command.id),
	);
	for (const command of COMMANDS) {
		const help = await invoke([...command.id.split("."), "--help"]);
		assert.equal(help.exit, 0, command.id);
		assert.match(help.stdout, /Usage: dy/);
		assert.equal(help.stderr, "");
	}
	assert.equal((await invoke(["--version"])).stdout.trim(), await packageVersion());
});

test("version flag uses the version supplied by package metadata", async () => {
	let output = "";
	const program = createProgram(
		{
			stdout: {
				write: (text) => {
					output += text;
				},
			},
			stderr: { write: () => undefined },
		},
		undefined,
		"9.8.7",
	);
	await assert.rejects(program.parseAsync(["--version"], { from: "user" }), { exitCode: 0 });
	assert.equal(output.trim(), "9.8.7");
});

test("agent guide explains how to prepare, present and save sourced reports", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-guide-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await invoke(["--state-dir", directory, "guide"]);
	assert.equal(result.exit, 0);
	const guide = JSON.parse(result.stdout).data.markdown as string;
	assert.match(guide, /report prepare/);
	assert.match(guide, /在对话中呈现/);
	assert.match(guide, /delivery_verified=false/);
	assert.match(guide, /growth ack/);
});

test("every command is named somewhere an agent can read", async (t) => {
	// The skill is what an agent reads to learn the tool; `schema` is what a
	// developer reads to look up a flag. A command that appears only in the
	// schema is effectively invisible to a caller that never thinks to ask for
	// it. This caught 71 of 106 commands missing when the check was added.
	const directory = await mkdtemp(join(tmpdir(), "dy-guide-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const result = await invoke(["--state-dir", directory, "guide"]);
	const guide = (JSON.parse(result.stdout).data.markdown as string).replace(/\s+/g, " ");
	const paths = ["skill", "onboarding", "growth", "workspace", "memory", "browse", "context", "report", "bot"];
	const missing = COMMANDS.filter((command) => !guide.includes(command.id.split(".").join(" ")));
	assert.deepEqual(
		missing.map((command) => command.id),
		[],
		"add these to skills/dy so a caller can find them",
	);
	// Guard the guard: the guide has to be the assembled document, not the entry
	// file alone, or the reference pages would be silently dropped.
	assert.match(guide, /命令地图/);
	for (const group of paths) assert.ok(guide.includes(`dy ${group}`), `guide should name dy ${group}`);
});

test("the commands the installer verifies still exist", async (t) => {
	// scripts/install.sh runs these to prove an install works before switching to
	// it. It kept calling a `--bot` flag that had been removed, so every curl
	// install failed its own smoke test at the last step.
	const directory = await mkdtemp(join(tmpdir(), "dy-install-smoke-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const installer = await readFile(resolve("scripts/install.sh"), "utf8");
	assert.ok(installer.includes("memory add --text"), "the smoke test should still add a memory");
	assert.doesNotMatch(installer, /--bot\b/, "the --bot flag is gone; one install is one bot");
	const init = await invoke(["--state-dir", directory, "init"]);
	assert.equal(init.exit, 0);
	const added = await invoke([
		"--state-dir",
		directory,
		"memory",
		"add",
		"--text",
		"installation smoke test",
		"--source",
		"user:installation-test",
	]);
	assert.equal(added.exit, 0, added.stderr);
	const status = await invoke(["--state-dir", directory, "memory", "status"]);
	assert.equal(status.exit, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).data.healthy, true);
	const guide = await invoke(["--state-dir", directory, "guide"]);
	assert.equal(guide.exit, 0, guide.stderr);
	assert.match(JSON.parse(guide.stdout).data.markdown as string, /growth/);
});

test("dry run preserves text and does not create state or start Chrome", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-cli-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const state = join(directory, "untouched");
	const text = "  你好\n精确内容 $() `不会执行`  ";
	const result = await invoke([
		"--state-dir",
		state,
		"--chrome",
		"/does/not/exist",
		"comment",
		"post",
		"--video-id",
		"12345",
		"--text",
		text,
		"--dry-run",
	]);
	assert.equal(result.exit, 0);
	assert.equal(JSON.parse(result.stdout).data.input.text, text);
	assert.equal(JSON.parse(result.stdout).dry_run, true);
	assert.equal(result.stderr, "");
	await assert.rejects(access(state));
	const path = join(directory, "message.txt");
	await writeFile(path, text);
	const fileResult = await invoke([
		"--state-dir",
		state,
		"comment",
		"post",
		"--video-id",
		"12345",
		"--text-file",
		path,
		"--dry-run",
	]);
	assert.equal(JSON.parse(fileResult.stdout).data.input.text, text);
});

test("argument failures produce exactly one stderr envelope and no stdout", async () => {
	const cases = [
		["unknown-command"],
		["comment", "post", "--video-id", "123", "--text", "hello"],
		["video", "like", "--video-id", "123", "--value", "maybe"],
		["search", "hello", "--limit", "NaN"],
		["search", "hello", "--limit", "1.5"],
		["video", "open", "https://evil.example/video/123"],
		["--format", "yaml", "schema"],
		["--timeout", "-1", "schema"],
		["schema", "does", "not", "exist"],
	];
	for (const args of cases) {
		const result = await invoke(args);
		assert.equal(result.exit, 2, args.join(" "));
		assert.equal(result.stdout, "");
		const lines = result.stderr.trim().split("\n");
		assert.equal(lines.length, 1);
		assert.equal(JSON.parse(lines[0]).error.type, "validation");
		assert.equal(JSON.parse(lines[0]).ok, false);
	}
});

test("TUI refuses pipelines while ordinary commands remain noninteractive", async () => {
	if (process.stdin.isTTY && process.stdout.isTTY) return;
	const result = await invoke(["tui"]);
	assert.equal(result.exit, 2);
	assert.equal(result.stdout, "");
	assert.equal(JSON.parse(result.stderr).error.code, "invalid_argument");
});

test("CLI memory workflow uses the one installation workspace", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-cli-workspace-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const state = join(base, "state");
	const init = await invoke(["--state-dir", state, "init", "--name", "fish"]);
	assert.equal(init.exit, 0, init.stderr);
	const added = await invoke([
		"--state-dir",
		state,
		"memory",
		"add",
		"--text",
		"用户偏好简明表达",
		"--source",
		"user:conversation",
		"--subject",
		"owner",
		"--certainty",
		"user-stated",
	]);
	assert.equal(added.exit, 0, added.stderr);
	const memory = JSON.parse(added.stdout).data;
	const context = await invoke(["--state-dir", state, "context", "show", "--query", "简明"]);
	assert.equal(context.exit, 0, context.stderr);
	assert.equal(JSON.parse(context.stdout).data.memories[0].id, memory.id);
	// A state directory without a workspace reports the missing installation
	// instead of starting one implicitly.
	const missing = await invoke(["--state-dir", join(base, "absent"), "memory", "list"]);
	assert.equal(missing.exit, 5);
	assert.equal(JSON.parse(missing.stderr).error.code, "not_found");
});

test("CLI formation handles JSON files, preview, apply and replay", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-cli-formation-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	assert.equal((await invoke(["--state-dir", base, "init", "--name", "fish"])).exit, 0);
	const facts = [
		{ text: "主人喜欢茶", sources: ["user:conversation:tea"], profile_ref: "user:owner", keywords: ["茶"] },
	];
	const factsPath = join(base, "facts.json");
	await writeFile(factsPath, JSON.stringify({ facts }));
	const candidates = await invoke([
		"--state-dir",
		base,
		"memory",
		"candidates",
		"--text-file",
		factsPath,
		"--budget",
		"300",
	]);
	assert.equal(candidates.exit, 0, candidates.stderr);
	assert.deepEqual(JSON.parse(candidates.stdout).data.candidates, []);
	const decisionPath = join(base, "decision.json");
	await writeFile(
		decisionPath,
		JSON.stringify({
			facts,
			decision: { action: "ADD", source_fact_indices: [0], text: "主人喜欢茶", certainty: "user-stated" },
		}),
	);
	const args = [
		"--state-dir",
		base,
		"--request-id",
		"cli-formation-001",
		"memory",
		"decide",
		"--text-file",
		decisionPath,
	];
	const preview = await invoke(args);
	assert.equal(preview.exit, 0, preview.stderr);
	assert.equal(JSON.parse(preview.stdout).data.applied, false);
	const apply = await invoke([...args, "--apply"]);
	assert.equal(apply.exit, 0, apply.stderr);
	const id = JSON.parse(apply.stdout).data.result.id as string;
	assert.match(id, /^mem_/);
	const replay = await invoke([...args, "--apply"]);
	assert.equal(JSON.parse(replay.stdout).data.replayed, true);
	const status = await invoke(["--state-dir", base, "memory", "decision-status", "--request-id", "cli-formation-001"]);
	assert.equal(status.exit, 0, status.stderr);
	assert.equal(JSON.parse(status.stdout).data.result.id, id);
	const recall = await invoke(["--state-dir", base, "memory", "candidates", "--text-file", factsPath]);
	assert.equal(JSON.parse(recall.stdout).data.candidates[0].id, id);
});
