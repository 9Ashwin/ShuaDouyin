import { CliError } from "../errors.ts";

// Every command's accepted input. Handlers stay thin; rules live here.
export interface Input {
	resource?: string;
	query?: string;
	sort?: string;
	published?: string;
	video_id?: string;
	comment_id?: string;
	user_id?: string;
	conversation_id?: string;
	message_id?: string;
	message_index?: number;
	image?: string;
	recipient_id?: string;
	reply_to?: string;
	mention?: string;
	emoji?: string;
	relation?: string;
	reason?: string;
	goal?: string;
	sources?: string;
	at?: string;
	due?: string;
	note?: string;
	stage?: string;
	// Separate from `stages`: one names a card's current stage, the other defines
	// a goal's vocabulary.
	stages?: string;
	goal_preset?: string;
	daily_limit?: number;
	outcome?: string;
	memory_type?: string;
	minutes?: number;
	idle?: number;
	round?: string;
	error_code?: string;
	write?: boolean;
	force?: boolean;
	price?: number;
	count?: number;
	signal_source?: string;
	sticker?: string;
	text?: string;
	text_file?: string;
	request_id?: string;
	dry_run?: boolean;
	headless?: boolean;
	chrome?: string;
	enabled?: boolean;
	include_text?: boolean;
	limit?: number;
	scrolls?: number;
	steps?: number;
	index?: number;
	// Playback position in seconds, for seeking and for sampling a chosen window.
	position?: number;
	// Read back what has been learned instead of measuring the current page.
	known?: boolean;
	offset?: number;
	timezone?: string;
	pixels?: number;
	target?: string;
	seconds?: number;
	frames?: number;
	output?: string;
	since?: string;
	account?: string;
	name?: string;
	preset?: string;
	layer?: string;
	subject?: string;
	topic?: string;
	profile_ref?: string;
	tags?: string;
	certainty?: string;
	confidence?: number;
	source?: string;
	links?: string;
	if_match?: string;
	revision?: string;
	event_id?: string;
	budget?: number;
	apply?: boolean;
	// Deleting is irreversible and the page asks for no confirmation, so the caller
	// has to say it means it.
	confirm?: boolean;
	// Which flags the caller typed, as opposed to defaults filled in by the
	// catalog. Set by the argument parser, never by a caller.
	_stated?: string[];
	// Standing-permission inputs. Target reuses resource; these three are new.
	actions?: string;
	days?: number;
	per_day?: number;
	// Ask the platform's own model for a summary alongside the sampled frames.
	ai?: boolean;
	// Which way a recommendation steer points: less of this, or more of it.
	direction?: string;
}

export function isWrite(operation: string): boolean {
	return [
		"comment.post",
		"comment.delete",
		"comment.reply",
		"comment.image",
		"chat.send",
		"chat.reply",
		"chat.image",
		"chat.share",
		"chat.forward",
		// Recalling is a write even though it removes something: it goes out to the
		// platform, the other side sees it, and it cannot be undone.
		"chat.recall",
		"video.like",
		"video.favorite",
		// Steering the recommender is a write: it changes what this account is
		// shown, passes the pause gate and the goal quota, and leaves a receipt. It
		// is not a loud write — nobody sees it — but it is an instruction to the
		// platform about this account, which is exactly what the write gates are for.
		"video.steer",
		"user.follow",
		"live.say",
		"live.gift",
	].includes(operation);
}

export function resourceID(raw: string, kind: "video" | "user"): string {
	let id = raw;
	if (raw.includes("://")) {
		let url: URL;
		try {
			url = new URL(raw);
		} catch {
			throw new CliError("invalid_argument", "Invalid Douyin URL");
		}
		if (
			url.protocol !== "https:" ||
			!["www.douyin.com", "douyin.com"].includes(url.host) ||
			url.username ||
			url.password
		)
			throw new CliError("invalid_argument", "Expected a Douyin HTTPS URL");
		const parts = url.pathname.replace(/^\/|\/$/g, "").split("/");
		// Image posts live at /note/<id> but are addressed by the same work ID.
		const accepted = kind === "video" ? ["video", "note"] : [kind];
		if (parts.length !== 2 || !accepted.includes(parts[0]))
			throw new CliError("invalid_argument", `Expected /${accepted.join("/ or ")}/<id>`);
		id = parts[1];
	}
	// The signed-in account has no sec_uid on its own pages: the site addresses it
	// as the literal "self". Reading one's own profile is the entry point for
	// seeing who follows you, so the alias is accepted alongside real IDs.
	if (kind === "user" && id === "self") return id;
	if (!(kind === "video" ? /^\d{1,64}$/ : /^[A-Za-z0-9_-]{5,300}$/).test(id))
		throw new CliError("invalid_argument", `Invalid ${kind} ID`);
	return id;
}

