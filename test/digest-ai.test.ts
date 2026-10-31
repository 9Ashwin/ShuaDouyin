import assert from "node:assert/strict";
import test from "node:test";
import type { Session } from "../src/browser.ts";
import { AI_SUMMARY_LIMITS } from "../src/operations/ai-summary.ts";
import { digest } from "../src/operations/digest.ts";

// --ai puts the platform's description next to the frames.
//
// The two are different evidence and must stay in different fields. Merging them
// — a summary inside the frame list, or a frame described as a summary — would
// make the distinction invisible at the point a caller reads it, which is the
// only place it matters.

const snapshot = {
	url: "https://www.douyin.com/video/12345",
	title: "fixture",
	page_kind: "video",
	unsupported_page: false,
	login_required: false,
	verification_required: false,
	private_chat_visible: false,
	video_selection: { candidates: 1, ambiguous: false },
	slide: { kind: "video", id: "12345" },
	search_results: [],
	note: null,
	video: {
		id: "12345",
		url: "https://www.douyin.com/video/12345",
		title: "fixture",
		author: "",
		author_id: null,
		time: 0,
		duration: 100,
		paused: false,
		muted: true,
		ready_state: 4,
		viewport_intersects: true,
	},
};

function session(): Session {
	return {
		call: async (operation: string) => {
			if (operation === "video.info") return snapshot;
			if (operation === "comment.list") return [];
			if (operation === "ai.entry.point") return { x: 1, y: 2 };
			if (operation === "ai.summary") return { complete: true, summary: "平台说这条在唱歌。", why: "" };
			return null;
		},
		tab: {
			mouse: { click: async () => undefined },
			screenshot: async () => Buffer.from("png"),
			evaluate: async () => undefined,
		},
	} as unknown as Session;
}

const store = { path: (name: string) => `/tmp/dy-digest-ai/${name}` };

test("without --ai the platform summary is absent, not empty", async () => {
	// An empty field would be read as "the platform had nothing to say".
	const result = (await digest(session(), store, { frames: 0 }, AbortSignal.timeout(5000))) as Record<string, unknown>;
	assert.equal(Object.hasOwn(result, "platform_summary"), false);
});

test("with --ai the summary arrives in its own field, beside the frames", async () => {
	const result = (await digest(session(), store, { frames: 0, ai: true }, AbortSignal.timeout(5000))) as {
		platform_summary?: { summary: string; complete: boolean };
		frames: unknown[];
		limitations: string[];
	};
	assert.equal(result.platform_summary?.summary, "平台说这条在唱歌。");
	assert.equal(result.platform_summary?.complete, true);
	assert.deepEqual(result.frames, [], "the summary is not a frame");
	// The distinction travels with the result, not only with the docs.
	assert.ok(result.limitations.some((line) => /not observed by this tool/.test(line)));
});

test("the AI limits say what the summary is not", () => {
	assert.ok(AI_SUMMARY_LIMITS.some((line) => /not observed by this tool/.test(line)));
	assert.ok(AI_SUMMARY_LIMITS.some((line) => /complete:false/.test(line)));
});
