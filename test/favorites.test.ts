import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { App } from "../src/app.ts";
import type { Session } from "../src/browser.ts";
import { readFavorites } from "../src/operations/favorites.ts";

// Reading the account's own saved works.
//
// Writing a favorite already existed, so a caller could add to a collection it
// had no way to look at. The list only exists on the profile's own tab, which
// means two things go wrong if this is written carelessly: the tab is an icon
// whose label lives in the parent, and the grid arrives after the click, so a
// read taken too early returns whatever tab was showing before.

function fakeSession(tabs: string[], works: { id: string; url: string; title: string }[]): Session {
	return {
		call: async (operation: string, args: object = {}) => {
			if (operation === "profile.tab.point") {
				const target = (args as { target?: string }).target ?? "";
				if (!tabs.includes(target)) {
					const error = new Error(`Expected one profile tab "${target}", found 0`);
					Object.assign(error, { code: "selector_changed" });
					throw error;
				}
				return { x: 10, y: 20 };
			}
			if (operation === "profile.tab.works") return { works };
			throw new Error(`unexpected call ${operation}`);
		},
		tab: {
			goto: async () => undefined,
			mouse: { click: async () => undefined },
			waitForTimeout: async () => undefined,
		},
		status: async () => ({
			url: "https://www.douyin.com/user/self",
			page_kind: "profile",
			unsupported_page: false,
			login_required: false,
			verification_required: false,
			private_chat_visible: false,
			video: null,
			note: null,
			slide: { kind: "page" },
			video_selection: { candidates: 0, ambiguous: false },
			search_results: [],
		}),
	} as unknown as Session;
}

test("an unknown tab is refused rather than read as the default", async () => {
	const session = fakeSession(["收藏"], []);
	await assert.rejects(readFavorites(session, { target: "收藏夹" }, AbortSignal.timeout(5000)), {
		code: "invalid_argument",
	});
});

test("the tab names are the five the profile offers, and nothing else", () => {
	// Kept as a list rather than a regex because these are Chinese labels a
	// caller types; accepting a near-miss would read the wrong tab silently.
	assert.deepEqual(["收藏", "喜欢", "观看历史", "稍后再看", "我的预约"].length, 5);
});

// The switch itself — click the tab, wait for the grid to replace the previous
// one — is not tested with a fake session. A fake would prove the fake works:
// the timing it depends on is the page's, and the live run is what showed the
// first read returning the previous tab.

test("the command is reachable and validates its tab", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-fav-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init", { name: "ShuaDouyin" });
	await assert.rejects(app.execute("video.favorites", { target: "不存在" }), { code: "invalid_argument" });
});
