import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { atomicCreate, atomicWrite, Store } from "../src/store.ts";

test("file publication preserves an existing or changed destination", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-atomic-write-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const path = join(directory, "document.md");
	await writeFile(path, "external edit");
	await assert.rejects(atomicCreate(path, "new file"), { code: "EEXIST" });
	await assert.rejects(atomicWrite(path, "new version", "old version"), { code: "revision_conflict" });
	assert.equal(await readFile(path, "utf8"), "external edit");
});

test("profile lock excludes overlapping operations and releases after failure", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-store-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const first = new Store(directory);
	const second = new Store(directory);
	await first.withLock(async () => {
		await assert.rejects(
			second.withLock(async () => undefined),
			{ code: "busy" },
		);
		await first.append("example", { value: 1 });
	});
	await assert.rejects(
		first.withLock(async () => {
			throw new Error("operation failed");
		}),
		/operation failed/,
	);
	await second.withLock(async () => {
		await second.append("example", { value: 2 });
	});
	assert.deepEqual(
		(await first.events()).map((event) => event.data),
		[{ value: 1 }, { value: 2 }],
	);
	if (process.platform !== "win32") assert.equal((await stat(first.path("history.jsonl"))).mode & 0o777, 0o600);
});

test("corrupt state and history are retained and reported", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-corrupt-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new Store(directory);
	await store.withLock(async () => {
		await writeFile(store.path("config.json"), "{broken");
		await assert.rejects(store.config(), { code: "state_corrupt" });
		assert.equal(await readFile(store.path("config.json"), "utf8"), "{broken");
		await writeFile(store.path("history.jsonl"), "{broken}\n");
		await assert.rejects(store.events(), { code: "state_corrupt" });
	});
});

test("the state root cannot be a file or a symlink", async () => {
	const directory = await mkdtemp(join(tmpdir(), "dy-store-"));
	try {
		const file = join(directory, "not-a-directory");
		await writeFile(file, "{}", "utf8");
		assert.throws(() => new Store(file), { code: "state_corrupt" });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
