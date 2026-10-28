import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";

const skip = process.platform === "win32";
const installer = resolve("scripts/install.sh");

async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
	const root = await mkdtemp(join(tmpdir(), "dy-install-test-"));
	t.after(() => rm(root, { recursive: true, force: true }));
	const tools = join(root, "tools");
	const source = join(root, "source");
	const packageDir = join(root, "package");
	await mkdir(tools);
	await mkdir(source);
	await mkdir(join(packageDir, "skills", "dy"), { recursive: true });
	await writeFile(join(packageDir, "package.json"), "{}\n");
	await writeFile(join(packageDir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
	await writeFile(join(packageDir, "skills", "dy", "SKILL.md"), "growth");
	const archive = join(root, "fixture.tar");
	execFileSync("tar", ["-cf", archive, "-C", packageDir, "."]);
	const commands: Record<string, string> = {
		node: `#!/bin/sh
if [ "\${DY_TEST_OLD_NODE:-0}" = 1 ] && [ "$0" = "$DY_TEST_HOST_NODE" ]; then exit 1; fi
if [ "$1" = -p ]; then printf '%s\\n' "$0"; exit 0; fi
if [ "$1" = -e ]; then
  case "$2" in *renameSync*) exec "$DY_TEST_REAL_NODE" "$@" ;; *) exit 0 ;; esac
fi
shift
case "$*" in
  *--version*) printf '0.1.0\\n' ;;
  *"memory status"*) printf '{"ok":true,"data":{"healthy":true}}\\n' ;;
  *guide*) printf '{"ok":true,"data":{"markdown":"growth"}}\\n' ;;
  *) printf '{"ok":true,"data":{}}\\n' ;;
esac
`,
		pnpm: `#!/bin/sh
if [ "$1" = --version ]; then printf '10.34.7\\n'; exit 0; fi
if [ "\${DY_TEST_FAIL:-0}" = 1 ]; then exit 72; fi
if [ -n "\${DY_TEST_GATE:-}" ] && [ "$1" = install ]; then
  : > "$DY_TEST_GATE.ready"
  while [ ! -e "$DY_TEST_GATE" ]; do sleep 0.05; done
fi
if [ "$1" = build ]; then mkdir -p dist; printf 'fixture\\n' > dist/cli.js; fi
`,
		git: `#!/bin/sh
case "$*" in *rev-parse*) printf 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\\n'; exit 0 ;; esac
case "$*" in *status*) exit 0 ;; esac
for arg in "$@"; do case "$arg" in --output=*) cp "$DY_TEST_ARCHIVE" "\${arg#--output=}"; exit 0 ;; esac; done
exit 1
`,
	};
	for (const [name, content] of Object.entries(commands)) {
		const path = join(tools, name);
		await writeFile(path, content);
		await chmod(path, 0o755);
	}
	const install = join(root, "install's files");
	const bin = join(root, "bin's tools");
	const skills = join(root, "agent skills");
	const environment = {
		...process.env,
		PATH: `${tools}:${process.env.PATH ?? ""}`,
		DY_TEST_ARCHIVE: archive,
		DY_TEST_REAL_NODE: process.execPath,
		DY_TEST_HOST_NODE: join(tools, "node"),
		DY_INSTALL_HOME: install,
		DY_BIN_DIR: bin,
		DY_SKILLS_DIR: skills,
	};
	const run = (args: string[], extra: Record<string, string> = {}) =>
		spawnSync("sh", [installer, ...args], { env: { ...environment, ...extra }, encoding: "utf8" });
	return { root, install, bin, skills, source, tools, run, environment };
}

test("installer preserves the previous version on failure and uninstall preserves user state", { skip }, async (t) => {
	const f = await fixture(t);
	const state = join(f.root, "user-state");
	await mkdir(state);
	await writeFile(join(state, "keep"), "user data");
	const first = f.run(["--source", f.source]);
	assert.equal(first.status, 0, first.stderr);
	const launcher = join(f.bin, "dy");
	const version = spawnSync(launcher, ["--version"], { encoding: "utf8" });
	assert.equal(version.status, 0, version.stderr);
	assert.equal(version.stdout.trim(), "0.1.0");
	const skill = join(f.skills, "dy");
	const firstSkill = await readlink(skill);
	const firstCurrent = await readlink(join(f.install, "current"));
	const firstLauncher = await readFile(launcher, "utf8");
	const failed = f.run(["--source", f.source], { DY_TEST_FAIL: "1" });
	assert.notEqual(failed.status, 0);
	assert.equal(await readFile(launcher, "utf8"), firstLauncher);
	assert.equal(await readlink(skill), firstSkill);
	assert.equal(await readlink(join(f.install, "current")), firstCurrent);
	assert.ok((await readdir(join(f.install, "releases"))).every((name) => !name.startsWith(".stage.")));
	const upgrade = f.run(["--source", f.source]);
	assert.equal(upgrade.status, 0, upgrade.stderr);
	assert.equal(await readlink(skill), firstSkill);
	assert.notEqual(await readlink(join(f.install, "current")), firstCurrent);
	assert.equal(await readFile(launcher, "utf8"), firstLauncher);
	const uninstall = f.run(["--uninstall"]);
	assert.equal(uninstall.status, 0, uninstall.stderr);
	assert.equal(await readFile(join(state, "keep"), "utf8"), "user data");
	await assert.rejects(readFile(launcher), { code: "ENOENT" });
	await assert.rejects(readlink(skill), { code: "ENOENT" });
	assert.equal(f.run(["--uninstall"]).status, 0);
});

test("installer refuses foreign commands and preserves a custom skill", { skip }, async (t) => {
	const f = await fixture(t);
	await mkdir(f.bin, { recursive: true });
	await writeFile(join(f.bin, "dy"), "foreign command");
	const conflict = f.run(["--source", f.source]);
	assert.notEqual(conflict.status, 0);
	assert.equal(await readFile(join(f.bin, "dy"), "utf8"), "foreign command");
	await rm(join(f.bin, "dy"));
	const custom = join(f.root, "custom-skill");
	await mkdir(custom);
	await mkdir(f.skills);
	await symlink(custom, join(f.skills, "dy"));
	const installed = f.run(["--source", f.source]);
	assert.equal(installed.status, 0, installed.stderr);
	assert.equal(await readlink(join(f.skills, "dy")), custom);
	assert.equal(f.run(["--uninstall"]).status, 0);
	assert.equal(await readlink(join(f.skills, "dy")), custom);
});

test("installer refuses state overlap and symlink ownership markers", { skip }, async (t) => {
	const f = await fixture(t);
	await mkdir(join(f.install, "cache"), { recursive: true });
	await writeFile(join(f.install, "cache", "keep"), "user data");
	await writeFile(join(f.install, ".dy-installer-owner"), "ShuaDouyin installer v1\n");
	const overlap = f.run(["--uninstall"], { DY_STATE_DIR: f.install });
	assert.notEqual(overlap.status, 0);
	assert.equal(await readFile(join(f.install, "cache", "keep"), "utf8"), "user data");
	await rm(join(f.install, ".dy-installer-owner"));
	const marker = join(f.root, "external-marker");
	await writeFile(marker, "ShuaDouyin installer v1\n");
	await symlink(marker, join(f.install, ".dy-installer-owner"));
	assert.notEqual(f.run(["--source", f.source]).status, 0);
	assert.equal(await readFile(join(f.install, "cache", "keep"), "utf8"), "user data");
});

test("an unrelated skill path with traversal is never treated as managed", { skip }, async (t) => {
	const f = await fixture(t);
	await mkdir(f.skills);
	const custom = `${f.install}/releases/../../custom/app/skills/dy`;
	await symlink(custom, join(f.skills, "dy"));
	assert.equal(f.run(["--source", f.source]).status, 0);
	assert.equal(await readlink(join(f.skills, "dy")), custom);
	assert.equal(f.run(["--uninstall"]).status, 0);
	assert.equal(await readlink(join(f.skills, "dy")), custom);
});

test("disabling skill installation does not require a usable skill directory", { skip }, async (t) => {
	const f = await fixture(t);
	const file = join(f.root, "not-a-directory");
	await writeFile(file, "keep");
	const settings = { DY_INSTALL_SKILL: "0", DY_SKILLS_DIR: join(file, "skills") };
	assert.equal(f.run(["--source", f.source], settings).status, 0);
	assert.equal(f.run(["--uninstall"], settings).status, 0);
	assert.equal(await readFile(file, "utf8"), "keep");
});

test("uninstall cannot race a running installation", { skip, timeout: 20000 }, async (t) => {
	const f = await fixture(t);
	const gate = join(f.root, "continue");
	const child = spawn("sh", [installer, "--source", f.source], {
		env: { ...f.environment, DY_TEST_GATE: gate },
		stdio: "ignore",
	});
	const finished = new Promise<number | null>((resolve) => child.once("exit", resolve));
	try {
		let ready = false;
		for (let index = 0; index < 100; index++) {
			try {
				await access(`${gate}.ready`);
				ready = true;
				break;
			} catch {
				await delay(50);
			}
		}
		assert.equal(ready, true);
		assert.notEqual(f.run(["--uninstall"]).status, 0);
	} finally {
		await writeFile(gate, "continue");
	}
	assert.equal(await finished, 0);
	assert.equal(spawnSync(join(f.bin, "dy"), ["--version"], { encoding: "utf8" }).status, 0);
});

test("uninstall with skill management disabled retains the skill target", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const skill = join(f.skills, "dy");
	const target = await readlink(skill);
	assert.equal(f.run(["--uninstall"], { DY_INSTALL_SKILL: "0" }).status, 0);
	assert.equal(await readlink(skill), target);
	await access(target);
});

