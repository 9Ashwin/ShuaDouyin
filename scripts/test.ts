import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";

const files = readdirSync("test")
	.filter((file) => file.endsWith(".test.ts"))
	.sort()
	.map((file) => `test/${file}`);
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
