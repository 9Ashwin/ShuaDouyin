import {
	chatImageBaseline,
	chatImageConfirmationState,
	chatImageState,
	cleanupChatImage,
	preflightChatImage,
	prepareChatImage,
	prepareChatImageConfirmation,
} from "./chat-image.ts";
import {
	cleanupCommentImage,
	commentImageConfirmationState,
	commentImageState,
	preflightCommentImage,
	prepareCommentImage,
	prepareCommentImageConfirmation,
} from "./comment-image.ts";
import {
	commentAuthor,
	commentID,
	commentRow,
	expandControl,
	pageTowardComment,
	readComments,
	replyState,
} from "./comments.ts";
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
	type PageError,
	point,
	routeKind,
} from "./dom.ts";
import {
	armForward,
	forwardResult,
	listForwardRecipients,
	prepareForward,
	revealForwardRow,
	scrollSharePanel,
	shareEntry,
} from "./forward.ts";
import {
	type Args,
	armWrite,
	chatBaseline,
	cleanup,
	emojiNames,
	installGuard,
	prepareWrite,
	smileyTrigger,
	videoRoot,
	writeResult,
} from "./interactions.ts";
import {
	clearComposer,
	composerPoint,
	giftItems,
	giftsSent,
	liveChat,
	liveState,
	pageFacts,
	prepareGift,
	readComposer,
} from "./live.ts";
import { cleanupNoteSlide, noteHoverPoint, noteSlideReceipt, prepareNoteSlide } from "./note.ts";
import {
	aiEntryPoint,
	aiSummary,
	authenticatedUser,
	chatRoot,
	cleanupChatMedia,
	currentVideo,
	guardPage,
	guardVideo,
	messageTarget,
	noteRoot,
	pixelsChatMedia,
	pixelsNote,
	prepareChatMedia,
	readChat,
	readContacts,
	readPageState,
	recallOutcome,
	recallPoint,
	scrollContainer,
	signedInName,
	userIdentity,
	userResults,
	verifyChatMedia,
} from "./readers.ts";
import { openSearchFilters, prepareSearchFilter, searchFilterState } from "./search.ts";

function checkChatDraft(): void {
	for (const editor of find(document, '[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]')) {
		if (editorHasDraft(editor))
			fail("draft_conflict", "Conversation has an existing draft", "The draft was preserved.");
	}
}

function prepareControl(args: Args) {
	guardPage();
	let button: HTMLElement;
	if (args.control === "chat.open") {
		if (find(document, '[data-e2e="im-dialog"]').length) return { already: true };
		button = one(find(document, '[data-e2e="im-entry"]'), "private chat entry");
	} else if (args.control === "chat.back") {
		checkChatDraft();
		button = one(
			find(
				document,
				'[data-e2e="im-dialog"] [class*="StackLayoutStackTitleBarbackBtn"], [data-e2e="im-dialog"] [data-e2e="chat-back"]',
			),
			"private chat back control",
		);
	} else if (args.control === "chat.close") {
		// Closing the panel discards whatever the composer holds. The comment in
		// app.ts claims this check exists here; it did not, so closing to read a
		// work could have thrown away an unsent message.
		checkChatDraft();
		// The title-bar close icon renders as two stacked copies at the same
		// spot; exactly one of them is the topmost hit target, so that one is the
		// control. A different count means the page changed and this fails closed.
		const candidates = find(
			document,
			'[data-e2e="im-dialog"] [data-e2e="im-close"],[data-e2e="im-dialog"] [class*="StackLayoutStackTitleBarcloseImPage"]',
		);
		if (candidates.length < 2) {
			button = one(candidates, "private chat close control");
		} else {
			const hittable = candidates.filter((element) => {
				const rect = element.getBoundingClientRect();
				const hit = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
				return !!hit && (hit === element || element.contains(hit));
			});
			button = one(hittable, "private chat close control");
		}
	} else {
		// Feed navigation must also work from a live slide, which has no work
		// identity by design; every other control needs a verified current work.
		if (args.control !== "feed.next" && args.control !== "feed.previous") guardVideo(args.video_id);
		switch (args.control) {
			case "comment.open": {
				// The list is often already rendered below the fold, so layout
				// presence (not visibility) decides whether opening is needed.
				if (
					findRendered(
						document,
						'[data-e2e="comment-list"],[data-e2e="comment-item"],.comment-input-container,.comment-input-inner-container',
					).length
				)
					return { already: true };
				// noteRoot() also matches the recommend feed's swiper, which is not a
				// post surface at all. Asking the route what this page is keeps the
				// note layout scoped to image posts and everything else on the work.
				const scope = routeKind(location.href).kind === "note" ? (noteRoot() ?? videoRoot()) : videoRoot();
				const cands = find(
					scope,
					// The recommended feed names this entry differently from the detail
					// page: the feed's icon is the only control that opens the panel
					// there, and leaving it out made every comment read on the feed
					// fail before it could look at anything.
					'[data-e2e="video-player-comment"],[data-e2e="note-comment"],[data-e2e="comment-button"],[data-e2e="feed-comment-icon"]',
				);
				button = one(cands, "comment entry");
				break;
			}
			case "comment.reply": {
				const row = commentRow(args.comment_id ?? "");
				// A row can contain its own replies, and each of those has a 回复
				// control too. Only nodes whose nearest row is this one belong to it,
				// otherwise a reply to a reply would be the control that gets clicked.
				const owned = (element: HTMLElement) => element.closest('[data-e2e="comment-item"]') === row;
				// The label is what separates the reply control from its neighbours:
				// the expand button reads 展开1条回复 and shares the button tag, and the
				// share/like controls sit beside it.
				const labelled = findRendered(row, '[data-e2e="comment-reply"],button,[role="button"],span,div').filter(
					(element) =>
						owned(element) &&
						(element.matches('[data-e2e="comment-reply"]') ||
							/^(回复|回复中|reply)$/i.test(clean(element.textContent))),
				);
				// Only the innermost labelled node is the control: an ancestor that
				// merely contains the label is a bigger box whose centre lands elsewhere.
				button = one(
					labelled.filter((element) => !labelled.some((other) => other !== element && element.contains(other))),
					"comment reply control",
				);
				break;
			}
			case "comment.activate":
				// The composer sits below a long comment list, so it is laid out far
				// outside the viewport on a detail page. Presence, not visibility, is
				// what identifies it: point() scrolls it into view before clicking.
				button = one(findRendered(document, ".comment-input-inner-container"), "comment editor activation area");
				if (clean(button.textContent) && clean(button.textContent) !== "留下你的精彩评论吧")
					fail("draft_conflict", "Comment composer already contains content");
				break;
			case "feed.next":
			case "feed.previous":
				// A work page carries the same arrows as the feed, so navigation works
				// from either. The arming step only has to confirm exactly one.
				button = one(
					find(document, `[data-e2e="video-switch-${args.control === "feed.next" ? "next" : "prev"}-arrow"]`),
					"feed navigation control",
				);
				break;
			default:
				fail("invalid_argument", "Unknown page control");
		}
	}
	installGuard(button, args.token, () => {
		guardPage();
		if (args.control === "chat.back") checkChatDraft();
		if (args.video_id) guardVideo(args.video_id);
	});
	return point(button, args.token);
}