test("installer rejects PATH shadowing of a different dy", { skip }, async (t) => {
	const f = await fixture(t);
	const foreignDir = join(f.root, "foreign-bin");
	await mkdir(f.bin);
	await mkdir(foreignDir);
	const foreign = join(foreignDir, "dy");
	await writeFile(foreign, "#!/bin/sh\nprintf foreign\\n\n");
	await chmod(foreign, 0o755);
	const tools = f.environment.PATH.split(":")[0];
	const binAlias = join(f.root, "bin-alias");
	await symlink(f.bin, binAlias);
	for (const pathEntry of [f.bin, `${f.bin}/`, binAlias]) {
		const result = f.run(["--source", f.source], {
			PATH: `${tools}:${pathEntry}:${foreignDir}:${process.env.PATH ?? ""}`,
		});
		assert.notEqual(result.status, 0);
		assert.match(result.stderr, /shadow/);
	}
	assert.match(await readFile(foreign, "utf8"), /foreign/);
	await assert.rejects(access(join(f.bin, "dy")), { code: "ENOENT" });
});

test("uninstall preserves an external release directory reached through a symlink", { skip }, async (t) => {
	const f = await fixture(t);
	await mkdir(f.install);
	await writeFile(join(f.install, ".dy-installer-owner"), "ShuaDouyin installer v1\n");
	const external = join(f.root, "external");
	const release = join(external, "release");
	await mkdir(release, { recursive: true });
	await writeFile(join(release, ".dy-release-owner"), "ShuaDouyin release v1\n");
	await writeFile(join(release, "keep"), "user data");
	await symlink(external, join(f.install, "releases"));
	assert.equal(f.run(["--uninstall"]).status, 0);
	assert.equal(await readFile(join(release, "keep"), "utf8"), "user data");
});

