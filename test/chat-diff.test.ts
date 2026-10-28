import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { compareChatWindows } from "../src/operations/chat-diff.ts";
import { type Event, Store } from "../src/store.ts";

function snapshot(id: string, messages: unknown[], conversation = "native:123"): Event {
	return { id, at: "2026-01-01T00:00:00.000Z", operation: "chat.read", data: { id: conversation, messages } };
}

test("compare loaded chat windows without claiming delivery or deletion", () => {
	const events = [
		snapshot("one", [{ id: "1", text: "old" }, { id: "2", text: "changed" }, { id: null }]),
		snapshot("other", [{ id: "9" }], "native:other"),
		snapshot("two", [
			{ id: "2", text: "updated" },
			{ id: "3", text: "visible" },
		]),
	];
	const result = compareChatWindows(events, "native:123");
	assert.deepEqual(result.only_before, ["1"]);
	assert.deepEqual(result.only_after, ["3"]);
	assert.deepEqual(result.changed, ["2"]);
	assert.equal(result.before.missing_ids, 1);
	assert.equal(result.complete, false);
	assert.equal(result.before.event_id, "one");
	assert.throws(() => compareChatWindows(events, "native:missing"), { code: "not_found" });
});

test("duplicate message IDs cannot be presented as additions or removals", () => {
	const result = compareChatWindows(
		[snapshot("one", [{ id: "1" }, { id: "1" }]), snapshot("two", [{ id: "1" }, { id: "2" }])],
		"native:123",
	);
	assert.deepEqual(result.only_before, []);
	assert.deepEqual(result.only_after, []);
	assert.equal(result.before.duplicate_ids, 1);
});

test("chat changes uses only the saved windows of this installation", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-chat-diff-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	await store.append("chat.read", { id: "native:123", messages: [{ id: "1" }] });
	// A window attributed to another identity must not enter the comparison.
	await store.withLock(async () => {
		await store.write("placeholder.json", {});
		await appendFile(
			store.path("history.jsonl"),
			`${JSON.stringify({
				id: "00000000-0000-4000-8000-000000000001",
				at: "2026-01-01T00:00:00.000Z",
				operation: "chat.read",
				bot_id: "other",
				data: { id: "native:123", messages: [{ id: "private" }] },
			})}\n`,
		);
	});
	await store.append("chat.read", { id: "native:123", messages: [{ id: "2" }] });
	const result = (await new App({ state_dir: base }).execute("chat.changes", {
		conversation_id: "native:123",
	})) as { only_before: string[]; only_after: string[] };
	assert.deepEqual(result.only_before, ["1"]);
	assert.deepEqual(result.only_after, ["2"]);
});
