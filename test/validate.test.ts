import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.ts";
import { resourceID, validate } from "../src/operations/validate.ts";

// The boundary contract. This file calls validate() the way the dispatcher does
// and checks the two things a caller can observe: whether the input was accepted
// and what changed in it. It does not test how the checks are ordered, because
// the order is not a contract and pinning it would make every reordering a
// failure.
//
// One rule is worth stating because it is easy to get backwards: a refusal is
// identified by its code, not its message. The messages are written for a person
// and get reworded; `invalid_argument` and `revision_required` are what code
// downstream branches on.

const rejects = (operation: string, input: Record<string, unknown>, code = "invalid_argument") => {
	assert.throws(
		() => validate(operation, input as never),
		(error: unknown) => {
			assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
			assert.equal(error.code, code);
			return true;
		},
	);
};

const accepts = (operation: string, input: Record<string, unknown>) => validate(operation, input as never);

test("request ids are the idempotency key, so a malformed one is refused everywhere", () => {
	// The boundaries themselves are tested, not values comfortably inside them: a
	// check widened from 8 to 6 passes every "obviously wrong" case.
	for (const request_id of ["x".repeat(7), "x".repeat(129), "has space here", "tab\there", "nl\nhere"]) {
		rejects("video.like", { video_id: "12345", request_id });
	}
	assert.equal(accepts("video.like", { video_id: "12345", request_id: "a".repeat(8) }).request_id, "a".repeat(8));
	assert.equal(accepts("video.like", { video_id: "12345", request_id: "a".repeat(128) }).request_id, "a".repeat(128));
});

test("a work URL and a bare id resolve to the same work", () => {
	// `resourceID` is where the rule lives; it used to be exercised through
	// `video open`, which no longer exists. The rule itself is still a contract:
	// every command that takes a work resolves its id this way.
	assert.equal(resourceID("12345", "video"), "12345");
	assert.equal(resourceID("https://www.douyin.com/video/12345", "video"), "12345");
	// An image post is addressed by the same id under a different path.
	assert.equal(resourceID("https://www.douyin.com/note/70001", "video"), "70001");
});

test("a URL that only looks like Douyin is refused", () => {
	// The host check is what stops a lookalike domain from being read as a work,
	// and a credential in the URL is refused rather than stripped.
	assert.throws(() => resourceID("https://douyin.com.evil.example/video/12345", "video"), { code: "invalid_argument" });
	assert.throws(() => resourceID("http://www.douyin.com/video/12345", "video"), { code: "invalid_argument" });
	assert.throws(() => resourceID("https://user:pass@www.douyin.com/video/12345", "video"), {
		code: "invalid_argument",
	});
	assert.throws(() => resourceID("https://www.douyin.com/user/12345", "video"), { code: "invalid_argument" });
	assert.throws(() => resourceID("https://www.douyin.com/video/", "video"), { code: "invalid_argument" });
});

test("the signed-in account may be addressed as self, and nothing else may", () => {
	assert.equal(accepts("user.get", { resource: "self" }).user_id, "self");
	assert.equal(accepts("user.get", { resource: "MS4wLjABAAAAauthor01" }).user_id, "MS4wLjABAAAAauthor01");
	// A work has a numeric id; asking for a work called self is a mistake, not an alias.
	assert.throws(() => resourceID("self", "video"), { code: "invalid_argument" });
});

test("numbers are refused when they are outside the range the page can honour", () => {
	rejects("comment.list", { limit: 0 });
	rejects("comment.list", { limit: 1001 });
	rejects("comment.list", { limit: 1.5 });
	assert.equal(accepts("comment.list", { limit: 1000 }).limit, 1000);
	// A digest may skip sampling entirely; an observe must have at least one frame.
	assert.equal(accepts("video.digest", { frames: 0 }).frames, 0);
	rejects("video.observe", { frames: 0 });
	rejects("video.observe", { steps: 11 });
	rejects("video.digest", { offset: -1 });
});