test("uninstall preserves a release used by an unmanaged relative skill link", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const skill = join(f.skills, "dy");
	const target = await readlink(skill);
	await rm(skill);
	await symlink(relative(f.skills, target), skill);
	assert.equal(f.run(["--uninstall"]).status, 0);
	await access(skill);
	await access(target);
});

test("installer bootstraps a checksum-verified isolated Node runtime", { skip }, async (t) => {
	const f = await fixture(t);
	const platform = process.platform === "darwin" ? "darwin" : "linux";
	const arch = process.arch === "arm64" ? "arm64" : "x64";
	const name = `node-v22.23.1-${platform}-${arch}`;
	const root = join(f.root, "node-archive");
	const bin = join(root, name, "bin");
	await mkdir(bin, { recursive: true });
	await writeFile(join(bin, "node"), await readFile(join(f.tools, "node")));
	await chmod(join(bin, "node"), 0o755);
	const archive = join(f.root, `${name}.tar.gz`);
	execFileSync("tar", ["-czf", archive, "-C", root, name]);
	const digest = createHash("sha256")
		.update(await readFile(archive))
		.digest("hex");
	const checksums = join(f.root, "checksums.txt");
	await writeFile(checksums, `${digest}  ${name}.tar.gz\n`);
	const curl = join(f.tools, "curl");
	await writeFile(
		curl,
		`#!/bin/sh
url= out=
while [ "$#" -gt 0 ]; do
 case "$1" in -o) out=$2; shift 2 ;; https://nodejs.org/*) url=$1; shift ;; *) shift ;; esac
done
case "$url" in */SHASUMS256.txt) cp "$DY_TEST_NODE_SUM" "$out" ;; *.tar.gz) cp "$DY_TEST_NODE_ARCHIVE" "$out" ;; *) exit 1 ;; esac
`,
	);
	await chmod(curl, 0o755);
	const env = { DY_TEST_OLD_NODE: "1", DY_TEST_NODE_ARCHIVE: archive, DY_TEST_NODE_SUM: checksums };
	const result = f.run(["--source", f.source], env);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /isolated Node/);
	const launcher = spawnSync(join(f.bin, "dy"), ["--version"], { env: { ...f.environment, ...env }, encoding: "utf8" });
	assert.equal(launcher.status, 0, launcher.stderr);
	assert.equal(launcher.stdout.trim(), "0.1.0");
	const current = await readlink(join(f.install, "current"));
	await writeFile(checksums, `${"0".repeat(64)}  ${name}.tar.gz\n`);
	const rejected = f.run(["--source", f.source], env);
	assert.notEqual(rejected.status, 0);
	assert.match(rejected.stderr, /checksum mismatch/);
	assert.equal(await readlink(join(f.install, "current")), current);
});

