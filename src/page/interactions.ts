import { commentEditor, readComments } from "./comments.ts";
import {
	clean,
	detachMentions,
	editorHasDraft,
	editorText,
	fail,
	find,
	findRendered,
	mentionName,
	mentionNodes,
	one,
	own,
	type Point,
	point,
	reactProps,
	routeKind,
} from "./dom.ts";
import {
	authenticatedUser,
	chatRoot,
	chatSignature,
	guardPage,
	guardVideo,
	noteRoot,
	readChat,
	userIdentity,
	watermark,
} from "./readers.ts";

export interface Args {
	action: string;
	token: string;
	video_id: string;
	comment_id?: string;
	user_id: string;
	conversation_id: string;
	message_id?: string;
	message_index?: number;
	mention?: string;
	emoji?: string;
	relation?: string;
	index?: number;
	// Live room gift identity: a name and the price the caller expects.
	name?: string;
	price?: number;
	// Playback position in seconds, for video.seek.
	at?: number;
	// What the conversation held before a send, so the new row can be recognised.
	baseline?: { media: number; sources: string[] };
	query?: string;
	group?: number;
	choice?: number;
	direction?: string;
	file_name?: string;
	file_size?: number;
	file_mime?: string;
	file_sha256?: string;
	reply_to?: string;
	recipient_id?: string;
	text: string;
	value: boolean;
	include_text?: boolean;
	control: string;
	target: string;
	pixels: number;
}

// The fields the send path actually compares. Everything else a comment row can
// carry is optional and often absent, and typing it as required is what made the
// adapter write `false` on every row.
type RecordRow = {
	id: string | null;
	text: string;
	timestamp?: string | null;
	pending?: boolean;
	failed?: boolean;
	// A sticker has no text at all, so it is identified by kind instead.
	kind?: string;
};
interface Prepared {
	token: string;
	editor: HTMLElement;
	root: HTMLElement;
	signature: string;
	watermark: string;
	before: RecordRow[];
	// When this send was prepared. The page dates delivered messages with the
	// platform clock, and only the ordering against this instant proves a row
	// came from this send rather than from a window loaded later.
	started_at: string;
	// What this send asked for, so the result can tell a sticker from text.
	emoji?: string;
	dispatched: boolean;
	blocked: boolean;
	// Why the guard refused the click, when it did, and what the failing check
	// saw.
	reason?: string;
	reason_detail?: string;
}
interface Guard {
	token: string;
	cleanup: () => void;
	state: { dispatched: boolean; blocked: boolean; reason?: string };
}
declare global {
	interface Window {
		__douyinCLI?: Prepared;
		__douyinCLIGuard?: Guard;
	}
}

export function videoRoot(): HTMLElement {
	// The feed preloads its neighbours, so several videos are laid out at once and
	// requiring exactly one failed whenever the player had loaded the next slide.
	// feed-active-video is not the answer either: during a transition it marks the
	// slide that just left. The one actually on screen is what the reader is
	// looking at, so the viewport decides.
	const scoped = find<HTMLVideoElement>(document, "video").filter(
		(element) => !element.closest('[data-e2e="im-dialog"]'),
	);
	const onScreen = scoped.filter((element) => {
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > innerHeight * 0.2 && rect.top < innerHeight * 0.8;
	});
	const video = one(onScreen.length ? onScreen : scoped, "visible video");
	const root =
		video.closest<HTMLElement>('[data-e2e="feed-active-video"],[data-e2e="video-detail"]') ??
		video.closest<HTMLElement>('[data-e2e="player-container"]');
	if (!root) fail("selector_changed", "No scoped video container");
	return root;
}

