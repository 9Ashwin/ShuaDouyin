import { execFileSync } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { build } from "esbuild";

// An installed copy has no .git, so the commit this build came from is written
// beside it. `dy update` compares that with the repository; without it one side
// of the comparison is missing. Written here as well as in prepare, because a
// working checkout builds with `pnpm build` and never runs prepare.
function head(): string | null {
	try {
		return execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
	} catch {
		return null;
	}
}

const commit = head();
if (commit) await writeFile(".dy-build-commit", commit, "utf8");

await mkdir("dist", { recursive: true });
await build({
	entryPoints: ["src/page/index.ts"],
	bundle: true,
	format: "iife",
	globalName: "DouyinPage",
	target: "chrome120",
	outfile: "dist/page-adapter.js",
});
execFileSync(process.execPath, ["node_modules/typescript/bin/tsc", "-p", "tsconfig.build.json"], { stdio: "inherit" });
await chmod("dist/cli.js", 0o755);
