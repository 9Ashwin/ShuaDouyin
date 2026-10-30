import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

// The version sat at 0.1.0 for fifty-one commits, and the skill advertised that
// as normal — "the version number never changes, use the commit instead". That
// made the field decorative. It now moves when a capability layer lands, and the
// commit is what answers "am I current": a version alone cannot tell a copy
// twenty commits behind from one a single commit behind.

test("the version is a semver with a non-zero minor", async () => {
	const data = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	};
	assert.match(data.version, /^\d+\.\d+\.\d+$/);
	const [, minor] = data.version.split(".").map(Number);
	// 0.0.x would mean nothing has landed. This project has three capability
	// layers: reading, growth and social.
	assert.ok(Number(minor) >= 3, `expected at least 0.3.0, found ${data.version}`);
});

test("dy reports the same version its package does", async () => {
	const data = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as {
		version: string;
	};
	const { stdout } = await run("node", ["dist/cli.js", "--version"]);
	assert.equal(stdout.trim(), data.version);
});

test("update reports the version alongside the commit, because they answer different questions", async () => {
	const { stdout } = await run("node", ["dist/cli.js", "update"]);
	const report = JSON.parse(stdout).data as { version?: string; head?: string };
	assert.ok(report.version, "a copy must be able to say which version it is");
	assert.ok("head" in report, "and which commit, which is what decides if it is current");
});