test("a foreign command created at publication is not overwritten", { skip }, async (t) => {
	const f = await fixture(t);
	const target = join(f.bin, "dy");
	const tool = join(f.tools, "ln");
	await writeFile(
		tool,
		`#!/bin/sh
last=
for arg in "$@"; do last=$arg; done
if [ "$last" = "$DY_TEST_RACE_TARGET" ] && [ ! -e "$last" ]; then printf 'foreign data' > "$last"; fi
exec /bin/ln "$@"
`,
	);
	await chmod(tool, 0o755);
	const result = f.run(["--source", f.source], { DY_TEST_RACE_TARGET: target });
	assert.notEqual(result.status, 0);
	assert.equal(await readFile(target, "utf8"), "foreign data");
});

test("post-switch cleanup failure reports success with the new version active", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const previous = await readlink(join(f.install, "current"));
	const rmTool = join(f.tools, "rm");
	await writeFile(
		rmTool,
		`#!/bin/sh
case "$*" in *"/.switch."*"/previous"*) exit 73 ;; esac
exec /bin/rm "$@"
`,
	);
	await chmod(rmTool, 0o755);
	const result = f.run(["--source", f.source]);
	assert.equal(result.status, 0, result.stderr);
	assert.notEqual(await readlink(join(f.install, "current")), previous);
	assert.match(result.stdout, /old pointer remains/);
});

