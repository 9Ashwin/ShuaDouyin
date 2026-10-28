import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { Store } from "../src/store.ts";

const message = (id: string | null, text: string) => ({
	id,
	text,
	kind: "text",
	direction: "incoming",
	timestamp: null,
});
test("history preserves anonymous windows, keeps one identity and paginates a stable snapshot", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-chat-history-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const conv = "native:123";
	const first = await store.withLock(() =>
		store.append("chat.read", {
			id: conv,
			messages: [message(null, "好的"), message(null, "好的"), message("stable", "旧内容")],
		}),
	);
	await store.withLock(() =>
		store.append("chat.read", {
			id: conv,
			messages: [message(null, "好的"), message(null, "好的"), message("stable", "旧内容")],
		}),
	);
	await store.withLock(() =>
		store.append("chat.read", { id: conv, messages: [message(null, "新的话"), message("stable", "修正内容")] }),
	);
	// A record attributed to another identity is not this installation's window.
	await store.withLock(async () => {
		await store.write("placeholder.json", {});
		await appendFile(
			store.path("history.jsonl"),
			`${JSON.stringify({
				id: "00000000-0000-4000-8000-000000000001",
				at: "2026-01-01T00:00:00.000Z",
				operation: "chat.read",
				bot_id: "other",
				data: { id: conv, messages: [message(null, "OTHER-IDENTITY-PRIVATE")] },
			})}\n`,
		);
	});
	await store.withLock(() =>
		store.append("chat.read", { id: "native:other", messages: [message(null, "OTHER-CONVERSATION")] }),
	);
	const app = new App({ state_dir: base });
	const result = (await app.execute("chat.history", { conversation_id: conv, limit: 20 })) as {
		total_observations: number;
		known_messages: { id: string; observed_fields_changed: boolean }[];
		unidentified_windows: { observations: number; messages: { text: string }[]; sources: string[] }[];
	};
	assert.equal(result.total_observations, 3);
	assert.equal(result.known_messages[0].id, "stable");
	assert.equal(result.known_messages[0].observed_fields_changed, true);
	const repeated = result.unidentified_windows.find((window) => window.observations === 2);
	assert.deepEqual(
		repeated?.messages.slice(0, 2).map((item) => item.text),
		["好的", "好的"],
	);
	assert.ok(repeated?.sources.includes(`event:default:${first.id}`));
	assert.equal(JSON.stringify(result).includes("OTHER-IDENTITY-PRIVATE"), false);
	assert.equal(JSON.stringify(result).includes("OTHER-CONVERSATION"), false);
	const page = (await app.execute("chat.history", { conversation_id: conv, limit: 1 })) as {
		revision: string;
		next_offset: number;
		total_observations: number;
	};
	assert.equal(page.next_offset, 1);
	await assert.rejects(app.execute("chat.history", { conversation_id: conv, limit: 1, offset: 1 }), {
		code: "revision_required",
	});
	const older = (await app.execute("chat.history", {
		conversation_id: conv,
		limit: 1,
		offset: 1,
		if_match: page.revision,
	})) as { page_observations: number };
	assert.equal(older.page_observations, 1);
	await store.withLock(() => store.append("chat.read", { id: conv, messages: [message(null, "后来")] }));
	await assert.rejects(app.execute("chat.history", { conversation_id: conv, offset: 1, if_match: page.revision }), {
		code: "revision_conflict",
	});
});

test("history removes media URLs and signals ambiguous IDs and bounded text", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-chat-history-media-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	await store.withLock(() =>
		store.append("chat.read", {
			id: "native:123",
			messages: [
				message("duplicate", "x"),
				message("duplicate", "y"),
				{
					id: null,
					text: "长".repeat(2000),
					kind: "image",
					image: { images: [{ src: "https://cdn.example/?token=SECRET" }] },
				},
			],
		}),
	);
	const result = (await new App({ state_dir: base }).execute("chat.history", {
		conversation_id: "native:123",
		budget: 500,
	})) as {
		ambiguous_id_count_in_page: number;
		known_messages: unknown[];
		unidentified_windows: { messages: { text_truncated: boolean }[] }[];
	};
	assert.equal(result.ambiguous_id_count_in_page, 1);
	assert.equal(result.known_messages.length, 0);
	assert.equal(result.unidentified_windows[0].messages[2].text_truncated, true);
	assert.equal(JSON.stringify(result).includes("SECRET"), false);
});
