import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sourceCheckout } from "../src/operations/source.ts";

test("source reports the checkout behind this module, not the caller's cwd", () => {
	const result = sourceCheckout();
	assert.equal(result.managed, true);
	// The directory is whatever the person cloned into; asserting the repository
	// name made this test fail for every checkout not named after the project,
	// which is most of them.
	assert.ok(result.path);
	assert.equal(existsSync(join(result.path, "package.json")), true);
	assert.equal(existsSync(join(result.path, "src", "cli.ts")), true);
	// The entry path is separated by the platform's own separator.
	assert.ok(result.entry.includes(join("operations", "source")));
	assert.equal(typeof result.dirty, "boolean");
});

test("source refuses a directory that is not a ShuaDouyin checkout", async (t) => {
	const empty = await mkdtemp(join(tmpdir(), "dy-source-"));
	t.after(() => rm(empty, { recursive: true, force: true }));
	const result = sourceCheckout(empty);
	assert.equal(result.path, null);
	assert.equal(result.managed, false);
	assert.match(result.error ?? "", /no source checkout/);
});
