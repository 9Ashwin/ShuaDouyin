import assert from "node:assert/strict";
import test from "node:test";
import type { Session, Snapshot } from "../src/browser.ts";
import { waitSearchResults, waitSnapshot } from "../src/operations/navigation.ts";

test("waitSnapshot tolerates a navigation context replacement without hiding other failures", async () => {
	let count = 0;
	const state = { page_kind: "note", login_required: false, verification_required: false } as Snapshot;
	const session = {
		status: async () => {
			if (!count++) throw new Error("page.evaluate: Execution context was destroyed");
			return state;
		},
	} as unknown as Session;
	assert.equal(await waitSnapshot(session, (value) => value.page_kind === "note", AbortSignal.timeout(3000)), state);
	const broken = {
		status: async () => {
			throw new Error("different browser failure");
		},
	} as unknown as Session;
	await assert.rejects(
		waitSnapshot(broken, () => true, AbortSignal.timeout(3000)),
		/different browser failure/,
	);
});

test("search waits for delayed cards and rejects a changed query", async () => {
	let reads = 0;
	const session = {
		status: async () => ({ url: "https://www.douyin.com/search/%E6%97%85%E8%A1%8C", page_kind: "search" }),
		call: async () => (++reads === 1 ? [] : [{ id: "123" }]),
	} as unknown as Session;
	await waitSearchResults(session, "旅行", AbortSignal.timeout(2000));
	assert.equal(reads, 2);
	await assert.rejects(waitSearchResults(session, "其他", AbortSignal.timeout(2000)), { code: "identity_mismatch" });
	await assert.rejects(waitSearchResults(session, "旅行", AbortSignal.timeout(2000), "search.users"), {
		code: "identity_mismatch",
	});
	let checks = 0;
	const changed = {
		status: async () => ({
			url: checks++ ? "https://www.douyin.com/search/other" : "https://www.douyin.com/search/%E6%97%85%E8%A1%8C",
			page_kind: "search",
		}),
		call: async () => [{ id: "123" }],
	} as unknown as Session;
	await assert.rejects(waitSearchResults(changed, "旅行", AbortSignal.timeout(2000)), { code: "identity_mismatch" });
});