test("observe fills its own defaults and refuses a window it cannot sample", () => {
	const input = accepts("video.observe", {});
	assert.equal(input.seconds, 3);
	assert.equal(input.frames, 3);
	rejects("video.observe", { seconds: 0.05 });
	rejects("video.observe", { seconds: 301 });
	rejects("video.observe", { seconds: Number.NaN });
	assert.equal(accepts("video.audio", {}).seconds, 8);
	rejects("video.audio", { seconds: 0.5 });
	rejects("video.audio", { seconds: 61 });
});

test("a write needs a request id, but a dry run does not", () => {
	for (const operation of ["comment.post", "chat.send", "chat.share", "chat.reply"]) {
		const base = {
			video_id: "12345",
			conversation_id: "native:30001",
			message_index: 1,
			text: "一句话",
		} as Record<string, unknown>;
		rejects(operation, base);
		assert.equal(accepts(operation, { ...base, dry_run: true }).request_id, undefined);
		assert.equal(accepts(operation, { ...base, request_id: "abcdefgh" }).request_id, "abcdefgh");
	}
});

test("text is required and bounded, and a sticker is a message on its own", () => {
	rejects("comment.post", { video_id: "12345", text: "   ", request_id: "abcdefgh" });
	rejects("comment.post", { video_id: "12345", text: "a".repeat(10001), request_id: "abcdefgh" });
	rejects("comment.post", { video_id: "12345", text: "a\0b", request_id: "abcdefgh" });
	// Putting text beside a sticker would send two messages, one never reviewed.
	rejects("chat.send", { conversation_id: "native:30001", emoji: "比心", text: "附一句", request_id: "abcdefgh" });
	assert.equal(
		accepts("chat.send", { conversation_id: "native:30001", emoji: "比心", request_id: "abcdefgh" }).text,
		undefined,
	);
	rejects("chat.send", { conversation_id: "native:30001", emoji: "", text: "一句话", request_id: "abcdefgh" });
	// A comment has no sticker channel: the platform's emoji is text that happens
	// to be written in brackets, so it is trimmed and passed through as written.
	assert.equal(
		accepts("comment.post", { video_id: "12345", emoji: " [微笑] ", text: "[微笑]", request_id: "abcdefgh" }).emoji,
		"[微笑]",
	);
	rejects("comment.post", { video_id: "12345", emoji: "", text: "[微笑]", request_id: "abcdefgh" });
});

test("a share builds its own text from the work id", () => {
	// The caller cannot supply the URL: a share that sent a caller-authored link
	// would be a way to send arbitrary text under the name of a share.
	const input = accepts("chat.share", {
		video_id: "12345",
		conversation_id: "native:30001",
		text: "https://example.com",
		request_id: "abcdefgh",
	});
	assert.equal(input.text, "https://www.douyin.com/video/12345");
});

test("a chat target must be one the conversation list produced", () => {
	for (const conversation_id of ["好友一", "native:", "", "secuid:"])
		rejects("chat.send", { conversation_id, text: "一句话", request_id: "abcdefgh" });
	// Forwarding names a recipient by account identity, not by a conversation row.
	rejects("chat.forward", { video_id: "12345", recipient_id: "好友一", request_id: "abcdefgh" });
	assert.equal(
		accepts("chat.forward", { video_id: "12345", recipient_id: "secuid:MS4wLjABAAAAshare01", request_id: "abcdefgh" })
			.recipient_id,
		"secuid:MS4wLjABAAAAshare01",
	);
});

test("reading a conversation has its own smaller limits than listing works", () => {
	rejects("chat.read", { conversation_id: "native:30001", limit: 51 });
	assert.equal(accepts("chat.read", { conversation_id: "native:30001", limit: 50 }).limit, 50);
	rejects("chat.read", { conversation_id: "native:30001", scrolls: 21 });
	rejects("chat.read", { conversation_id: "native:30001", pixels: 199 });
	assert.equal(accepts("chat.read", { conversation_id: "native:30001" }).pixels, 1200);
	// A later history page cannot be checked against a revision it was not given.
	rejects("chat.history", { conversation_id: "native:30001", offset: 50 }, "revision_required");
	assert.equal(accepts("chat.history", { conversation_id: "native:30001", offset: 50, if_match: "rev-1" }).offset, 50);
});

