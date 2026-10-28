import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../src/browser.ts";
import { inspectCreator } from "../src/operations/creator.ts";

test("creator inspection closes the temporary page and reports its limits", async () => {
	let closed = false;
	const page = {
		route: async () => {},
		goto: async () => {},
		locator: () => ({ first: () => ({ waitFor: async () => {} }) }),
		url: () => "https://creator.douyin.com/creator-micro/content/upload",
		evaluate: async () => ({ login_required: false, video_upload_control: true, image_tab_present: true }),
		close: async () => {
			closed = true;
		},
	};
	const session = { browser: { contexts: () => [{ newPage: async () => page }] } } as unknown as Session;
	const result = await inspectCreator(session, AbortSignal.timeout(2000));
	assert.equal(result.video_upload_control, true);
	assert.equal(result.account_verified, false);
	assert.equal(result.existing_drafts_inspected, false);
	assert.equal(closed, true);
	page.url = () => "https://example.com/";
	closed = false;
	await assert.rejects(inspectCreator(session, AbortSignal.timeout(2000)), { code: "identity_mismatch" });
	assert.equal(closed, true);
});
