import { execFileSync } from "node:child_process";
import { chmod, mkdir } from "node:fs/promises";
import { build } from "esbuild";

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