export function installGuard(
	button: HTMLElement,
	token: string,
	check: () => void,
	state: { dispatched: boolean; blocked: boolean; reason?: string } = { dispatched: false, blocked: false },
): void {
	window.__douyinCLIGuard?.cleanup();
	const listener = (event: Event) => {
		if (
			!event.isTrusted ||
			!(event.target instanceof Node) ||
			!(event.target === button || button.contains(event.target))
		)
			return;
		try {
			if (!button.isConnected || button.getAttribute("data-douyin-cli-control") !== token)
				fail("identity_mismatch", "Control changed");
			check();
			if (event.type === "click") state.dispatched = true;
		} catch (error) {
			// This is where a refused dispatch is decided, and the reason was being
			// thrown away: the caller was told only that the target or draft had
			// changed, never which check refused or what it saw. Keep the reason so
			// the failure names itself.
			state.blocked = true;
			state.reason =
				error && typeof error === "object" && "code" in error
					? String((error as { message?: unknown }).message ?? "")
					: error instanceof Error
						? error.message
						: "";
			// The witness the caller reads after the click is a different object;
			// carry both the message and the detail across so writeResult can
			// report them. detail is where the failing check puts what it saw.
			if (window.__douyinCLI && window.__douyinCLI.token === token) {
				window.__douyinCLI.reason = state.reason;
				window.__douyinCLI.reason_detail =
					error && typeof error === "object" && "hint" in error ? String((error as { hint?: unknown }).hint ?? "") : "";
			}
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	const types = ["mousedown", "mouseup", "click"];
	for (const type of types) document.addEventListener(type, listener, true);
	const cleanup = () => {
		for (const type of types) document.removeEventListener(type, listener, true);
	};
	window.__douyinCLIGuard = { cleanup, state, token };
}

function toggleControl(action: string) {
	if (action === "user.follow") {
		// Two markers sit on this header and they nest the other way round from what
		// the names suggest: user-detail contains user-info, and the follow control
		// lives inside user-detail. Taking the innermost match therefore walked into
		// the one subtree that has no button. The control is looked for across both.
		const matches = find(document, '[data-e2e="user-info"],[data-e2e="user-detail"]');
		if (!matches.length) fail("selector_changed", "Expected a user profile header");
		// 回关 is the platform's word for "this account follows you, follow back".
		// The marker also sits on the follower count beside the button, whose text
		// reads 关注77, so a control is identified by a label that is exactly one of
		// the states rather than by the marker alone.
		const LABEL = /^(关注|回关|已关注|互相关注|相互关注|取消关注)$/;
		const search = (selector: string) =>
			matches.flatMap((element) => find(element, selector)).filter((element) => LABEL.test(clean(element.textContent)));
		const marked = search('[data-e2e="user-info-follow-btn"],[data-e2e="user-info-follow"]');
		const controls = marked.length ? marked : search('[data-e2e="follow-button"],button,[role="button"]');
		const button = one(
			controls.filter((element) => !controls.some((other) => other !== element && element.contains(other))),
			"follow control",
		);
		return {
			button,
			value: /^(已关注|互相关注|相互关注|取消关注)$/.test(clean(button.textContent)),
		};
	}
	const like = action === "video.like";
	// Image posts use their own controls. Falling back to the video controls
	// would silently act on a different surface, so a missing note control fails.
	const note = routeKind(location.href).kind === "note";
	// The action rail is not always inside the player container, so a note scopes
	// to its post root while a video searches the document: the control is chosen
	// by being the one on screen, which is already the right answer on the feed.
	const scope = note ? noteRoot() : document.body;
	if (!scope) fail("selector_changed", "No scoped image post container");
	// The feed keeps the neighbouring slides laid out, so the same control appears
	// more than once and find() returns them all. Only one of them is on screen,
	// and that is the one the page and the reader are both acting on.
	const candidates = find(
		scope,
		note
			? like
				? '[data-e2e="note-digg"]'
				: '[data-e2e="note-collect"]'
			: like
				? '[data-e2e="video-player-digg"],[data-e2e="like-button"]'
				: '[data-e2e="video-player-collect"],[data-e2e="favorite-button"]',
	);
	const inView = candidates.filter((element) => {
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
	});
	const button = one(
		inView.length ? inView : candidates,
		note ? (like ? "note like control" : "note favorite control") : like ? "like control" : "favorite control",
	);
	// The live page states the state in a marker of its own and no longer sets
	// aria-pressed on these controls. Both spellings end the same way — "no-digged"
	// is not liked and "is-digged" is — so the marker is read as a whole rather
	// than by a suffix, which would call both of them liked.
	// The words differ per control — digged for a like, collect for a favourite —
	// so the stem is matched, not one spelling. "collect" and "collected" are the
	// same control in different builds.
	const marker = (button.getAttribute("data-e2e-state") ?? "").trim();
	if (marker) {
		const STEM = "(?:digg|collect|collect|like|favorit)";
		const active = new RegExp(`^(?:[a-z-]*-)?(?:is|has)-${STEM}[a-z]*$`).test(marker);
		const inactive = new RegExp(`(?:^|-)no-${STEM}[a-z]*$`).test(marker);
		if (active || inactive) return { button, value: active };
	}
	const pressed = button.getAttribute("aria-pressed") ?? button.getAttribute("data-active");
	if (pressed === "true" || pressed === "false") return { button, value: pressed === "true" };
	const label = button.getAttribute("aria-label") ?? button.getAttribute("title") ?? "";
	if (label.includes(like ? "取消点赞" : "取消收藏")) return { button, value: true };
	if (label === (like ? "点赞" : "收藏")) return { button, value: false };
	const values = reactProps(button).flatMap((props) =>
		(like ? ["isDigg", "isLike"] : ["isCollect", "isFavorite"])
			.map((name) => own(props, name))
			.filter((value): value is boolean => typeof value === "boolean"),
	);
	if (values.length && new Set(values).size === 1) return { button, value: values[0] };
	fail("selector_changed", "Cannot determine the current toggle state");
}

function guardTarget(args: Args): void {
	if (args.action === "user.follow") userIdentity(args.user_id);
	else guardVideo(args.video_id);
}

export function prepareWrite(
	args: Args,
): { already: true; value: boolean } | Point | { selector: string; before: RecordRow[] } {
	if (["video.like", "video.favorite", "user.follow"].includes(args.action)) {
		guardTarget(args);
		const { button, value } = toggleControl(args.action);
		if (value === args.value) return { already: true, value };
		installGuard(button, args.token, () => {
			guardTarget(args);
			if (toggleControl(args.action).value !== value) fail("identity_mismatch", "Toggle changed before input");
		});
		return point(button, args.token);
	}
	let editor: HTMLElement;
	let root: HTMLElement;
	let signature = "";
	let mark = "";
	if (args.action === "chat.send") {
		const chat = readChat(args.conversation_id);
		if (
			args.reply_to &&
			!chat.messages.some(
				(message) =>
					message.id === args.reply_to && message.direction === "incoming" && !message.failed && !message.pending,
			)
		)
			fail("identity_mismatch", "Reply anchor is not a readable incoming message");
		root = chatRoot().root;
		editor = one(find(root, '[data-e2e="msg-input"] [contenteditable="true"]'), "private message editor");
		signature = chatSignature();
		mark = watermark();
	} else {
		guardVideo(args.video_id);
		({ editor, root } = commentEditor(args.comment_id));
	}
	if (editorHasDraft(editor))
		fail("draft_conflict", "Composer already contains a draft", "The existing draft has been preserved.");
	editor.setAttribute("data-douyin-cli-editor", args.token);
	const before = args.action === "chat.send" ? readChat(args.conversation_id).messages : readComments(args.video_id);
	window.__douyinCLI = {
		token: args.token,
		editor,
		root,
		signature,
		watermark: mark,
		before,
		started_at: new Date().toISOString(),
		...(args.emoji ? { emoji: args.emoji } : {}),
		dispatched: false,
		blocked: false,
	};
	return { selector: `[data-douyin-cli-editor="${args.token}"]`, before };
}

// The publish icon: span.wchsYBpK wrapping one 0 0 36 36 svg with two paths.
// The emoji and image icons next to it use the same viewBox but carry one path,
// so the count is what distinguishes them.
export function publishIcon(element: HTMLElement): boolean {
	const holder = element.closest<HTMLElement>("span.wchsYBpK") ?? element;
	if (!holder.classList.contains("wchsYBpK") || clean(holder.textContent)) return false;
	const svgs = holder.querySelectorAll("svg");
	if (svgs.length !== 1) return false;
	if ((svgs[0].getAttribute("viewBox") ?? "").replace(/\s+/g, " ").trim() !== "0 0 36 36") return false;
	return svgs[0].querySelectorAll("path").length === 2;
}

function matchesRequestedText(editor: HTMLElement, args: Args): boolean {
	if (editor.querySelector('img,video,audio,[data-slate-void="true"]')) return false;
	const text = editorText(editor);
	if (text === args.text) return true;
	// A zero-width character the caller did not type is not the same message, even
	// though it renders identically — the browser tests reject exactly that. What
	// is accepted is the page's own sentinel, which is marked as structure rather
	// than being free text, and only the branch below may strip it.
	if (typeof args.text !== "string") return false;
	// The editor renders each line as a block ending in a marked zero-width
	// sentinel. Remove only that exact structural node, never a user character.
	// Both the private-message composer and the comment composer are the same
	// Draft.js editor, and restricting this to chat.send is why a comment reply
	// failed with "filled text differs from requested text" while the composer
	// visibly held exactly the right sentence.
	const blocks = [...editor.childNodes];
	if (!blocks.length || blocks.some((node) => !(node instanceof HTMLElement) || node.tagName !== "DIV")) return false;
	const lines: string[] = [];
	const rendered: string[] = [];
	for (const node of blocks) {
		if (!(node instanceof HTMLElement)) return false;
		const sentinel = node.lastElementChild;
		if (
			!sentinel ||
			!sentinel.matches('span[data-string="true"][data-enter="true"][data-leaf="true"]') ||
			sentinel.childElementCount ||
			sentinel.textContent !== "\u200b" ||
			node.querySelectorAll('[data-enter="true"]').length !== 1
		)
			return false;
		const line = node.innerText.replace(/\r\n/g, "\n");
		if (!line.endsWith("\u200b")) return false;
		rendered.push(line);
		lines.push(line.slice(0, -1));
	}
	return rendered.join("\n") === text && lines.join("\n") === args.text;
}

// A selected @ mention is a node the page inserted, not text the caller typed.
// Its spans are removed before the ordinary text comparison, so the requested
// text must still match exactly and the mentions must be the requested ones.
function matchesMentionedText(editor: HTMLElement, args: Args): boolean {
	const mentions = mentionNodes(editor).map(mentionName);
	const expected = clean(args.mention).replace(/^@/, "");
	if (!mentions.length || !expected) return false;
	if (mentions.some((mention) => mention !== expected)) return false;
	const clone = editor.cloneNode(true) as HTMLElement;
	detachMentions(clone);
	return matchesRequestedText(clone, { ...args, mention: undefined });
}

// The smiley in a composer's right-hand action row. It is an unlabelled icon,
// so it is found by where it sits and by being the last icon in that row; the
// file picker sits to its left and the send button is drawn separately.
export function smileyTrigger(scope: HTMLElement): HTMLElement {
	// The smiley is an unlabelled icon in the composer's action row. In a
	// conversation the row marks it with a class of its own; in a comment it is
	// one of two plain icons beside the text box. Both cases are covered by
	// taking the marked icon when it exists and otherwise the last icon in the
	// composer, since the smiley sits right of the @ control and left of send.
	const marked = [...scope.querySelectorAll<HTMLElement>(".messageMsgInputiconAction")].filter(
		(element) => element.getBoundingClientRect().width > 0,
	);
	if (marked.length === 1) return marked[0];
	const editor = scope.querySelector<HTMLElement>('[contenteditable="true"],textarea');
	const row = editor?.closest<HTMLElement>('[class*="MsgInput"],[class*="inputArea"]') ?? scope;
	const box = row.getBoundingClientRect();
	const icons = [...row.querySelectorAll<HTMLElement>("svg,img")].filter((element) => {
		const rect = element.getBoundingClientRect();
		return (
			rect.width > 14 &&
			rect.width < 48 &&
			rect.height > 14 &&
			rect.height < 48 &&
			rect.top >= box.top - 8 &&
			rect.bottom <= box.bottom + 8 &&
			rect.left > box.left + box.width - 220
		);
	});
	return one(icons, "composer smiley");
}

// The platform's own name for each sticker. A chat grid labels most items in
// the page, but labels some of them (an empty slot between groups, a sticker
// with no name yet) with nothing at all, so the grid is recognised by the items
// that do carry a label and positions are never trusted on their own: a pick
// matches the label exactly, and an item without one can never be chosen.
export function emojiNames(): { name: string; index: number }[] {
	const items = findRendered<HTMLElement>(document, '[class*="emojiEmojiItememojiItem"]');
	return items.flatMap((item, index) => {
		const label = clean(item.querySelector('[class*="emojiItemDesc"]')?.textContent);
		return label ? [{ name: label, index }] : [];
	});
}

// A sticker send never types into the composer, so it records its baseline
// without arming one. The result still needs the same witness every other write
// uses, because that is where the starting window and request identity live.
export function chatBaseline(args: Args) {
	const root = chatRoot().root;
	const before = readChat(args.conversation_id).messages;
	// The witness holds the composer itself, never the whole panel: the panel's
	// text is every message in the conversation, so an emptiness check against
	// it could never be false and no sticker would ever be confirmed.
	const editor = root.querySelector<HTMLElement>('[data-e2e="msg-input"] [contenteditable="true"]');
	if (!editor) fail("editor_not_ready", "Message composer is not rendered");
	window.__douyinCLI = {
		token: args.token,
		editor,
		root,
		signature: chatSignature(),
		watermark: "",
		before,
		started_at: new Date().toISOString(),
		...(args.emoji ? { emoji: args.emoji } : {}),
		dispatched: false,
		blocked: false,
	};
	return { before, ...(args.emoji ? { emoji: args.emoji } : {}) };
}

export function armWrite(args: Args): Point {
	const state = window.__douyinCLI;
	const matches = (editor: HTMLElement) =>
		args.mention ? matchesMentionedText(editor, args) : matchesRequestedText(editor, args);
	if (!state || state.token !== args.token || !state.editor.isConnected || !matches(state.editor))
		fail("draft_conflict", "Filled text differs from requested text");
	const check = () => {
		guardPage();
		if (args.action === "chat.send") {
			// Which of the two changed is the whole diagnosis: a different
			// conversation means the panel moved, a different watermark means the
			// history grew under the composer. Reporting one sentence for both left
			// a caller with nothing to act on, and a send that failed this way could
			// not be told apart from one that failed on a slow history load.
			const signature = chatSignature();
			if (signature !== state.signature)
				fail("identity_mismatch", "The open conversation changed before send", JSON.stringify({ signature }));
			const mark = watermark();
			// Both sides of the comparison, so a difference names itself instead of
			// leaving the reader to guess what the baseline had been.
			if (mark !== state.watermark)
				fail(
					"identity_mismatch",
					"Message history changed before send",
					JSON.stringify({ was: state.watermark.slice(0, 220), now: mark.slice(0, 220) }),
				);
		} else {
			guardVideo(args.video_id);
			if (commentEditor(args.comment_id).editor !== state.editor) fail("identity_mismatch", "Comment composer changed");
		}
		if (!matches(state.editor)) fail("draft_conflict", "Draft changed before send");
	};
	check();
	// On the live page the publish control is an unlabelled icon, not a button:
	// span.wchsYBpK holding a 0 0 36 36 svg with two paths. The sibling icons
	// (emoji, image) share the viewBox, so the two-path shape is what tells them
	// apart. Labelled and data-e2e controls are still accepted first.
	const selectors =
		args.action === "chat.send"
			? '.e2e-send-msg-btn,[data-e2e="send-msg-btn"]'
			: '[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],[aria-label="发布"],[aria-label="发表评论"],span.wchsYBpK';
	// Only a control whose own label or shape identifies it as the publish
	// action counts. A bare button tag would also match 回复 and 分享, which sit
	// next to the composer and would send the wrong thing.
	const controls = find(state.root, selectors).filter(
		(element) =>
			args.action === "chat.send" ||
			element.matches(
				'[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],[aria-label="发布"],[aria-label="发表评论"]',
			) ||
			/^(发布|发送|发表评论|发布评论)$/.test(clean(element.textContent)) ||
			publishIcon(element),
	);
	const button = one(
		controls.filter((element) => !controls.some((other) => other !== element && element.contains(other))),
		"send control",
	);
	installGuard(button, args.token, check, state);
	return point(button, args.token);
}

export function writeResult(args: Args) {
	if (["video.like", "video.favorite", "user.follow"].includes(args.action)) {
		guardTarget(args);
		const { value } = toggleControl(args.action);
		return {
			confirmed: value === args.value,
			value,
			blocked: window.__douyinCLIGuard?.state.blocked ?? false,
		};
	}
	const state = window.__douyinCLI;
	if (!state) fail("identity_mismatch", "Send witness no longer exists", `expected ${args.token}, found none`);
	if (state.token !== args.token)
		fail("identity_mismatch", "Send witness no longer exists", `expected ${args.token}, found ${state.token}`);
	if (state.blocked)
		return {
			confirmed: false,
			blocked: true,
			dispatched: state.dispatched,
			blocked_reason: state.reason ?? null,
			blocked_detail: state.reason_detail ?? null,
		};
	const rows = args.action === "chat.send" ? readChat(args.conversation_id).messages : readComments(args.video_id);
	// A mention is delivered as text too: the row reads "@name text", so the row
	// this send produced never equals the body alone. Both spellings are
	// accepted, and nothing looser, so a stray similar message cannot confirm it.
	const expected = new Set([args.text]);
	if (args.action === "chat.send" && args.mention) {
		expected.add(`@${clean(args.mention)} ${args.text ?? ""}`);
		expected.add(`@${clean(args.mention)}${args.text ?? ""}`);
	}
	const sameText = (row: RecordRow) => typeof row.text === "string" && expected.has(row.text);
	const before = new Set(state.before.map((row) => row.id).filter(Boolean));
	// The page dates every delivered row, so a row carrying a creation time after
	// this send was started is proof the send produced it. That is what the
	// loaded window alone cannot say: an older row can be loaded after the click
	// and must never confirm a send. Ids are not used for this — their ordering
	// is the platform's business, and the page's own clock already answers it.
	const startedAt = Date.parse(state.started_at ?? "");
	// A row created in the same millisecond as the baseline is still this send's
	// row: the page can stamp a message faster than the click that produced it
	// can be observed. What must not pass is a row older than the baseline.
	const createdAfter = (row: RecordRow): boolean => {
		const stamp = typeof row.timestamp === "string" ? Date.parse(row.timestamp) : Number.NaN;
		return Number.isFinite(stamp) && Number.isFinite(startedAt) && stamp >= startedAt;
	};
	const loadedMatches = rows.filter(
		(row) =>
			sameText(row) &&
			!row.pending &&
			!row.failed &&
			("direction" in row
				? row.direction === "outgoing"
				: row.mine && (args.comment_id ? row.parent_id === args.comment_id : row.parent_id === null)),
	);
	const matches = rows.filter(
		(row) =>
			row.id &&
			!before.has(row.id) &&
			sameText(row) &&
			!row.pending &&
			!row.failed &&
			("direction" in row
				? row.direction === "outgoing"
				: row.mine && row.sent && (args.comment_id ? row.parent_id === args.comment_id : row.parent_id === null)),
	);
	// Dated matches are the ones the page itself places after this send started.
	const ordered = matches.filter(createdAfter);
	const unresolvedBaseline =
		args.action === "chat.send" && (!state.before.length || state.before.some((row) => !row.id));
	// Without a comparable id on both sides the loaded window still cannot say
	// its last row is the latest message, so the send stays unverified.
	const unverifiedEnd = args.action === "chat.send" && ordered.length === 0;
	// Comment lists are also partial and can load old rows after dispatch.
	const editorEmpty = args.action === "chat.send" ? !editorHasDraft(state.editor) : !editorText(state.editor).trim();
	const self = args.action === "comment.post" ? authenticatedUser() : undefined;
	// A work page exposes the signed-in account only as the literal "self", which
	// no comment row ever carries, so an ownership check there can never succeed.
	// What a posted comment can still prove is narrower and sufficient: a row that
	// was not in the baseline, is a top-level comment, carries exactly the text
	// this command wrote, and the page marks it as sent. The text is the command's
	// own, so no other row can match it unless the platform stored it twice.
	const ownComment =
		args.action !== "comment.post"
			? []
			: rows.filter(
					(row) =>
						row.id &&
						!before.has(row.id) &&
						row.text === args.text &&
						!row.pending &&
						!row.failed &&
						"parent_id" in row &&
						(args.comment_id ? row.parent_id === args.comment_id : row.parent_id === null) &&
						// The row must carry its own ownership marker. A page that reports
						// the signed-in account only as "self" and marks no row leaves the
						// text as the only evidence, and text alone cannot tell a send from
						// someone else writing the same words.
						row.mine === true,
				);
	const commentDelivered = args.action === "comment.post" && state.dispatched && editorEmpty && ownComment.length === 1;
	const commentIdentityUnavailable = args.action === "comment.post" && (!self || self === "self") && !commentDelivered;
	// One row dated after the baseline, carrying exactly the requested text from
	// this account, with the composer emptied by the platform: that is delivery.
	// Two of them is a duplicate and none is unproven, so only exactly one counts.
	// A sticker carries no text, so it cannot be matched by content. It is still
	// provable: a new outgoing row of kind "emoji", dated after this send began,
	// with its id absent from the baseline, is a row this send created.
	const stickers =
		args.action === "chat.send" && state.emoji
			? rows.filter(
					(row) =>
						row.id &&
						!before.has(row.id) &&
						"kind" in row &&
						row.kind === "emoji" &&
						"direction" in row &&
						row.direction === "outgoing" &&
						!row.pending &&
						!row.failed &&
						createdAfter(row),
				)
			: [];
	// A sticker never goes through the composer, so an existing draft is neither
	// evidence for nor against it: the only proof is the row it created.
	const chatDelivered =
		args.action === "chat.send" &&
		state.dispatched &&
		(state.emoji ? stickers.length === 1 : editorEmpty && ordered.length === 1);
	return {
		confirmed: chatDelivered || commentDelivered,
		...(unresolvedBaseline && !chatDelivered && state.dispatched && editorEmpty
			? { uncertain_reason: "message_history_missing_ids" }
			: {}),
		...(!unresolvedBaseline && !chatDelivered && unverifiedEnd && state.dispatched && editorEmpty
			? { uncertain_reason: "message_latest_end_unverified" }
			: {}),
		...(commentIdentityUnavailable && state.dispatched && editorEmpty
			? { uncertain_reason: "comment_self_identity_unavailable" }
			: {}),
		...(!commentIdentityUnavailable && args.action === "comment.post" && state.dispatched && editorEmpty
			? { uncertain_reason: "comment_window_unverified" }
			: {}),
		dispatched: state.dispatched,
		record:
			stickers.length === 1
				? stickers[0]
				: ownComment.length === 1
					? ownComment[0]
					: ordered.length === 1
						? ordered[0]
						: matches.length === 1
							? matches[0]
							: null,
		delivery_ordered: ordered.length === 1,
		loaded_matching_rows: loadedMatches.length,
		baseline_matching_text_rows: state.before.filter((row) => row.text === args.text).length,
	};
}

export function cleanup(): object {
	window.__douyinCLIGuard?.cleanup();
	delete window.__douyinCLIGuard;
	document.querySelectorAll("[data-douyin-cli-control],[data-douyin-cli-editor]").forEach((element) => {
		element.removeAttribute("data-douyin-cli-control");
		element.removeAttribute("data-douyin-cli-editor");
	});
	delete window.__douyinCLI;
	return {};
}
