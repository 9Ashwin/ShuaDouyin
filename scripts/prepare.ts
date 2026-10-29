import { execFileSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";

// `npm install -g github:...` installs the source, then runs `prepare` with
// devDependencies present. Nothing else builds it: a `prepare` that only
// installed hooks produced a package with no dist/ and no `dy` binary, so the
// install reported success and the command did not exist. Building here is
// therefore the whole point, and a build failure has to fail the install rather
// than leave a broken one behind.
//
// This package ships from GitHub, not the npm registry, so `prepare` is the
// only build step an installing user ever runs.

function run(command: string, args: string[]): void {
	execFileSync(command, args, { stdio: "inherit" });
}

// An installed copy has no .git, so the only way it can say which commit it is
// is by writing that down before the checkout goes away. Without this, `dy
// update --check` could fetch the newest commit and still not know whether this
// copy was older — the comparison had one side missing.
function commit(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

const head = commit();
if (head) writeFileSync(".dy-build-commit", head, "utf8");

run(process.execPath, ["scripts/build.ts"]);

// Hook installation is a convenience for a working checkout, not something an
// installed package needs, and it must not decide whether the install succeeds.
if (existsSync(".husky")) {
	try {
		run("husky", []);
	} catch {
		// husky is a devDependency: `--ignore-scripts` installs and machines
		// without it should still get a working dy.
	}
}
