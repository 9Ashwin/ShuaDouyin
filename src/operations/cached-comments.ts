import { cacheAgeSeconds, readCache } from "../cache.ts";
import { classifyComment } from "../comment-stance.ts";
import { CliError } from "../errors.ts";
import type { Input } from "./validate.ts";

// Comments from the previous session's cache, for a work this profile already
// opened. Explicitly asked for, never a silent substitute: a cached answer is a
// snapshot of what the page served then, and a caller that cannot see the age
// would treat it as current.
//
// This deliberately answers less than the live read. `mine` needs the signed-in
// uid, which the cache does not carry, so it is null rather than false — a
// caller that needs it has to read the page.

interface CachedComment {
	cid?: unknown;
	text?: unknown;
	create_time?: unknown;
	digg_count?: unknown;
	reply_comment_total?: unknown;
	reply_id?: unknown;
	is_author_digged?: unknown;
	ip_label?: unknown;
	image_list?: unknown;
	user?: { uid?: unknown; sec_uid?: unknown; nickname?: unknown; unique_id?: unknown };
}

interface CachedBody {
	status_code?: unknown;
	comments?: unknown;
	cursor?: unknown;
	has_more?: unknown;
	total?: unknown;
}

function text(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function count(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function item(comment: CachedComment, videoID: string) {
	const body = text(comment.text);
	const images = Array.isArray(comment.image_list) ? comment.image_list.length : 0;
	const kind: "text" | "image" = !body && images ? "image" : "text";
	const classified = classifyComment(body);
	const authorID = text(comment.user?.sec_uid) || text(comment.user?.uid) || null;
	return {
		id: text(comment.cid) || null,
		video_id: videoID,
		// The API spells "not a reply" as the string "0"; the live reader reports
		// null for a top-level comment, so both reads agree.
		parent_id: (() => {
			const parent = text(comment.reply_id);
			return parent && parent !== "0" ? parent : null;
		})(),
		text: body,
		kind,
		images: images ? Array.from({ length: images }, () => ({ ready: null, source_available: true })) : [],
		author: text(comment.user?.nickname),
		author_url: authorID ? `https://www.douyin.com/user/${authorID}` : null,
		likes: count(comment.digg_count),
		liked_by_author: comment.is_author_digged === true,
		// The cache carries no signed-in identity, so whether a comment is the
		// account's own cannot be answered from it.
		mine: null,
		ip_label: text(comment.ip_label) || null,
		reply_count: count(comment.reply_comment_total),
		stance: classified.stance,
		stance_signals: classified.signals,
	};
}

export function cachedComments(profile: string, input: Input): unknown {
	const videoID = input.video_id ?? "";
	if (!videoID) throw new CliError("invalid_argument", "--video-id is required for a cached read");
	const read = readCache(
		profile,
		(url) => {
			if (!/\/aweme\/v1\/web\/comment\/list\//.test(url) || url.includes("/reply/")) return false;
			const aweme = /[?&]aweme_id=(\d+)/.exec(url)?.[1];
			return aweme === videoID;
		},
		200,
	);
	if (!read.entry) {
		throw new CliError("not_found", "No cached comments for this work", {
			hint: "The cache only holds works this profile has opened. Read the page with dy comment list, or remove --from-cache.",
			details: { video_id: videoID, entries_scanned: read.matches },
		});
	}
	// One response is one page at one cursor. A deeper scroll leaves several, and
	// the newest is the one closest to where the session was reading from, so it
	// decides the shape and the rest only add comments that are not already here.
	const newest = read.entry.body as CachedBody;
	const items: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (const entry of read.all) {
		const body = entry.body as CachedBody;
		if (body.status_code !== 0 || !Array.isArray(body.comments)) continue;
		for (const comment of body.comments as CachedComment[]) {
			const record = item(comment, videoID);
			if (!record.id || seen.has(record.id)) continue;
			seen.add(record.id);
			items.push(record);
		}
	}
	return {
		video_id: videoID,
		items: items.slice(0, input.limit ?? 20),
		// A cache read covers exactly what a previous session fetched, which is
		// never the full history either — but the word changes, because this is
		// not the loaded DOM and the distinction matters to a caller deciding
		// whether to trust it.
		scope: "chrome_cache",
		complete: newest.has_more === false,
		total: count(newest.total),
		pages: read.all.length,
		cache_age_seconds: cacheAgeSeconds(read.entry),
		source: "cache",
		guidance:
			"This is what the page served to an earlier session, not the current page. mine is null because the cache carries no signed-in identity. Replies are not included.",
	};
}