// The follower modal has no stable class: its wrapper name changes per build.
// What is stable is the shape — a floating panel holding several user links and
// nothing else that does. The innermost element meeting that shape is the list.
function relationModal(): HTMLElement | null {
	const matches = [...document.querySelectorAll<HTMLElement>("div")].filter((element) => {
		const rect = element.getBoundingClientRect();
		if (rect.width < 200 || rect.height < 150) return false;
		// Only distinct profiles count. The page chrome is full of links to the
		// signed-in account, and counting those would pick the navigation bar as
		// the list.
		const links = [...element.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"]')].filter(
			(link) => !/\/user\/self/.test(link.getAttribute("href") ?? ""),
		);
		return new Set(links.map((link) => link.getAttribute("href"))).size >= 2;
	});
	// The innermost match is the list itself: every ancestor up to the page body
	// also contains those links, and taking one of those would include the
	// profile behind the modal.
	return matches.find((element) => !matches.some((other) => other !== element && other.contains(element))) ?? null;
}

async function recordAudio(seconds: number) {
	guardVideo();
	const video = currentVideo() as HTMLVideoElement & { captureStream?: () => MediaStream };
	if (!video.captureStream || !globalThis.MediaRecorder)
		fail("unsupported_media", "Chrome cannot capture this video audio track");
	const tracks = video.captureStream().getAudioTracks();
	if (!tracks.length) fail("unsupported_media", "Current video has no capturable audio track");
	const stream = new MediaStream(tracks.map((track) => track.clone()));
	const mime = ["audio/webm;codecs=opus", "audio/webm"].find((type) => MediaRecorder.isTypeSupported(type));
	if (!mime) fail("unsupported_media", "No supported audio recorder format");
	const recorder = new MediaRecorder(stream, { mimeType: mime });
	const chunks: Blob[] = [];
	try {
		const blob = await new Promise<Blob>((resolve, reject) => {
			let timer: ReturnType<typeof setTimeout>;
			recorder.ondataavailable = (event) => {
				if (event.data.size) chunks.push(event.data);
			};
			recorder.onerror = () => {
				clearTimeout(timer);
				reject({ code: "unsupported_media", message: "Audio recording failed" });
			};
			recorder.onstop = () => {
				clearTimeout(timer);
				resolve(new Blob(chunks, { type: mime }));
			};
			recorder.start();
			timer = setTimeout(() => recorder.stop(), seconds * 1000);
		});
		const bytes = new Uint8Array(await blob.arrayBuffer());
		let binary = "";
		for (let start = 0; start < bytes.length; start += 8192)
			binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
		return { mime, base64: btoa(binary), bytes: bytes.length };
	} finally {
		for (const track of stream.getTracks()) track.stop();
	}
}

// The works a profile shows, read from its own grid.
//
// Two things made the obvious selector wrong. find() keeps only visible elements,
// and the grid begins below the fold, so a profile with four works reported none.
// And the page ends with a strip of recommended works that also link to /video/,
// so taking every such link reported other people's videos as this account's.
function readProfileWorks() {
	const anchors = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')].filter((anchor) => {
		const box = anchor.getBoundingClientRect();
		// A work card is a tile; a footer recommendation is one line of text about
		// seventeen pixels tall. Size survives a class rename, and reading the whole
		// page instead reported other people's videos as this account's.
		return box.width >= 80 && box.height >= 80;
	});
	const works = new Map<string, { url: string; title: string }>();
	for (const anchor of anchors) {
		const id = /\/video\/(\d+)/.exec(anchor.getAttribute("href") ?? "")?.[1];
		if (!id || works.has(id)) continue;
		// The card renders its caption twice — once under the tile and once in the
		// hover layer — so the same sentence arrives repeated. Half of it is the
		// whole of it.
		const text = clean(anchor.textContent);
		const half = text.slice(0, Math.floor(text.length / 2));
		works.set(id, { url: anchor.href, title: half && text === half + half ? half : text });
	}
	return [...works.values()];
}

