import { spawnSync } from "node:child_process";

const result = spawnSync(process.execPath, ["--test", "test/browser.test.ts"], {
	env: { ...process.env, DY_TEST_BROWSER: "1" },
	stdio: "inherit",
});
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