test("uninstall preserves a release path replaced during removal", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const release = await readlink(join(f.install, "current"));
	const mvTool = join(f.tools, "mv");
	await writeFile(
		mvTool,
		`#!/bin/sh
if [ "$1" = "$DY_TEST_RELEASE_TARGET" ] && [ ! -e "$DY_TEST_RELEASE_TARGET.saved" ]; then
  /bin/mv "$1" "$DY_TEST_RELEASE_TARGET.saved"
  mkdir "$DY_TEST_RELEASE_TARGET"
  printf 'foreign data' > "$DY_TEST_RELEASE_TARGET/keep"
fi
exec /bin/mv "$@"
`,
	);
	await chmod(mvTool, 0o755);
	const result = f.run(["--uninstall"], { DY_TEST_RELEASE_TARGET: release });
	assert.notEqual(result.status, 0);
	const quarantine = (await readdir(f.install)).find((entry) => entry.startsWith(".dy-remove."));
	assert.ok(quarantine);
	assert.equal(await readFile(join(f.install, quarantine, "entry", "keep"), "utf8"), "foreign data");
});

test("interrupted version switch restores the previous pointer", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const previous = await readlink(join(f.install, "current"));
	const mvTool = join(f.tools, "mv");
	await writeFile(
		mvTool,
		`#!/bin/sh
case "$2" in */.switch.*/previous) /bin/mv "$@" || exit; kill -TERM "$PPID"; exit 0 ;; esac
exec /bin/mv "$@"
`,
	);
	await chmod(mvTool, 0o755);
	const result = f.run(["--source", f.source]);
	assert.notEqual(result.status, 0);
	assert.equal(await readlink(join(f.install, "current")), previous);
	assert.equal(spawnSync(join(f.bin, "dy"), ["--version"], { encoding: "utf8" }).status, 0);
	await assert.rejects(access(`${f.install}.lock`), { code: "ENOENT" });
});

test("a preserved switch pointer can be recovered by the next installation", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const previous = await readlink(join(f.install, "current"));
	const interrupted = join(f.install, ".switch.interrupted");
	await mkdir(interrupted);
	await writeFile(join(interrupted, ".dy-switch-owner"), "ShuaDouyin switch v1\n");
	await symlink(previous, join(interrupted, "previous"));
	await rm(join(f.install, "current"));
	const result = f.run(["--source", f.source]);
	assert.equal(result.status, 0, result.stderr);
	assert.match(result.stdout, /Restored the previous version/);
	assert.equal(spawnSync(join(f.bin, "dy"), ["--version"], { encoding: "utf8" }).status, 0);
});

test("interrupted-switch recovery does not follow external directories", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const previous = await readlink(join(f.install, "current"));
	await rm(join(f.install, "current"));
	const outside = join(f.root, "outside");
	await mkdir(outside);
	await writeFile(join(outside, ".dy-switch-owner"), "ShuaDouyin switch v1\n");
	await symlink(previous, join(outside, "previous"));
	await symlink(outside, join(f.install, ".switch.foreign"));
	assert.equal(f.run(["--source", f.source]).status, 0);
	assert.equal(await readlink(join(outside, "previous")), previous);
});

test("download failures in the documented shell pipeline return an error", { skip }, () => {
	const result = spawnSync("bash", ["-o", "pipefail", "-c", "false | sh"], { encoding: "utf8" });
	assert.notEqual(result.status, 0);
});

test("launcher temporary cleanup failure cannot strand installer locks", { skip }, async (t) => {
	const f = await fixture(t);
	assert.equal(f.run(["--source", f.source]).status, 0);
	const previous = await readlink(join(f.install, "current"));
	const rmTool = join(f.tools, "rm");
	await writeFile(
		rmTool,
		`#!/bin/sh
case "$*" in *"/.dy-launcher."*) exit 73 ;; esac
exec /bin/rm "$@"
`,
	);
	await chmod(rmTool, 0o755);
	const result = f.run(["--source", f.source]);
	assert.equal(result.status, 0, result.stderr);
	assert.notEqual(await readlink(join(f.install, "current")), previous);
	assert.match(result.stdout, /temporary launcher remains/);
	await assert.rejects(access(`${f.install}.lock`), { code: "ENOENT" });
	await assert.rejects(access(join(f.bin, ".dy-installer.lock")), { code: "ENOENT" });
});
