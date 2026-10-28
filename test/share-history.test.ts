import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import { type Receipt, Store } from "../src/store.ts";

test("share history uses receipts, keeps one identity and reports unknown targets", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-share-history-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	await new App({ state_dir: base }).execute("init");
	const store = new Store(base);
	const make = (
		request_id: string,
		status: Receipt["status"],
		bot_id: string,
		target?: Receipt["target"],
	): Receipt => ({
		request_id,
		fingerprint: "fixture",
		operation: "chat.forward",
		status,
		bot_id,
		target,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
	});
	for (const receipt of [
		make("one", "dispatching", "default", { video_id: "123", recipient_id: "secuid:person" }),
		make("two", "confirmed", "default", { video_id: "123", recipient_id: "secuid:person" }),
		make("old", "confirmed", "default"),
		// A receipt from another identity is not this installation's history.
		make("other-request", "confirmed", "other", { video_id: "123", recipient_id: "secuid:person" }),
	])
		await store.saveReceipt(receipt);
	const selected = new App({ state_dir: base });
	await assert.rejects(selected.execute("receipt.get", { request_id: "other-request" }), { code: "not_found" });
	const result = (await selected.execute("share.history", { video_id: "123" })) as {
		items: Receipt[];
		total_matched: number;
		unknown_target_excluded: number;
		complete: boolean;
	};
	assert.equal(result.total_matched, 2);
	assert.equal(result.unknown_target_excluded, 1);
	assert.equal(result.complete, false);
	assert.deepEqual(result.items.map((item) => item.status).sort(), ["confirmed", "dispatching"]);
	assert.ok(result.items.every((item) => item.bot_id === "default"));
	const all = (await selected.execute("share.history")) as { items: Receipt[] };
	assert.equal(all.items.length, 3);
	assert.ok(all.items.some((item) => item.request_id === "old" && !item.target));
	const growth = (await selected.execute("growth.review")) as {
		share_receipts: (Receipt & { source: string })[];
		events: unknown[];
	};
	assert.equal(growth.events.length, 0);
	assert.equal(growth.share_receipts.length, 3);
	assert.ok(
		growth.share_receipts.some((item) => item.source === "receipt:default:one" && item.status === "dispatching"),
	);
	assert.ok(growth.share_receipts.every((item) => item.bot_id === "default"));
});
