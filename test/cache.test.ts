import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { cacheAgeSeconds, readCache } from "../src/cache.ts";
import { cachedComments } from "../src/operations/cached-comments.ts";

// A cache entry as Chrome's Simple Cache writes one: magic, version, key
// length, the key, the body, then a 24-byte trailer. The real reader found that
// the body cannot be trusted to end where the trailer's recorded size says, so
// these fixtures keep the body length and the recorded size deliberately apart.

const INITIAL = 0xfcfb6d1ba7725c30n;
const FINAL = 0xf4fa6f45970d41d8n;

function entry(key: string, body: Buffer, recordedSize: number, flags = 0): Buffer {
	const keyBuffer = Buffer.from(key, "latin1");
	const header = Buffer.alloc(24);
	header.writeBigUInt64LE(INITIAL, 0);
	header.writeUInt32LE(5, 8);
	header.writeUInt32LE(keyBuffer.length, 12);
	const trailer = Buffer.alloc(24);
	trailer.writeBigUInt64LE(FINAL, 0);
	trailer.writeUInt32LE(flags, 8);
	trailer.writeUInt32LE(recordedSize, 16);
	return Buffer.concat([header, keyBuffer, body, trailer]);
}

function profileWith(files: Record<string, Buffer>): string {
	const root = mkdtempSync(join(tmpdir(), "dy-cache-"));
	const directory = join(root, "Default", "Cache", "Cache_Data");
	mkdirSync(directory, { recursive: true });
	for (const [name, contents] of Object.entries(files)) writeFileSync(join(directory, name), contents);
	return root;
}

const key = (url: string) => `1/0/_dk_https://douyin.com https://www-hj.douyin.com${url}`;

function commentsBody(comments: object[], total = comments.length): object {
	return {
		status_code: 0,
		comments,
		cursor: 0,
		has_more: total > comments.length,
		total,
	};
}

test("a body longer than the trailer's recorded size is read whole", () => {
	// This is the bug the reader was written around: trusting the trailer size
	// truncated every comment body and 142 of 173 responses failed to decode.
	const body = brotliCompressSync(Buffer.from(JSON.stringify({ ok: true, padding: "x".repeat(4000) })));
	const profile = profileWith({ "0a_0": entry(key("/aweme/v1/web/comment/list/?aweme_id=1"), body, 40) });
	try {
		const read = readCache(profile, () => true);
		assert.deepEqual(read.entry?.body, { ok: true, padding: "x".repeat(4000) });
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("a gzip body and a brotli body both decode", () => {
	// The cache keeps no headers, so the encoding is guessed. A wrong guess
	// throws rather than returning garbage, which is what makes guessing safe.
	const gzip = gzipSync(Buffer.from(JSON.stringify({ encoding: "gzip" })));
	const brotli = brotliCompressSync(Buffer.from(JSON.stringify({ encoding: "brotli" })));
	const profile = profileWith({
		"0a_0": entry(key("/one"), gzip, gzip.length),
		"0b_0": entry(key("/two"), brotli, brotli.length),
	});
	try {
		const read = readCache(profile, () => true);
		assert.equal(read.matches, 2);
		assert.deepEqual(read.all.map((candidate) => (candidate.body as { encoding: string }).encoding).sort(), [
			"brotli",
			"gzip",
		]);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("the URL is the last spelled host, not the request's first form", () => {
	// Every key names the same request against two hosts before the one that
	// answered; matching on the first made endpoints share one path.
	const body = brotliCompressSync(Buffer.from(JSON.stringify({ which: "second" })));
	const profile = profileWith({
		"0a_0": entry("1/0/_dk_https://douyin.com https://other.example/x", body, body.length),
	});
	try {
		assert.deepEqual(readCache(profile, () => true).entry?.body, { which: "second" });
		assert.equal(readCache(profile, () => false).matches, 0);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("media and redirect entries are skipped rather than reported as empty", () => {
	const profile = profileWith({
		"0a_0": entry(key("/video/mp4"), Buffer.from([0, 1, 2, 3, 4, 5]), 6),
		"0b_s": Buffer.from("not an entry at all"),
	});
	try {
		assert.equal(readCache(profile, () => true).entry, null);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("cached comments carry stable ids and say what the cache cannot know", () => {
	const body = brotliCompressSync(
		Buffer.from(
			JSON.stringify(
				commentsBody([
					{
						cid: "7700162290809127714",
						text: "北京这种天气真的非常冷",
						digg_count: 5378,
						reply_comment_total: 89,
						reply_id: "0",
						is_author_digged: true,
						user: { uid: "3062601161398096", sec_uid: "MS4wLjABAAAA", nickname: "功不唐捐" },
					},
					{ cid: "7700556802061517606", text: "", image_list: [{ url: "x" }], user: { nickname: "听雨眠" } },
				]),
			),
		),
	);
	const profile = profileWith({
		"0a_0": entry(key("/aweme/v1/web/comment/list/?aweme_id=7700038191051288505"), body, 1),
	});
	try {
		const result = cachedComments(profile, { video_id: "7700038191051288505" }) as {
			items: Record<string, unknown>[];
			scope: string;
			source: string;
			cache_age_seconds: number;
		};
		assert.equal(result.scope, "chrome_cache");
		assert.equal(result.source, "cache");
		assert.equal(result.items.length, 2);
		assert.equal(result.items[0]?.id, "7700162290809127714");
		assert.equal(result.items[0]?.parent_id, null);
		assert.equal(result.items[0]?.likes, 5378);
		assert.equal(result.items[0]?.reply_count, 89);
		assert.equal(result.items[0]?.liked_by_author, true);
		// The cache has no signed-in identity, so this must be unknown, not false.
		assert.equal(result.items[0]?.mine, null);
		// An image-only comment is an image, not an empty comment.
		assert.equal(result.items[1]?.kind, "image");
		assert.equal((result.items[1]?.images as unknown[]).length, 1);
		assert.ok(result.cache_age_seconds >= 0);
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("replies are a different endpoint and are not mistaken for top-level comments", () => {
	const body = brotliCompressSync(Buffer.from(JSON.stringify(commentsBody([{ cid: "1", text: "a reply" }]))));
	const profile = profileWith({
		"0a_0": entry(key("/aweme/v1/web/comment/list/reply/?aweme_id=5&comment_id=9"), body, body.length),
	});
	try {
		assert.throws(() => cachedComments(profile, { video_id: "5" }), { code: "not_found" });
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("a work the cache never saw says so instead of returning an empty list", () => {
	const body = brotliCompressSync(Buffer.from(JSON.stringify(commentsBody([{ cid: "1", text: "x" }]))));
	const profile = profileWith({ "0a_0": entry(key("/aweme/v1/web/comment/list/?aweme_id=111"), body, body.length) });
	try {
		assert.throws(() => cachedComments(profile, { video_id: "222" }), { code: "not_found" });
	} finally {
		rmSync(profile, { recursive: true, force: true });
	}
});

test("a profile with no cache directory is a not_found, not a crash", () => {
	assert.throws(() => readCache(join(tmpdir(), "dy-no-such-profile-xyz"), () => true), { code: "not_found" });
});

test("age is seconds since the entry was written", () => {
	assert.equal(cacheAgeSeconds({ url: "", body: null, written: 1_000_000, bytes: 0 }, 1_060_000), 60);
	assert.equal(cacheAgeSeconds({ url: "", body: null, written: 0, bytes: 0 }), -1);
});
