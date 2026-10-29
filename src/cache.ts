import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync, inflateSync } from "node:zlib";
import { CliError } from "./errors.ts";

// Read a previous session's API responses out of the dedicated Chrome's disk
// cache, so a read does not need the browser running.
//
// The cache is Chrome's own Simple Cache on disk (version 5), one file per
// entry. Chrome is not running when this is used — that is the point — so the
// files are only read, never written, and no cookie, header or storage is
// touched: only the response body of an endpoint that was already fetched.
//
// Why bother: this profile's cache held 11.7k entries, of which 173 were
// comment/list responses covering 115 works. Reading the DOM gets one work at
// a time and needs Chrome; the cache answers "what did the last session
// already see" without either.

const INITIAL_MAGIC = 0xfcfb6d1ba7725c30n;
const FINAL_MAGIC = 0xf4fa6f45970d41d8n;
const TRAILER = 24;

export interface CacheEntry {
	// The URL the response came from, with its query string.
	url: string;
	// The response body, decoded. Null when the body is not JSON this reader can
	// decode: media, redirects and Chrome's own bookkeeping are skipped.
	body: unknown;
	// When Chrome wrote the entry, as epoch milliseconds.
	written: number;
	// Bytes of the stored stream, before decoding.
	bytes: number;
}

interface Raw {
	key: string;
	flags: number;
	stream: Buffer;
	size: number;
}

// Chrome writes the key as `<partition>/<flags>/<hash>_<kind>_<url>`. The URL
// appears twice before the real one — the request spelled against the bare
// host and against the CDN host — so the last token is the one that answered.
function urlOf(key: string): string | null {
	const at = key.indexOf("_dk_");
	const rest = at >= 0 ? key.slice(at + 4) : key;
	const url = rest.trim().split(" ").pop() ?? "";
	return /^https:\/\//.test(url) ? url : null;
}

function readRaw(file: string): Raw | null {
	let fd: number;
	try {
		fd = openSync(file, "r");
	} catch {
		return null;
	}
	try {
		const size = statSync(file).size;
		if (size < 64) return null;
		const header = Buffer.alloc(24);
		readSync(fd, header, 0, 24, 0);
		if (header.readBigUInt64LE(0) !== INITIAL_MAGIC) return null;
		const keyLength = header.readUInt32LE(12);
		if (!keyLength || keyLength > 4096 || 24 + keyLength > size) return null;
		const keyBuffer = Buffer.alloc(keyLength);
		readSync(fd, keyBuffer, 0, keyLength, 24);
		const tail = Buffer.alloc(Math.min(64, size));
		readSync(fd, tail, 0, tail.length, size - tail.length);
		const eof = tail.subarray(tail.length - TRAILER);
		if (eof.readBigUInt64LE(0) !== FINAL_MAGIC) return null;
		// Bit 1 of the trailer flags says a key hash follows the body.
		const flags = eof.readUInt32LE(8);
		const start = 24 + keyLength;
		let end = size - TRAILER;
		if (flags & 2) end -= 32;
		if (end <= start) return null;
		// The stream size in the trailer is not the body length: Chrome records
		// it before the body finishes, so trusting it truncated every response
		// and 142 of 173 comment bodies failed to decode. The body runs from the
		// key to the trailer, and decompression stops at the body's own end.
		const stream = Buffer.alloc(end - start);
		readSync(fd, stream, 0, stream.length, start);
		return { key: keyBuffer.toString("latin1"), flags, stream, size };
	} catch {
		return null;
	} finally {
		closeSync(fd);
	}
}

// Chrome stores the body with whatever Content-Encoding the server used. The
// cache keeps no headers, so each candidate is tried; a wrong guess throws
// rather than returning garbage, which is what makes this safe to guess at.
function decode(stream: Buffer): unknown {
	for (const candidate of [brotliDecompressSync, gunzipSync, inflateSync]) {
		try {
			const text = candidate(stream).toString("utf8");
			const at = text.indexOf("{");
			if (at < 0) continue;
			return JSON.parse(text.slice(at));
		} catch {
			// Most entries are media or binary; those are not JSON and are skipped.
		}
	}
	return null;
}

function cacheDirectory(profile: string): string {
	return join(profile, "Default", "Cache", "Cache_Data");
}

export interface CacheRead {
	// The newest entry matching the filter, or null.
	entry: CacheEntry | null;
	// How many entries matched, whatever their age.
	matches: number;
	// Every entry whose URL matched, newest first, when the caller wants all.
	all: CacheEntry[];
}

// Read every cache entry whose URL matches, newest first. The whole directory
// is walked because Chrome names files by hash: the URL is inside the file, so
// there is no other index to consult. 11.7k entries took 300 ms.
export function readCache(profile: string, match: (url: string) => boolean, limit = 20): CacheRead {
	const directory = cacheDirectory(profile);
	let names: string[];
	try {
		names = readdirSync(directory);
	} catch (error) {
		throw new CliError("not_found", "No Chrome cache to read", {
			hint: "The cache appears after this profile has browsed Douyin once. Run the command with Chrome instead.",
			cause: error,
		});
	}
	const all: CacheEntry[] = [];
	let matches = 0;
	for (const name of names) {
		// `_0` holds the response; `_1` and `_s` are the same entry's siblings.
		if (!name.endsWith("_0")) continue;
		const file = join(directory, name);
		const raw = readRaw(file);
		if (!raw) continue;
		const url = urlOf(raw.key);
		if (!url || !match(url)) continue;
		matches++;
		const body = decode(raw.stream);
		if (body === null) continue;
		let written = 0;
		try {
			written = statSync(file).mtimeMs;
		} catch {
			written = 0;
		}
		all.push({ url, body, written, bytes: raw.size });
	}
	all.sort((left, right) => right.written - left.written);
	return { entry: all[0] ?? null, matches, all: all.slice(0, limit) };
}

// Age in seconds, for a caller deciding whether a snapshot is worth trusting.
export function cacheAgeSeconds(entry: CacheEntry, now = Date.now()): number {
	return entry.written ? Math.max(0, Math.round((now - entry.written) / 1000)) : -1;
}
