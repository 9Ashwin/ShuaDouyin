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

// esbuild is a dependency, but its platform binary arrives through that
// package's own install script. A machine or a config that skips lifecycle
// scripts — this repository's own .npmrc sets ignore-scripts, and some users set
// it globally — gets the package without the binary, and the build then fails with
// "Cannot find package 'esbuild'", which says nothing about the real cause. The
// install is what a person sees when something goes wrong, so it says what to do.
try {
	run(process.execPath, ["scripts/build.ts"]);
} catch {
	throw new Error(
		[
			"Building dy failed.",
			"",
			"Most often this is esbuild's platform binary being skipped: npm ran the install",
			"with lifecycle scripts disabled, so the package is present but unusable.",
			"",
			"Fix it with either:",
			"  npm install -g github:9Ashwin/ShuaDouyin --ignore-scripts=false",
			"  npm config set ignore-scripts false   # if it is set globally",
			"",
			"The build output above is the full error.",
		].join("\n"),
	);
}

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