export function validate(operation: string, raw: Input): Input {
	const input = { ...raw };
	const required = (key: keyof Input) => {
		if (input[key] === undefined || input[key] === "")
			throw new CliError("invalid_argument", `${key.replaceAll("_", "-")} is required`);
	};
	if (
		input.request_id &&
		(input.request_id.length < 8 ||
			input.request_id.length > 128 ||
			/\s/.test(input.request_id) ||
			[...input.request_id].some((character) => character.charCodeAt(0) < 32))
	)
		throw new CliError("invalid_argument", "--request-id must contain 8..128 non-whitespace characters");
	if (input.video_id !== undefined) input.video_id = resourceID(input.video_id, "video");
	if (input.user_id !== undefined) input.user_id = resourceID(input.user_id, "user");
	if (input.comment_id !== undefined && !/^\d{1,64}$/.test(input.comment_id))
		throw new CliError("invalid_argument", "Invalid --comment-id");
	if (
		input.message_id !== undefined &&
		(!input.message_id ||
			input.message_id.length > 256 ||
			/\s/.test(input.message_id) ||
			[...input.message_id].some((character) => character.charCodeAt(0) < 32))
	)
		throw new CliError("invalid_argument", "Invalid --message-id");
	for (const [key, minimum, maximum] of [
		["limit", 1, 1000],
		["scrolls", 0, 100],
		// video.digest documents 0 as "skip seeking", so its floor is 0 while
		// video.observe still needs at least one frame to have a sample at all.
		["frames", operation === "video.digest" ? 0 : 1, 60],
		["steps", 1, 10],
		["index", 1, 50],
		["offset", 0, 1000000],
	] as const) {
		const value = input[key];
		if (value !== undefined && (!Number.isInteger(value) || value < minimum || value > maximum))
			throw new CliError("invalid_argument", `--${key} must be an integer from ${minimum} to ${maximum}`);
	}
	switch (operation) {
		case "video.favorites":
			// The tab name is checked before Chrome starts. A page command that
			// validated after connecting reported browser_not_running to a caller
			// whose actual mistake was a typo in the tab name.
			if (input.target && !["收藏", "喜欢", "观看历史", "稍后再看", "我的预约"].includes(input.target))
				throw new CliError("invalid_argument", "--tab must be 收藏, 喜欢, 观看历史, 稍后再看 or 我的预约");
			break;
		case "search":
		case "user.search":
			if (!input.query?.trim() || input.query.length > 300)
				throw new CliError("invalid_argument", "Search requires 1..300 characters");
			if (input.sort && !["relevance", "newest", "likes"].includes(input.sort))
				throw new CliError("invalid_argument", "--sort must be relevance, newest or likes");
			if (input.published && !["any", "day", "week", "half-year"].includes(input.published))
				throw new CliError("invalid_argument", "--published must be any, day, week or half-year");
			break;
		case "video.open":
			input.video_id = resourceID(input.resource ?? "", "video");
			break;
		case "link.resolve":
			if (!input.resource || input.resource.length > 4000)
				throw new CliError("invalid_argument", "Provide a Douyin link or share text up to 4000 characters");
			break;
		case "user.get":
			input.user_id = resourceID(input.resource ?? "", "user");
			break;
		case "video.like":
		case "video.favorite":
		case "comment.post":
		case "comment.reply":
		case "comment.image":
		case "comment.replies":
		case "note.capture":
		case "note.next":
		case "note.previous":
		case "chat.share":
		case "chat.forward":
			required("video_id");
			break;
		case "user.follow":
			required("user_id");
			break;
		case "video.steer":
			required("video_id");
			// The direction is the whole instruction, so a missing or misspelled one
			// fails before Chrome starts instead of defaulting to a side the caller
			// never asked for. There is no safe default: the two are opposites.
			if (!["less", "more"].includes(input.direction ?? ""))
				throw new CliError("invalid_argument", "--direction must be less or more");
			if (!input.dry_run) required("request_id");
			break;
		case "video.observe":
			input.seconds ??= 3;
			input.frames ??= 3;
			if (!Number.isFinite(input.seconds) || input.seconds < 0.1 || input.seconds > 300)
				throw new CliError("invalid_argument", "--seconds must be 0.1..300");
			break;
		case "video.audio":
			input.seconds ??= 8;
			if (!Number.isFinite(input.seconds) || input.seconds < 1 || input.seconds > 60)
				throw new CliError("invalid_argument", "--seconds must be 1..60");
			break;
		case "page.scroll":
			input.target ??= "page";
			input.pixels ??= 900;
			if (
				!["page", "comments"].includes(input.target) ||
				!Number.isInteger(input.pixels) ||
				!input.pixels ||
				Math.abs(input.pixels) > 100000
			)
				throw new CliError("invalid_argument", "Use --target page|comments and nonzero --pixels within ±100000");
			break;
		case "history.list":
		case "share.history":
		case "growth.review":
			if (input.since && (!/^\d{4}-\d\d-\d\dT/.test(input.since) || Number.isNaN(Date.parse(input.since))))
				throw new CliError("invalid_argument", "--since must be an RFC3339 timestamp");
			break;
		case "receipt.get":
			required("request_id");
			break;
		case "browser.configure":
			if (input.chrome === undefined && input.headless === undefined)
				throw new CliError("invalid_argument", "Supply --executable or --display headed|headless");
			break;
	}
	if (operation === "comment.reply" || operation === "comment.replies") required("comment_id");
	if (operation === "chat.capture") required("message_id");
	// Recall names one message by its stable id. There is no confirmation dialog
	// on the page, so the id is the only thing standing between the command and
	// the wrong message.
	if (operation === "chat.recall") {
		required("message_id");
		required("request_id");
	}
	if (operation === "chat.image" || operation === "comment.image") {
		required("image");
		if (!input.dry_run) required("request_id");
	}
	if (["chat.read", "chat.history"].includes(operation)) {
		if (input.limit !== undefined && input.limit > 50)
			throw new CliError("invalid_argument", "--limit must be at most 50 for chat history");
		if (input.budget !== undefined && (!Number.isInteger(input.budget) || input.budget < 500 || input.budget > 20000))
			throw new CliError("invalid_argument", "--budget must be 500..20000 characters");
		if (operation === "chat.history" && input.offset && !input.if_match)
			throw new CliError("revision_required", "Use --if-match with the revision from the first history page", {
				hint: "Read the first page, then pass its revision and next_offset.",
			});
	}
	// Forwarding targets the share panel, which identifies recipients by account
	// identity rather than by a conversation row.
	if (operation === "chat.forward") {
		required("recipient_id");
		if (!/^(secuid:)?[A-Za-z0-9_-]{5,300}$/.test(input.recipient_id ?? ""))
			throw new CliError("invalid_argument", "Use --recipient-id from chat list or forward list");
	} else if (
		operation.startsWith("chat.") &&
		// These act on the conversation list as a whole, so there is no single
		// conversation to name.
		!["chat.list", "chat.close", "chat.inbox"].includes(operation)
	) {
		required("conversation_id");
		if (!/^(native:|rendered:|user:|secuid:).{1,1000}$/.test(input.conversation_id ?? ""))
			throw new CliError("invalid_argument", "Use --conversation-id returned by chat list");
	}
	if (operation === "chat.share") input.text = `https://www.douyin.com/video/${input.video_id}`;
	// Forwarding sends a platform card, not caller-supplied text.
	if (operation === "chat.forward" && !input.dry_run) required("request_id");
	if (["comment.post", "comment.reply", "chat.send", "chat.share", "chat.reply"].includes(operation)) {
		// A sticker in a conversation is a message by itself: the platform sends it
		// the moment it is clicked. Accepting text beside one would turn a single
		// request into two messages, one of which the caller never reviewed.
		const stickerAlone = operation === "chat.send" && !!input.emoji;
		if (stickerAlone && input.text?.trim())
			throw new CliError("invalid_argument", "A chat sticker is sent on its own; omit --text or use two requests");
		const needsText = !stickerAlone;
		if (needsText && (!input.text?.trim() || input.text.length > 10000 || input.text.includes("\0")))
			throw new CliError("invalid_argument", "Text must contain 1..10000 characters without NUL");
		if (!input.dry_run) required("request_id");
	}
	if (input.emoji !== undefined) {
		// The platform's own names are bracketed: "[微笑]" in a comment, a bare
		// name like "比心" on a chat sticker. Both are passed through as written.
		const name = input.emoji.trim();
		if (!name || name.length > 40 || name.includes("\0"))
			throw new CliError("invalid_argument", "Use the sticker name shown by the page, 1..40 characters");
		input.emoji = name;
	}
	if (operation === "chat.reply") {
		// The index addresses the loaded window, so it is only meaningful there.
		if (!Number.isInteger(input.message_index) || (input.message_index ?? 0) < 1)
			throw new CliError("invalid_argument", "Use --message-index with a position from chat read");
	}
	if (operation === "chat.read") {
		input.scrolls ??= 0;
		input.pixels ??= 1200;
		if (!Number.isInteger(input.scrolls) || input.scrolls < 0 || input.scrolls > 20)
			throw new CliError("invalid_argument", "--scrolls must be 0..20");
		if (!Number.isFinite(input.pixels) || input.pixels < 200 || input.pixels > 4000)
			throw new CliError("invalid_argument", "--pixels must be 200..4000");
	}
	input.limit ??= 20;
	if (operation !== "chat.read") input.scrolls ??= 0;
	return input;
}
