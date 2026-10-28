import assert from "node:assert/strict";
import test from "node:test";
import { resolveLink } from "../src/operations/links.ts";

const signal = () => AbortSignal.timeout(3000);

test("direct work and share text resolve without exposing query parameters", async () => {
	assert.deepEqual(await resolveLink("看看 https://www.douyin.com/note/12345?token=secret 一起看", signal()), {
		id: "12345",
		kind: "note",
		url: "https://www.douyin.com/note/12345",
		hops: 0,
	});
	assert.deepEqual(await resolveLink("https://www.douyin.com/?modal_id=12345&token=secret", signal()), {
		id: "12345",
		kind: "unknown",
		url: "https://www.douyin.com/video/12345",
		hops: 0,
	});
	assert.equal((await resolveLink("看这个 (https://www.douyin.com/video/12345),", signal())).id, "12345");
	await assert.rejects(resolveLink("https://www.douyin.com/video/111?modal_id=222", signal()), {
		code: "identity_mismatch",
	});
	await assert.rejects(resolveLink("https://www.douyin.com/?modal_id=111&modal_id=222", signal()), {
		code: "identity_mismatch",
	});
	await assert.rejects(resolveLink("https://www.douyin.com/video/111?modal_id=bad", signal()), {
		code: "identity_mismatch",
	});
	await assert.rejects(resolveLink("https://www.douyin.com/video/1 https://www.douyin.com/video/2", signal()), {
		code: "invalid_argument",
	});
	await assert.rejects(resolveLink("https://www.douyin.com.evil.test/video/1", signal()), { code: "invalid_argument" });
	await assert.rejects(resolveLink("https://user:pass@www.douyin.com/video/1", signal()), { code: "invalid_argument" });
});

test("short link resolution accepts only bounded safe redirects", async () => {
	const seen: string[] = [];
	const request = async (input: string) => {
		seen.push(input);
		return new Response(null, {
			status: 302,
			headers: { location: "https://www.iesdouyin.com/share/video/12345/?secret=hidden" },
		});
	};
	const result = await resolveLink("https://v.douyin.com/abc123/?secret=hidden", signal(), request);
	assert.deepEqual(result, { id: "12345", kind: "unknown", url: "https://www.douyin.com/video/12345", hops: 1 });
	assert.deepEqual(seen, ["https://v.douyin.com/abc123/"]);
	await assert.rejects(
		resolveLink(
			"https://v.douyin.com/abc/",
			signal(),
			async () => new Response(null, { status: 302, headers: { location: "https://example.com/video/123" } }),
		),
		{ code: "identity_mismatch" },
	);
	await assert.rejects(
		resolveLink(
			"https://v.douyin.com/abc/",
			signal(),
			async () => new Response(null, { status: 302, headers: { location: "https://www.douyin.com/" } }),
		),
		{ code: "not_found" },
	);
	let count = 0;
	await assert.rejects(
		resolveLink("https://v.douyin.com/abc/", signal(), async () => {
			count++;
			return new Response(null, { status: 302, headers: { location: "https://v.douyin.com/abc/" } });
		}),
		{ code: "not_found" },
	);
	assert.equal(count, 4);
});