test("chat.reply addresses a message by its position, which must be a position", () => {
	for (const message_index of [0, -1, 1.5, undefined])
		rejects("chat.reply", { conversation_id: "native:30001", text: "一句话", request_id: "abcdefgh", message_index });
	assert.equal(
		accepts("chat.reply", { conversation_id: "native:30001", text: "一句话", request_id: "abcdefgh", message_index: 2 })
			.message_index,
		2,
	);
});

test("sorts, date filters and scroll targets are closed vocabularies", () => {
	assert.equal(accepts("search", { query: "旅行", sort: "likes", published: "week" }).sort, "likes");
	rejects("search", { query: "旅行", sort: "popular" });
	rejects("search", { query: "旅行", published: "year" });
	rejects("search", { query: "   " });
	rejects("search", { query: "a".repeat(301) });
	assert.equal(accepts("page.scroll", {}).pixels, 900);
	rejects("page.scroll", { target: "sidebar" });
	rejects("page.scroll", { pixels: 0 });
	rejects("page.scroll", { pixels: 100001 });
});

test("a since filter that cannot be parsed is refused rather than ignored", () => {
	// Ignoring it would report the whole history while claiming to have filtered.
	assert.equal(accepts("history.list", { since: "2026-01-01T00:00:00Z" }).since, "2026-01-01T00:00:00Z");
	rejects("history.list", { since: "yesterday" });
	rejects("growth.review", { since: "2026-13-01T00:00:00Z" });
});

test("comment ids and message ids are checked for the shape the page uses", () => {
	assert.equal(accepts("comment.delete", { video_id: "12345", comment_id: "10001" }).comment_id, "10001");
	rejects("comment.delete", { video_id: "12345", comment_id: "abc" });
	rejects("comment.reply", { video_id: "12345", comment_id: "", text: "一句话", request_id: "abcdefgh" });
	rejects("chat.capture", { conversation_id: "native:30001" });
	rejects("chat.capture", { conversation_id: "native:30001", message_id: "a".repeat(257) });
});

test("required fields name the flag the caller has to add", () => {
	assert.throws(
		() => validate("comment.post", { text: "一句话", request_id: "abcdefgh" } as never),
		(error: unknown) => error instanceof CliError && /video-id is required/.test(error.message),
	);
	assert.throws(
		() => validate("receipt.get", {} as never),
		(error: unknown) => error instanceof CliError && /request-id is required/.test(error.message),
	);
});

test("every accepted input gets the two defaults a list read expects", () => {
	// A command that read `limit` directly would see undefined on the common path.
	const input = accepts("video.like", { video_id: "12345", request_id: "abcdefgh" });
	assert.equal(input.limit, 20);
	assert.equal(input.scrolls, 0);
});

test("a Douyin id is the kind of id the page actually issues", () => {
	assert.equal(resourceID("12345", "video"), "12345");
	assert.equal(resourceID("MS4wLjABAAAAauthor01", "user"), "MS4wLjABAAAAauthor01");
	// A work id is digits only. A sec_uid is base64-ish and is not digits by
	// accident, but the site does issue all-numeric ones, so that is accepted.
	assert.equal(resourceID("12345", "user"), "12345");
	assert.throws(
		() => resourceID("MS4wLjABAAAAauthor01", "video"),
		(error: unknown) => error instanceof CliError,
	);
	assert.throws(
		() => resourceID("not a url at all", "video"),
		(error: unknown) => error instanceof CliError,
	);
	assert.throws(
		() => resourceID("https://example.com/video/12345", "video"),
		(error: unknown) => error instanceof CliError,
	);
});