// The profile's own tabs are icon + count, with the label only in the parent's
// text. `user-favorite-tab` exists in the markup but is 0x0 when the page is not
// showing it, so a reader that trusts it clicks nothing.
function profileTabPoint(label: string) {
	const entries = [...document.querySelectorAll<HTMLElement>('[data-e2e="user-tab-icon"]')]
		.map((icon) => ({ icon, label: clean(icon.parentElement?.textContent) }))
		.filter((entry) => entry.label === label);
	const entry = one(entries, `profile tab "${label}"`);
	const box = entry.icon.getBoundingClientRect();
	if (box.width === 0 || box.height === 0) fail("selector_changed", `The "${label}" tab is not laid out`);
	return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

// What a tab is showing once it has loaded. The grid arrives a moment after the
// click, so a read taken immediately returns the work list that was there before.
function tabWorks() {
	return readProfileWorks();
}

let hoverPoint: { x: number; y: number } | null = null;

async function execute(operation: string, args: Args & { seconds: number }) {
	switch (operation) {
		case "status":
			return readPageState(args.include_text);
		case "auth.status": {
			const state = readPageState();
			return {
				login_required: state.login_required,
				verification_required: state.verification_required,
				user_id: state.unsupported_page ? null : authenticatedUser(),
				authenticated:
					!state.unsupported_page && !!authenticatedUser() && !state.login_required && !state.verification_required,
			};
		}
		case "self.name":
			return signedInName();
		case "page.facts":
			return pageFacts();
		case "live.state":
			return liveState();
		case "live.chat":
			return liveChat();
		case "live.composer":
			return { text: readComposer() };
		case "live.composer.point":
			return composerPoint();
		case "live.clear":
			return clearComposer();
		case "live.gifts":
			return { items: giftItems() };
		case "live.gift.prepare":
			return prepareGift(args.name ?? "", args.price ?? 0);
		case "live.gifts.sent":
			return { items: giftsSent(args.text ?? ""), scope: "loaded_dom" };
		case "video.info":
			guardVideo(args.video_id);
			return readPageState();
		case "note.capture":
			return pixelsNote(args.video_id, args.index ?? 1);
		case "note.slide.prepare":
			return prepareNoteSlide(args.video_id, args.direction === "previous" ? "previous" : "next", args.token);
		case "note.slide.hover":
			return noteHoverPoint(args.video_id);
		case "note.slide.result":
			return noteSlideReceipt(args.video_id, args.token);
		case "note.slide.cleanup":
			return cleanupNoteSlide(args.token);
		case "search.results":
			guardPage();
			return readPageState().search_results;
		case "search.filters.open":
			return openSearchFilters(args.query ?? "", args.token);
		case "search.filters.state":
			return searchFilterState(args.query ?? "");
		case "search.filters.select":
			return prepareSearchFilter(args.query ?? "", args.group ?? -1, args.choice ?? -1, args.token);
		case "search.users":
			guardPage();
			return userResults();
		case "comment.list":
			return readComments(args.video_id);
		case "comment.image.prepare":
			return prepareCommentImage(
				args.video_id,
				args.comment_id,
				args.token,
				args.file_name ?? "",
				args.file_size ?? 0,
				args.file_mime ?? "",
			);
		case "comment.image.preflight":
			return preflightCommentImage(args.token);
		case "comment.image.state":
			return commentImageState(args.video_id, args.token);
		case "comment.image.confirm.prepare":
			return prepareCommentImageConfirmation(
				args.video_id,
				args.comment_id,
				args.token,
				args.file_size ?? 0,
				args.file_sha256 ?? "",
			);
		case "comment.image.confirm.state":
			return commentImageConfirmationState(args.video_id, args.token);
		case "comment.image.cleanup":
			return cleanupCommentImage(args.token);
		case "comment.reply.state":
			return replyState(args.comment_id ?? "");
		case "comment.reveal":
			return pageTowardComment(args.comment_id ?? "");
		case "comment.author":
			return commentAuthor(args.comment_id ?? "");
		case "comment.expand": {
			if (!args.video_id || !args.comment_id) fail("invalid_argument", "Work and comment IDs are required");
			guardVideo(args.video_id);
			const button = expandControl(args.comment_id);
			if (!button) return null;
			installGuard(button, args.token, () => {
				guardVideo(args.video_id);
				if (expandControl(args.comment_id ?? "") !== button)
					fail("identity_mismatch", "Comment expansion target changed");
			});
			return point(button, args.token);
		}
		case "chat.list":
			return readContacts();
		case "chat.read":
			return readChat(args.conversation_id);
		case "chat.scroll": {
			// The conversation is virtualised: the list only holds the rows around
			// the viewport, so older messages exist nowhere in the DOM until the
			// scroller is moved up. The returned position lets the caller tell a
			// list that moved from one that had already reached the top.
			const { root } = chatRoot();
			const scroller = scrollContainer(root);
			const before = scroller.scrollTop;
			const delta = (args.index ?? 1) * (args.pixels ?? 1200);
			scroller.scrollTop = Math.max(0, before - delta);
			return { before, after: scroller.scrollTop, at_top: scroller.scrollTop <= 0 };
		}
		case "chat.capture.prepare":
			return prepareChatMedia(args.conversation_id, args.message_id ?? "", args.index ?? 1, args.token);
		case "chat.capture.pixels":
			return pixelsChatMedia(args.token);
		case "chat.capture.verify":
			return verifyChatMedia(args.token);
		case "chat.capture.cleanup":
			return cleanupChatMedia(args.token);
		case "chat.image.prepare":
			return prepareChatImage(
				args.conversation_id,
				args.token,
				args.file_name ?? "",
				args.file_size ?? 0,
				args.file_mime ?? "",
			);
		case "chat.image.state":
			return chatImageState(args.conversation_id, args.token);
		case "chat.image.preflight":
			return preflightChatImage(args.token);
		case "chat.image.confirm.prepare":
			return prepareChatImageConfirmation(
				args.conversation_id,
				args.token,
				args.file_name ?? "",
				args.file_size ?? 0,
				args.file_sha256 ?? "",
			);
		case "chat.image.baseline":
			return chatImageBaseline(args.conversation_id);
		case "chat.image.confirm.state":
			return chatImageConfirmationState(args.conversation_id, args.token, args.baseline);
		case "chat.image.cleanup":
			return cleanupChatImage(args.token);
		case "chat.reply.prepare": {
			// The page's own reply control is what makes the platform render
			// 回复消息 above the input; typing a quote manually would not.
			const chat = readChat(args.conversation_id);
			const index = Number(args.message_index);
			if (!Number.isInteger(index) || index < 1 || index > chat.messages.length)
				fail("invalid_argument", "Message index is outside the loaded window");
			const target = chat.messages[index - 1];
			if (target.direction !== "incoming" || target.failed || target.pending)
				fail("identity_mismatch", "Reply target is not a readable incoming message");
			// A row can hold more than one message (a share card and its caption), so
			// rows are not positionally aligned with the loaded message list. The
			// target is the single row whose text block carries this message's text.
			const rows = findRendered(chatRoot().root, '[class*="messageMessageBoxmessageBox"]');
			const wanted = clean(target.text);
			if (!wanted) fail("identity_mismatch", "Reply target has no readable text to locate its row");
			const candidates = rows.filter((row) => {
				const content = row.querySelector('[class*="MessageItemTextcontainer"]');
				return clean(content?.textContent).includes(wanted);
			});
			const row = one(candidates, "message row for the reply target");
			const rect = row.getBoundingClientRect();
			installGuard(row, args.token, () => {
				readChat(args.conversation_id);
			});
			// installGuard refuses any click whose target lost this marker, so the
			// row has to carry it: an unmarked target looks like a replaced control
			// and the guard cancels its own click.
			row.setAttribute("data-douyin-cli-control", args.token);
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), selector: "" };
		}
		case "chat.mention.prepare": {
			// The @ picker only renders for a group and only after the trigger is
			// typed, so the caller types it and then asks which entry to click. A
			// display name is user data: two members can share one, and mentioning
			// the wrong person is not recoverable, so an ambiguous match fails.
			const editor = one(
				find(chatRoot().root, '[data-e2e="msg-input"] [contenteditable="true"]'),
				"private message editor",
			);
			// The caller types the "@" trigger before asking for a picker entry, so
			// the composer holds exactly that trigger or an already chosen mention.
			// Both are this call's own work; anything else belongs to a draft.
			const own = editor.cloneNode(true) as HTMLElement;
			detachMentions(own);
			const residue = editorText(own).replace(/[​﻿@]/g, "").trim();
			const attached = own.querySelector('img,video,audio,[data-slate-void="true"]');
			if (residue || attached) fail("draft_conflict", "Composer already contains a draft");
			const wanted = clean(args.mention);
			if (!wanted) fail("invalid_argument", "Mention name is empty");
			const items = find(document, '[class*="MentionMentionItemcontainer"]').filter(
				(element) => !element.querySelector('[class*="MentionMentionItemcontainer"]'),
			);
			const exact = items.filter((element) => clean(element.textContent).replace(/^(群主|管理员)/, "") === wanted);
			const matches = exact.length ? exact : items.filter((element) => clean(element.textContent).includes(wanted));
			const item = one(matches, `group member matching ${wanted}`);
			const rect = item.getBoundingClientRect();
			installGuard(item, args.token, () => {
				readChat(args.conversation_id);
			});
			item.setAttribute("data-douyin-cli-control", args.token);
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2), selector: "" };
		}
		case "chat.mention.state": {
			const editor = document.querySelector('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]');
			const mentions = editor ? mentionNodes(editor).map(mentionName) : [];
			return { mentions };
		}
		case "emoji.prepare": {
			// Both composers offer the same smiley; a sticker is chosen from the
			// grid it opens. Each item's only identity is the platform's own name,
			// carried on the React element key ("[微笑]", "比心"), so the choice is
			// by name and never by position: positions move when the grid changes,
			// and picking the wrong sticker is a visible, irreversible message.
			const scope =
				args.conversation_id && document.querySelector('[data-e2e="im-dialog"] [data-e2e="msg-input"]')
					? chatRoot().root
					: one(findRendered(document, ".comment-input-inner-container,.comment-input-container"), "composer");
			return point(smileyTrigger(scope), args.token);
		}
		case "chat.witness": {
			const state = window.__douyinCLI;
			return { emoji: state?.emoji ?? null, dispatched: state?.dispatched ?? null };
		}
		case "emoji.panel": {
			const named = emojiNames();
			return { open: named.length > 0, names: named.map((entry) => entry.name) };
		}
		case "chat.baseline":
			return chatBaseline(args);
		case "emoji.dispatched": {
			// A sticker is sent by the click that chooses it, not by the send
			// button, so it never passes through the write guard that normally
			// records a dispatch. The caller reports it here instead, which keeps
			// the confirmation path the same for both kinds of send.
			if (!window.__douyinCLI) fail("identity_mismatch", "Send witness no longer exists");
			const witness = { dispatched: window.__douyinCLI.dispatched, emoji: window.__douyinCLI.emoji ?? null };
			window.__douyinCLI.dispatched = true;
			return witness;
		}
		case "emoji.dismiss": {
			// The sticker panel is a modal that covers the composer, so a failed
			// attempt leaves the next one unable to reach the smiley at all, and
			// Escape does not close it. A press on the message list does. The list
			// is chosen rather than the dialog's own corner because that corner is
			// the title bar, whose back control would leave the conversation.
			const root = chatRoot().root;
			const rows = findRendered<HTMLElement>(root, '[class*="messageMessageBoxmessageBox"]');
			const target = rows.at(-1) ?? root;
			const rect = target.getBoundingClientRect();
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
		}
		case "emoji.pick": {
			const wanted = clean(args.emoji);
			const named = emojiNames();
			const match = named.find((entry) => entry.name === wanted);
			if (!match) return { found: false, available: named.map((entry) => entry.name).slice(0, 24) };
			const items = findRendered<HTMLElement>(document, '[class*="emojiEmojiItememojiItem"]');
			const item = items[match.index];
			if (!item) return { found: false };
			// The grid is taller than the panel that holds it, so a sticker below
			// the fold has to be brought into view before its centre means
			// anything: the panel's own overlay would otherwise receive the press.
			item.scrollIntoView({ block: "nearest", inline: "nearest" });
			const rect = item.getBoundingClientRect();
			const x = Math.round(rect.left + rect.width / 2);
			const y = Math.round(rect.top + rect.height / 2);
			return { found: true, x, y };
		}
		case "chat.reply.menu": {
			// The floating panel only exists after a right-click; absence is a state,
			// not an error, so the caller can wait for it. A menu left over from an
			// earlier right-click is still in the DOM but not hit-testable, so only
			// a visible item counts.
			const reply = find(document, '[class*="MessageOperatePopBodydesc"]').find(
				(element) => clean(element.textContent) === "回复",
			);
			if (!reply) return {};
			const rect = reply.getBoundingClientRect();
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
		}
		case "chat.voice.prepare": {
			// A voice row is recognised by its play control and the duration label
			// beside it, not by a class name: the row's own class is per-build.
			const { root } = chatRoot();
			// Laid-out, not visible: a voice row scrolled above the viewport is still
			// in the loaded window, and it is exactly what has to be reached here.
			const rows = findRendered(root, '[class*="messageMessageBoxmessageBox"]');
			const voices = rows.filter(
				(row) => !!row.querySelector('[class*="MessageItemAudio"],[data-e2e="message-voice"]'),
			);
			// Rows are addressed by their position among the voice rows, which is the
			// same order the read reports them in; a row's own class is per-build and
			// its id lives on the fiber, not in the DOM.
			const index = args.index ?? 1;
			if (!Number.isInteger(index) || index < 1 || index > voices.length)
				fail("invalid_argument", `Voice row ${index} is not in the loaded window`);
			// The bubble, not the row: the row spans the whole conversation width and
			// its centre lands on empty space beside the message, where a right-click
			// opens the browser's own menu instead of the page's.
			const bubbleOf = (row: HTMLElement) =>
				row.querySelector<HTMLElement>('[class*="MessageItemAudioaudioBoxWrapper"]') ?? row;
			const reachable = (row: HTMLElement) => {
				const rect = bubbleOf(row).getBoundingClientRect();
				const x = Math.round(rect.left + rect.width / 2);
				const y = Math.round(rect.top + rect.height / 2);
				const hit = document.elementFromPoint(x, y);
				return !!hit && (hit === bubbleOf(row) || bubbleOf(row).contains(hit)) ? { x, y, rect } : null;
			};
			// The list is virtualised: older rows stay in the document but are laid
			// out far above the viewport, where a click cannot land. Rows are
			// addressed by their position among those that can actually be reached.
			const usable = voices.map((row) => ({ row, point: reachable(row) })).filter((entry) => entry.point);
			if (index > usable.length)
				fail("invalid_argument", `Only ${usable.length} voice row(s) are reachable; scroll the conversation first`);
			const rect = usable[index - 1].point?.rect as DOMRect;
			return {
				x: Math.round(rect.left + rect.width / 2),
				y: Math.round(rect.top + rect.height / 2),
				total: voices.length,
				index,
			};
		}
		case "ai.entry.point":
			return aiEntryPoint();
		case "ai.summary":
			return aiSummary();
		case "chat.detail.open":
			// Whether the panel is showing one conversation rather than the list.
			// The detail view is the only one with a message list. data-e2e="chat-page"
			// is not it: the private chat panel renders no such marker, so checking
			// that reported "on the list" while a conversation covered it — and the
			// next click landed on a message bubble instead of a row.
			return findRendered(document, '[class*="messageMessageListlist"],[data-e2e="message-list"]').length > 0;
		case "chat.recall.target":
			return messageTarget(args.message_id ?? "");
		case "chat.recall.point":
			return recallPoint();
		case "chat.recall.outcome":
			return recallOutcome();
		case "chat.voice.menu": {
			// The row's context menu offers 转文字 next to 回复 and 分享. Only a
			// visible entry counts: a menu left from an earlier right-click stays in
			// the DOM but is not hit-testable.
			// The entry flips to 收起文字 once a transcript exists, so both labels
			// address the same control; anything else means this is a different menu.
			const item = find(document, '[class*="MessageOperatePopBodydesc"]').find((element) =>
				["转文字", "收起文字"].includes(clean(element.textContent)),
			);
			if (!item) return {};
			const rect = item.getBoundingClientRect();
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
		}
		case "chat.voice.text": {
			// The transcript appears inside the voice row once the platform has run
			// its own recognition. Its first placement is asynchronous, so absence is
			// a state the caller waits on rather than an error.
			const { root } = chatRoot();
			const rows = findRendered(root, '[class*="messageMessageBoxmessageBox"]');
			const voices = rows.filter((row) => row.querySelector('[class*="MessageItemAudio"],[data-e2e="message-voice"]'));
			const texts = voices.map((row, position) => {
				// The transcript has no class of its own: the page appends it inside the
				// bubble, so it only shows up in the row's own text beside the duration
				// label. Everything that is not the duration is the transcript.
				const duration = row.querySelector<HTMLElement>('[class*="MessageItemAudioduration"]');
				const label = clean(duration?.textContent);
				const whole = clean(row.innerText);
				const rest = label ? whole.replace(label, "").trim() : whole;
				return {
					index: position + 1,
					transcript: rest || null,
					duration_seconds: label ? Number.parseFloat(label) || null : null,
					duration_label: label || null,
				};
			});
			return { voices: texts, transcribed: texts.filter((entry) => entry.transcript).length };
		}
		case "chat.reply.state": {
			const boxes = find(chatRoot().root, '[class*="MsgInputReferenceref_box"]');
			return { present: boxes.length === 1, quoted: boxes.length === 1 ? clean(boxes[0].textContent) : null };
		}
		case "chat.select": {
			const rows = readContacts();
			const matches = rows.flatMap((contact, index) => (contact.id === args.conversation_id ? [index] : []));
			const index = one(matches, "conversation with the requested ID");
			const row = find(document, '[data-e2e="im-dialog"] [data-e2e="conversation-item"]')[index];
			installGuard(row, args.token, () => {
				const current = find(document, '[data-e2e="im-dialog"] [data-e2e="conversation-item"]').indexOf(row);
				if (readContacts()[current]?.id !== args.conversation_id)
					fail("identity_mismatch", "Conversation row changed before selection");
			});
			return point(row, args.token);
		}
		case "comment.close-point": {
			// The panel's X has no role, label or stable class. What is stable is
			// its position: on the tab strip's own row, just past the strip's right
			// edge, and it is the first svg there that is not the tab list itself.
			const strip = [...document.querySelectorAll(".semi-tabs-bar")].find(
				(element) => element.getBoundingClientRect().width > 100,
			);
			if (!strip) return {};
			const box = strip.getBoundingClientRect();
			const y = box.top + box.height / 2;
			for (let x = box.right; x < box.right + 60; x += 3) {
				const hit = document.elementFromPoint(x, y);
				const svg = hit?.closest("svg") ?? (hit?.tagName === "svg" ? hit : null);
				if (!svg) continue;
				const rect = svg.getBoundingClientRect();
				if (rect.width < 8 || rect.height < 8) continue;
				return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
			}
			return {};
		}
		case "arm-comment-open": {
			// The caller clicks through a locator that waits for the control to
			// settle, so this only installs the guard and marks the target. It is
			// the same scope resolution prepareControl uses.
			const scope = routeKind(location.href).kind === "note" ? (noteRoot() ?? videoRoot()) : videoRoot();
			const candidates = find(
				scope,
				'[data-e2e="video-player-comment"],[data-e2e="note-comment"],[data-e2e="comment-button"],[data-e2e="feed-comment-icon"]',
			);
			if (!candidates.length) {
				if (
					findRendered(
						document,
						'[data-e2e="comment-list"],[data-e2e="comment-item"],.comment-input-container,.comment-input-inner-container',
					).length
				)
					return { already: true };
			}
			const button = one(candidates, "comment entry");
			button.setAttribute("data-douyin-cli-control", args.token);
			let blocked = false;
			const listener = (event: Event) => {
				if (!event.isTrusted || !(event.target instanceof Node)) return;
				if (!(event.target === button || button.contains(event.target))) return;
				try {
					guardPage();
					if (args.video_id) guardVideo(args.video_id);
					if (!button.isConnected || button.getAttribute("data-douyin-cli-control") !== args.token)
						fail("identity_mismatch", "Control changed");
				} catch {
					blocked = true;
					event.preventDefault();
					event.stopImmediatePropagation();
				}
			};
			for (const type of ["mousedown", "mouseup", "click"]) document.addEventListener(type, listener, true);
			window.__douyinCLIGuard = {
				cleanup: () => {
					for (const type of ["mousedown", "mouseup", "click"]) document.removeEventListener(type, listener, true);
				},
				state: { dispatched: false, blocked },
				token: args.token,
			};
			return { selector: `[data-douyin-cli-control="${args.token}"]` };
		}
		case "prepare-control":
			return prepareControl(args);
		case "video.play":
			guardVideo(args.video_id);
			await currentVideo().play();
			return readPageState();
		case "video.pause":
			guardVideo(args.video_id);
			currentVideo().pause();
			return readPageState();
		case "video.seek": {
			guardVideo(args.video_id);
			const element = currentVideo();
			const at = args.at;
			if (typeof at !== "number" || !Number.isFinite(at) || at < 0)
				fail("invalid_argument", "A seek needs a non-negative position in seconds");
			const duration = element.duration;
			if (!Number.isFinite(duration) || duration <= 0) fail("unsupported_media", "This work has no seekable duration");
			// A position past the end is not an error to be clamped silently: the
			// caller asked for a time this work does not have, and saying so is more
			// useful than returning a frame from somewhere else.
			if (at > duration) fail("invalid_argument", `--at is past the end of this work (${duration.toFixed(1)}s)`);
			element.currentTime = at;
			// seeked fires asynchronously; reading immediately reports the old time.
			await new Promise<void>((resolve) => {
				if (Math.abs(element.currentTime - at) < 0.25 && element.readyState >= 2) return resolve();
				const done = () => {
					element.removeEventListener("seeked", done);
					resolve();
				};
				element.addEventListener("seeked", done);
				setTimeout(done, 4000);
			});
			return readPageState();
		}
		case "video.audio":
			return recordAudio(args.seconds);
		case "user.relation.prepare": {
			// The counts sit above the profile's tabs; the label is what identifies
			// them, since their classes are per-build.
			const wanted = args.relation === "followers" ? "粉丝" : "关注";
			const labels = find(document, "div,span,a").filter(
				(element) => element.childElementCount === 0 && clean(element.textContent) === wanted,
			);
			const label = one(labels, `${wanted} label`);
			const rect = label.getBoundingClientRect();
			return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
		}
		case "user.relation": {
			// The list renders in a modal over the profile. Only links inside that
			// modal count: the page behind it also carries user links, and mixing
			// them would report the video authors as followers.
			const modal = relationModal();
			if (!modal) return { users: [], open: false };
			const seen = new Set<string>();
			const users: { id: string; name: string; follows_back: boolean }[] = [];
			for (const anchor of find<HTMLAnchorElement>(modal, 'a[href*="/user/"]')) {
				// anchors carry protocol-relative hrefs that the browser resolves to
				// absolute ones, but the attribute itself still reads "//www.douyin.com".
				const match = /^(?:https?:)?\/\/(?:www\.)?douyin\.com\/user\/([A-Za-z0-9_-]{5,300})/.exec(anchor.href);
				if (!match || match[1] === "self" || seen.has(match[1])) continue;
				seen.add(match[1]);
				// The row is the anchor's nearest ancestor that also holds the name and
				// the follow control; the anchor itself wraps only the avatar.
				const row = anchor.closest<HTMLElement>('[class*="Olx"],li,div[class]')?.parentElement ?? anchor;
				const text = clean(row.innerText);
				const name = text.split(" ")[0] ?? "";
				users.push({
					id: match[1],
					name,
					// 回关 means this account follows you and you do not follow back yet;
					// it is the platform's own word for a one-way relationship.
					follows_back: /回关/.test(text),
				});
			}
			return { users, open: true };
		}
		case "user.relation.scroll": {
			const modal = relationModal();
			if (!modal) return { moved: false };
			const scroller =
				[...modal.querySelectorAll("*")].find((element) => {
					const style = getComputedStyle(element);
					return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 10;
				}) ?? modal;
			const before = scroller.scrollTop;
			scroller.scrollBy(0, args.pixels ?? 600);
			return { before, after: scroller.scrollTop, moved: scroller.scrollTop !== before };
		}
		case "comment.delete.open": {
			// Find this account's own comment by its exact id, hover it so the row
			// reveals its menu button, and open that menu. Nothing is deleted here;
			// the click on 删除评论 is a separate, armed action.
			guardVideo(args.video_id);
			const self = authenticatedUser();
			if (!self) fail("login_required", "Deleting a comment needs the signed-in identity");
			const row = findRendered(document, '[data-e2e="comment-item"]').find(
				(element) => commentID(element) === args.comment_id,
			);
			// A row that is not loaded cannot be checked, and acting on an id the page
			// never showed is how the wrong comment gets deleted.
			if (!row)
				fail("not_found", "That comment is not in the loaded list", "Scroll it into view or open its work first.");
			const comments = readComments(args.video_id ?? "");
			const record = comments.find((comment) => comment.id === args.comment_id);
			// The page does not ask for confirmation, so this check is the only thing
			// standing between the command and deleting someone else's comment.
			if (!record || !record.mine)
				fail(
					"identity_mismatch",
					"That comment is not this account's own",
					JSON.stringify({ comment_id: args.comment_id }),
				);
			const box = row.getBoundingClientRect();
			if (box.width === 0 || box.height === 0) fail("selector_changed", "The comment row is not laid out");
			hoverPoint = { x: Math.round(box.x + box.width * 0.5), y: Math.round(box.y + box.height / 2) };
			return { hover: hoverPoint, comment_id: record.id, text: record.text };
		}
		case "comment.delete.menu": {
			// Called after the caller has hovered the row: the menu button only exists
			// while it is hovered, so it cannot be found before that.
			const row = findRendered(document, '[data-e2e="comment-item"]').find(
				(element) => commentID(element) === args.comment_id,
			);
			if (!row) fail("selector_changed", "The comment row is no longer rendered");
			const dots = [...row.querySelectorAll<HTMLElement>("*")].filter((element) => {
				const text = clean(element.textContent);
				const rect = element.getBoundingClientRect();
				return (text === "..." || text === "…") && rect.width > 0 && rect.height > 0 && !element.childElementCount;
			});
			const button = one(dots, "comment menu button");
			return point(button, args.token ?? "comment-menu");
		}
		case "comment.delete.item": {
			// The delete entry in the open menu. Its text is the only stable handle:
			// the menu has no data-e2e and its classes are per-build.
			const items = [...document.querySelectorAll<HTMLElement>("div,span,li,button")].filter((element) => {
				if (element.childElementCount) return false;
				const text = clean(element.textContent);
				if (text !== "删除评论") return false;
				const rect = element.getBoundingClientRect();
				return rect.width > 0 && rect.height > 0;
			});
			if (!items.length) fail("selector_changed", "The delete entry is not in the open menu");
			return point(items[items.length - 1] as HTMLElement, args.token ?? "comment-delete");
		}
		case "comment.delete.state": {
			// Whether the row is still there. Deletion happens without a confirmation,
			// so the only proof is that the row is gone.
			const present = findRendered(document, '[data-e2e="comment-item"]').some(
				(element) => commentID(element) === args.comment_id,
			);
			return { present, comment_id: args.comment_id };
		}
		case "ai.prepare": {
			// The composer is a plain contenteditable rather than a Draft editor, and it
			// is the only visible one on the page. Focusing it here is what makes the
			// following keystrokes land in it instead of nowhere.
			const editor = [...document.querySelectorAll<HTMLElement>(".douyin-chat-editor,[contenteditable='true']")].find(
				(element) => {
					const box = element.getBoundingClientRect();
					return box.width > 100 && box.height > 10;
				},
			);
			if (!editor) return { ready: false };
			editor.focus();
			return { ready: true };
		}
		case "ai.answer": {
			// The answer is whatever the conversation area holds after the question.
			// Reading the whole page would include the nav and the previous answers, so
			// the block that contains the question is used as the boundary.
			const asked = String((args as { question?: unknown }).question ?? "").trim();
			const body = document.body.innerText ?? "";
			const at = asked ? body.indexOf(asked) : -1;
			const answer = at >= 0 ? body.slice(at + asked.length).trim() : body.trim();
			const links = [...document.querySelectorAll<HTMLAnchorElement>('a[href*="/video/"]')]
				.map((anchor) => {
					const id = /\/video\/(\d+)/.exec(anchor.getAttribute("href") ?? "")?.[1];
					return id ? { id, text: clean(anchor.textContent).slice(0, 80) } : null;
				})
				.filter((entry): entry is { id: string; text: string } => entry !== null);
			const unique = new Map<string, { id: string; text: string }>();
			for (const link of links) if (!unique.has(link.id)) unique.set(link.id, link);
			return { question: asked, answer, links: [...unique.values()] };
		}
		case "comment.writable": {
			// Whether this work accepts a new comment, asked before anything is typed.
			//
			// A work whose author turned comments off still shows the existing ones, so
			// "the list has rows" says nothing about whether posting is possible. The
			// composer is the answer: Douyin does not render it at all when the author
			// has closed comments, and the publish icon stays display:none when the box
			// is empty. Without this check the send path filled nothing, measured a
			// zero-size control, waited out its whole confirmation window and reported
			// delivery_uncertain — which reads like "it may have gone through" when in
			// fact nothing could ever have been sent.
			const composer =
				document.querySelector<HTMLElement>(".comment-input-container,.comment-input-inner-container") ??
				document.querySelector<HTMLElement>(".public-DraftEditor-content");
			if (!composer) {
				const text = (document.body.innerText ?? "").slice(-4000);
				return {
					writable: false,
					reason: /关闭评论|无法评论|禁止评论|评论功能已?关闭/.test(text)
						? "The author has turned comments off for this work"
						: "This page renders no comment composer",
				};
			}
			const box = composer.getBoundingClientRect();
			if (box.width === 0 || box.height === 0)
				return { writable: false, reason: "The comment composer is not laid out" };
			return { writable: true, reason: null };
		}
		case "profile.works":
			// Deliberately no guardVideo: this runs on a profile page, where there is
			// no work to guard, and the guard's refusal was reported as an identity
			// mismatch rather than as a profile that had simply not rendered yet.
			return { works: readProfileWorks().length };
		case "profile.tab.point":
			return profileTabPoint(args.target ?? "收藏");
		case "profile.tab.works":
			return { works: tabWorks() };
		case "user.get": {
			const id = userIdentity(args.user_id);
			// The page nests two matches: an outer container that spans the whole profile
			// and the header itself. The innermost is the header; taking the outer one
			// would make visible_text the entire page.
			const matches = find(document, '[data-e2e="user-info"],[data-e2e="user-detail"]');
			const root = one(
				matches.filter((element) => !matches.some((other) => other !== element && element.contains(other))),
				"user profile header",
			);
			const lines = root.innerText
				.split("\n")
				.map((line) => clean(line))
				.filter(Boolean);
			const firstLine = lines[0] ?? "";
			const lastLine = lines.length > 1 ? (lines.at(-1) ?? "") : "";
			return {
				id,
				url: `https://www.douyin.com/user/${id}`,
				// The header carries the name and the signature as plain text in the page's
				// own per-build classes, so they are read from the header's text: the
				// first line is the name and the last paragraph is the signature.
				name: clean(root.querySelector('[data-e2e="user-title"],[data-e2e="user-name"]')?.textContent) || firstLine,
				bio: clean(root.querySelector('[data-e2e="user-signature"]')?.textContent) || lastLine,
				visible_text: root.innerText.slice(0, 5000),
				// The work grid starts below the fold, and find() keeps only what is
				// visible, so a profile reporting four works returned none. Laid out is
				// the right test here: a card the reader has to scroll to is still a work
				// this account published.
				//
				// The page also ends with a strip of recommended works that link to
				// /video/ too, so filtering by the grid's own container is what keeps the
				// list from reporting other people's videos as this account's.
				videos: readProfileWorks(),
			};
		}
		case "scroll": {
			guardPage();
			let root: Element;
			if (args.target === "comments") {
				guardVideo(args.video_id);
				// On the standalone work page the comment list has no scroller of
				// its own: it is as tall as its content and the document scrolls.
				// A dedicated container is used only where the page actually has one.
				// The work page keeps its scrolling on a route container rather than the
				// document: the document itself is exactly viewport height, so scrolling
				// it moves nothing and every extra pass reads the same rows.
				const scrollable = (element: Element) => {
					const style = getComputedStyle(element);
					return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight + 10;
				};
				const own = find(
					document,
					'[data-e2e="comment-list"],.comment-list-container,.route-scroll-container,[class*="route-scroll"]',
				).find(scrollable);
				root =
					own ?? find(document, "body *").find(scrollable) ?? document.scrollingElement ?? document.documentElement;
			} else {
				const note = noteRoot();
				root = note ? scrollContainer(note) : (document.scrollingElement ?? document.documentElement);
			}
			const before = root.scrollTop;
			root.scrollBy(0, args.pixels);
			return {
				before,
				after: root.scrollTop,
				height: root.scrollHeight,
				viewport: root.clientHeight,
			};
		}
		case "prepare-write":
			return prepareWrite(args);
		case "arm-write":
			return armWrite(args);
		case "write-result":
			return writeResult(args);
		case "forward.open": {
			// Hover reveals the panel; a plain click does not, because the entry
			// only carries mouse-enter handlers.
			const entry = shareEntry();
			const rect = entry.getBoundingClientRect();
			return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, selector: "hover" };
		}
		case "forward.list":
			return { recipients: listForwardRecipients() };
		case "forward.scroll":
			return scrollSharePanel(args.pixels ?? 300);
		case "forward.reveal":
			return revealForwardRow(args.recipient_id ?? "");
		case "forward.prepare":
			return prepareForward(args);
		case "forward.arm":
			return armForward(args);
		case "forward.result":
			return forwardResult(args);
		case "cleanup":
			return cleanup();
		default:
			fail("invalid_argument", `Unknown browser operation: ${operation}`);
	}
}

export async function call(operation: string, args: Args & { seconds: number }) {
	try {
		return { data: await execute(operation, args) };
	} catch (error: unknown) {
		const value = error as Partial<PageError>;
		return {
			error: {
				code: typeof value?.code === "string" ? value.code : "selector_changed",
				message: typeof value?.message === "string" ? value.message : "Browser operation failed",
				hint: value?.hint ?? "",
			},
		};
	}
}
