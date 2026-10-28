import {
	clean,
	fail,
	find,
	findRendered,
	getterValue,
	inherited,
	one,
	own,
	reactProps,
	routeKind,
	scalarID,
	videoID,
	visible,
} from "./dom.ts";

const privateArea = '[data-e2e="im-dialog"],[data-e2e="conversation-item"]';

export interface Video {
	id: string | null;
	url: string | null;
	title: string;
	author: string;
	// The account behind the work, as a stable id. A display name is not one.
	author_id: string | null;
	time: number;
	duration: number | null;
	paused: boolean;
	muted: boolean;
	ready_state: number;
	viewport_intersects: boolean;
}

// An image post shares the route id with a video but has no player. Only
// observable fields are reported; an unreadable slide index stays null.
export interface Note {
	id: string;
	url: string;
	title: string;
	author: string;
	images: { src: null; source_available: boolean; label: string | null; ready: boolean }[];
	slide: { index: number | null; count: number | null };
}

export function currentVideo(): HTMLVideoElement {
	return one(
		find<HTMLVideoElement>(document, "video").filter((element) => !element.closest(privateArea)),
		"visible video",
	);
}

// Image posts render their slides inside a swiper-like container. The index is
// only reported when a single indicator marks the active slide; otherwise the
// reader reports what it can count and leaves the index unknown.
// User search results are read from profile anchors. The card container is not
// reliably identifiable, so the anchor is the only trusted part; the signed-in
// profile link is excluded because it is not a search result.
export function userResults() {
	const seen = new Set<string>();
	// The signed-in account link lives in site chrome, not in the results.
	const self = authenticatedUser();
	const selfLink = find<HTMLAnchorElement>(document, ".tab-user_self a[href]").filter(
		(element) => visible(element) && clean(element.textContent) === "我的",
	);
	const selfID =
		self ?? (selfLink.length === 1 ? /^\/user\/([^/]+)/.exec(new URL(selfLink[0].href).pathname)?.[1] : null);
	const results = find<HTMLAnchorElement>(document, 'a[href*="/user/"]').filter(
		(element) => !element.closest(`${privateArea},.tab-user_self,[data-e2e="header"]`),
	);
	// Only anchors inside recognized cards are trusted; the card container is
	// not stable, so the caller is told when the reader had to fall back.
	const scoped = results.filter((element) =>
		element.closest('[data-e2e="user-card"],[data-e2e="search-user-card"],[data-e2e="user-item"]'),
	);
	const candidates = scoped.length ? scoped : results;
	return candidates
		.flatMap((element) => {
			const url = new URL(element.href, location.href);
			if (url.origin !== "https://www.douyin.com" || url.username || url.password) return [];
			const match = /^\/user\/([A-Za-z0-9_-]{5,300})\/?$/.exec(url.pathname);
			if (!match) return [];
			const secUid = match[1];
			if (selfID && secUid === selfID) return [];
			if (seen.has(secUid)) return [];
			seen.add(secUid);
			const card = element.closest<HTMLElement>(
				'[data-e2e="user-card"],[data-e2e="search-user-card"],li,[class*="card"]',
			);
			const name = clean(element.textContent).replace(/^@\s*/, "");
			const signature = card?.querySelector('[data-e2e="user-signature"],[class*="signature"]');
			return [
				{
					sec_uid: secUid,
					url: `https://www.douyin.com/user/${secUid}`,
					name: name || clean(card?.textContent).slice(0, 120),
					signature: clean(signature?.textContent) || null,
				},
			];
		})
		.filter((row) => row.name || row.signature);
}

export function noteRoot(): HTMLElement | undefined {
	const players = find<HTMLElement>(document, ".note-detail-container").filter(
		(element) => !element.closest(privateArea),
	);
	if (players.length > 1) fail("identity_mismatch", "Image post player is ambiguous");
	if (players.length === 1) return players[0];
	return find<HTMLElement>(
		document,
		'[data-e2e="note-detail"],[data-e2e="slide-container"],[class*="swiper-container"]',
	).find((element) => !element.closest(privateArea));
}

// The nearest ancestor that can actually scroll; the note layout does not use
// the document scroller, and its wrapper classes are per-build obfuscated.
export function scrollContainer(fallback: Element): Element {
	for (let node: Element | null = fallback; node && node !== document.documentElement; node = node.parentElement) {
		const style = getComputedStyle(node);
		if (/(auto|scroll)/.test(style.overflowY) && node.scrollHeight > node.clientHeight) return node;
	}
	return document.scrollingElement ?? document.documentElement;
}

function readNote(id: string): Note {
	const root = noteRoot();
	const scope = root ?? document;
	const detail = root?.closest('[data-e2e="note-detail"]') ?? root ?? document;
	// Slides that have not painted yet are still the post's slides; they are
	// reported with ready:false rather than dropped from the count.
	const images = find<HTMLImageElement>(scope, "img")
		.filter((element) => !element.closest(`${privateArea},[data-e2e="comment-item"]`))
		.map((element) => ({
			src: null,
			source_available: !!(element.currentSrc || element.getAttribute("src")),
			label: clean(element.getAttribute("alt") || element.getAttribute("aria-label")) || null,
			ready: element.complete && element.naturalWidth > 0,
		}));
	const indicators = find(scope, '[class*="swiper-pagination"] [class*="active"],[data-e2e="slide-indicator"] .active');
	const counters = find(scope, "div").flatMap((element) => {
		if (element.children.length !== 3) return [];
		const [left, separator, right] = [...element.children].map((child) => clean(child.textContent));
		if (!/^\d+$/.test(left) || separator !== "/" || !/^\d+$/.test(right)) return [];
		const index = Number(left);
		const count = Number(right);
		return Number.isSafeInteger(index) && Number.isSafeInteger(count) && index >= 1 && index <= count
			? [{ index, count }]
			: [];
	});
	const indicator = indicators.length === 1 ? Number(indicators[0].textContent?.trim()) : Number.NaN;
	const numericIndicators = indicators
		.map((element) => Number(element.textContent?.trim()))
		.filter((value) => Number.isInteger(value) && value > 0);
	const conflicting =
		counters.length > 1 ||
		numericIndicators.length > 1 ||
		(counters.length === 1 && Number.isInteger(indicator) && indicator > 0 && indicator !== counters[0].index);
	const active = conflicting
		? Number.NaN
		: counters.length === 1
			? counters[0].index
			: indicators.length === 1
				? indicator
				: Number.NaN;
	const total = conflicting
		? null
		: counters.length === 1
			? counters[0].count
			: find(scope, '[class*="swiper-pagination"] [class*="bullet"]').length || null;
	const title = detail.querySelector(
		'[data-e2e="video-desc"],[data-e2e="note-desc"],[data-e2e="video-title"],[class*="video-info-detail"]',
	);
	return {
		id,
		url: `https://www.douyin.com/note/${id}`,
		title: clean(title?.textContent),
		author: clean(detail.querySelector('a[href*="/user/"]')?.textContent).replace(/^@\s*/, ""),
		images,
		slide: { index: Number.isInteger(active) && active > 0 ? active : null, count: total },
	};
}

export function readPageState(includeText = false) {
	const supported = location.origin === "https://www.douyin.com";
	if (!supported) {
		return {
			url: null,
			title: null,
			page_kind: "unsupported",
			unsupported_page: true,
			login_required: false,
			verification_required: false,
			private_chat_visible: false,
			video: null as Video | null,
			note: null as Note | null,
			video_selection: { candidates: 0, ambiguous: false },
			search_results: [] as ReturnType<typeof searchResults>,
		};
	}
	const text = find(document, "body *")
		.filter((element) => !element.childElementCount && !element.closest(privateArea))
		.map((element) => clean(element.textContent))
		.filter(Boolean)
		.join("\n")
		.slice(-9000);
	const login = /扫码登录|验证码登录|登录后即可|手机扫码登录/.test(text);
	const verification =
		find(document, '#captcha_container,[id^="captcha_container"],[data-e2e="captcha-container"]').length > 0 ||
		/请完成下方验证|请完成验证|安全验证|拖动滑块/.test(text);
	// Opening the comment panel scrolls the work out of view, but it is still the
	// page's current work. Layout presence, not the viewport, identifies it.
	const videos = findRendered<HTMLVideoElement>(document, "video").filter((element) => !element.closest(privateArea));
	let video: Video | null = null;
	let conflict = false;
	// The feed keeps the next video preloaded in a second element, so more than
	// one <video> is normal. The active one is the feed's current item. On an
	// image post the player is hidden or absent, so no active video existing is
	// legitimate there and the note path takes over.
	const noteHeading = routeKind(location.href).kind === "note";
	const onScreen = videos.filter((element) => {
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});
	// The recommended feed also serves live streams, and the slider keeps the
	// neighbouring slides laid out off-screen. Only a live slide occupying the
	// viewport makes this page live; an off-screen one would mark the next real
	// work as unreadable. The slide is identified by its own container rather
	// than by a video inside it: a live player is not always a <video>, but the
	// feed always marks the slide itself.
	const liveSlides = findRendered<HTMLElement>(document, '[data-e2e="feed-live"]').filter((element) => {
		if (element.closest(privateArea)) return false;
		const rect = element.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight;
	});
	const live = !noteHeading && liveSlides.length > 0;
	const works = live ? [] : onScreen.filter((element) => !element.closest('[data-e2e="feed-live"]'));
	// A live slide is a real stop in the feed, so moving off it has to be
	// verifiable too. It has no work id, but the broadcast is linked to its
	// host's stable account, and that is enough to tell two slides apart.
	const liveID =
		/(?:^|\/)user\/([A-Za-z0-9_-]{8,})/.exec(
			liveSlides[0]?.querySelector("a[href]")?.getAttribute("href") ?? "",
		)?.[1] ?? null;
	const active = noteHeading
		? undefined
		: (works.find((element) => element.closest('[data-e2e="feed-active-video"]')) ??
			(works.length === 1 ? works[0] : undefined));
	if (active) {
		const element = active;
		const rect = element.getBoundingClientRect();
		const root =
			element.closest('[data-e2e="feed-active-video"],[data-e2e="video-detail"]') ??
			element.closest('[data-e2e="player-container"]');
		const playerID = /(?:^|\s)video_(\d+)(?:\s|$)/.exec(
			element.closest('[data-e2e="player-container"]')?.className ?? "",
		)?.[1];
		const containerID =
			root?.getAttribute("data-aweme-id") ??
			root?.getAttribute("data-video-id") ??
			/(?:^|\s)video_(\d+)(?:\s|$)/.exec(root?.className ?? "")?.[1];
		const routeID = videoID(location.href);
		const identities = [playerID, containerID, routeID].filter(Boolean);
		conflict = new Set(identities).size > 1;
		const id = conflict ? null : identities[0] || null;
		const title = root?.querySelector(
			'[data-e2e="video-desc"],[data-e2e="video-title"],[class*="detail-video-info"],[class*="video-info-detail"]',
		);
		// The first profile link in the card is the avatar; the one carrying the
		// name is a later sibling. Taking the first by text alone returned an empty
		// string, which made "who posted this" unanswerable from a read.
		// The name is not an identity either: the account id is read from the same
		// link so a caller can act on the author, not on a display name.
		const authorLinks = [...(root?.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"]') ?? [])];
		const authorLink = authorLinks.find((anchor) => clean(anchor.textContent).length > 0) ?? authorLinks[0];
		const authorID = authorLink ? (/\/user\/([^/?#]+)/.exec(new URL(authorLink.href).pathname)?.[1] ?? null) : null;
		video = {
			id,
			url: id ? `https://www.douyin.com/video/${id}` : null,
			title: clean(title?.textContent),
			author: clean(authorLink?.textContent).replace(/^@\s*/, ""),
			// "self" is the platform's alias on the owner's own work, not an id.
			author_id: authorID && authorID !== "self" ? authorID : null,
			time: element.currentTime,
			duration: Number.isFinite(element.duration) ? element.duration : null,
			paused: element.paused,
			muted: element.muted,
			ready_state: element.readyState,
			viewport_intersects:
				rect.width > 0 &&
				rect.height > 0 &&
				rect.bottom > 0 &&
				rect.right > 0 &&
				rect.top < innerHeight &&
				rect.left < innerWidth,
		};
	}
	// An image post has no <video>; its identity comes from the /note/ route.
	const route = routeKind(location.href);
	const note = !video && route.kind === "note" && route.id ? readNote(route.id) : null;
	const url = new URL(location.href);
	// Keep only parameters that change what the page is; tracking parameters
	// are dropped. `type` selects the search result kind.
	for (const key of [...url.searchParams.keys()]) {
		if (!["modal_id", "aweme_id", "recommend", "type"].includes(key)) url.searchParams.delete(key);
	}
	return {
		url: url.href,
		title: document.title,
		page_kind: video?.id
			? "video"
			: note
				? "note"
				: location.pathname.startsWith("/search/")
					? "search"
					: live
						? "live"
						: // A profile commits its route before it renders, so the header is what
							// says the page is ready rather than the URL alone.
							location.pathname.startsWith("/user/") &&
								find(document, '[data-e2e="user-info"],[data-e2e="user-detail"]').length > 0
							? "profile"
							: "page",
		unsupported_page: false,
		login_required: login,
		verification_required: verification,
		private_chat_visible: find(document, '[data-e2e="im-dialog"]').length > 0,
		video,
		note,
		// Candidates counts loaded elements; ambiguity means the active one could
		// not be resolved or its identities disagreed.
		// A note page has no active video by design; only a video page without
		// one is ambiguous.
		video_selection: {
			candidates: works.length,
			ambiguous: noteHeading || live ? false : !active || conflict,
		},
		// What the feed is sitting on right now, whichever kind of slide it is.
		// Movement between slides is checked against this, because a work id alone
		// cannot describe a live stop.
		slide: live
			? { kind: "live", id: liveID }
			: { kind: video?.id ? "video" : note ? "note" : "page", id: video?.id ?? note?.id ?? null },
		search_results: location.pathname.startsWith("/search/") ? searchResults() : [],
		...(includeText ? { visible_text: text } : {}),
	};
}

function searchResults() {
	const used = new Set<string>();
	return find(
		document,
		'.search-result-card,[data-e2e="search-card"],[data-e2e="search-result"],a[href*="/video/"],a[href*="modal_id="]',
	).flatMap((element) => {
		const anchor = element.matches("a")
			? (element as HTMLAnchorElement)
			: element.querySelector<HTMLAnchorElement>('a[href*="/video/"],a[href*="modal_id="]');
		const id =
			videoID(anchor?.href ?? "") ??
			element.getAttribute("data-aweme-id") ??
			/waterfall_item_(\d+)/.exec(element.closest('[id^="waterfall_item_"]')?.id ?? "")?.[1];
		if (!id || used.has(id)) return [];
		used.add(id);
		const card = element.closest('.search-result-card,[data-e2e="search-card"]') ?? element;
		return [{ id, url: `https://www.douyin.com/video/${id}`, title: clean(card.textContent) }];
	});
}

export function guardPage() {
	const state = readPageState();
	if (state.unsupported_page) fail("unsupported_page", "Owned tab is outside www.douyin.com");
	if (state.verification_required) {
		fail("verification_required", "Douyin requires human verification", "Complete it in headed Chrome.");
	}
	if (state.login_required) fail("login_required", "Douyin requires login", "Run auth login.");
	return state;
}

// Either a video or an image post satisfies a work target; the requested ID
// must match whichever kind the page actually is.
export function guardVideo(id?: string) {
	const state = guardPage();
	if (state.private_chat_visible) fail("identity_mismatch", "Private chat covers the work");
	if (state.page_kind === "live")
		fail("unsupported_page", "The feed is on a live stream, not a work", "Advance the feed to the next work.");
	const workID = state.video?.id ?? state.note?.id ?? null;
	if (!workID || state.video_selection.ambiguous || (id && workID !== id)) {
		fail("identity_mismatch", "Current work identity is missing, ambiguous or different");
	}
	return state;
}

export interface Contact {
	id: string | null;
	name: string;
	type: string;
	unread: boolean;
}

// A group row renders no participant sec_uid, so its identity comes from the
// conversation object held by the nearest React fiber above the row. Only
// numeric platform ids are accepted, and the walk fails on disagreement: a
// virtualised list ancestor carries the item once, but an ambiguous chain must
// not pick one row's identity for all of them. The open conversation's header
// holds the same record under `curConversation` instead of `conversation`.
function fiberConversationID(element: HTMLElement): string | null {
	const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
	const found = new Set<string>();
	let fiber = key ? own(element, key) : undefined;
	for (let depth = 0; depth < 6 && fiber; depth++, fiber = own(fiber, "return")) {
		const props = own(fiber, "memoizedProps");
		for (const name of ["conversation", "curConversation"]) {
			const conversation = own(props, name);
			const id = scalarID(inherited(conversation, "id"));
			if (id && /^\d{1,64}$/.test(id)) found.add(id);
		}
	}
	return found.size === 1 ? `native:${[...found][0]}` : null;
}

// A delivered row carries its platform id only on the message object behind
// the React fiber, not in the DOM. Without it a group row has no stable id at
// all, so a send can never be matched to the row it produced and every group
// message ends up uncertain.
function fiberMessage(element: HTMLElement): { id: string | null; created_at: string | null } {
	const key = Object.getOwnPropertyNames(element).find((name) => name.startsWith("__reactFiber$"));
	let fiber = key ? own(element, key) : undefined;
	for (let depth = 0; depth < 8 && fiber; depth++, fiber = own(fiber, "return")) {
		const message = own(own(fiber, "memoizedProps"), "message");
		if (!message) continue;
		let id: string | null = null;
		for (const field of ["serverId", "id", "msgId"]) {
			const value = scalarID(inherited(message, field));
			if (value && /^\d{1,64}$/.test(value)) {
				id = value;
				break;
			}
		}
		if (!id) continue;
		// The page's own creation time, not the wall clock of any machine here:
		// it is the only ordering that can say a row appeared after this send.
		// The live page hands back a Date, while fixtures and older shapes use a
		// number or an ISO string, so all three are read without invoking anything
		// beyond the Date's own accessor.
		const raw = inherited(message, "createdAt") ?? inherited(message, "createTime");
		const created =
			Object.prototype.toString.call(raw) === "[object Date]"
				? new Date((raw as Date).getTime())
				: typeof raw === "number" || typeof raw === "string"
					? new Date(raw)
					: null;
		const created_at = created && !Number.isNaN(created.getTime()) ? created.toISOString() : null;
		return { id, created_at };
	}
	return { id: null, created_at: null };
}

function identity(element: HTMLElement, header = false): string | null {
	const native = element.getAttribute("data-conversation-id") ?? element.getAttribute("data-conversation-short-id");
	if (native) return `native:${native}`;
	const ids = new Map<string, Set<string>>();
	const inspect = (value: unknown) => {
		// _toParticipantSecUserId is the only stable id a direct chat renders on
		// the live page; without it a conversation row has no identity at all.
		for (const field of [
			"conversationId",
			"conversationShortId",
			"groupId",
			"secUid",
			"_toParticipantSecUserId",
			"userId",
		]) {
			const id = scalarID(own(value, field));
			if (!id) continue;
			const set = ids.get(field) ?? new Set<string>();
			set.add(id);
			ids.set(field, set);
		}
	};
	const visit = (props: unknown, depth: number) => {
		if (depth > 3) return;
		inspect(props);
		for (const key of ["conversation", "conversationInfo", "conversationData"]) {
			const value = own(props, key);
			inspect(value);
			const id = scalarID(own(value, "id"));
			if (id) {
				const set = ids.get("conversationId") ?? new Set<string>();
				set.add(id);
				ids.set("conversationId", set);
			}
		}
		const children = own(props, "children");
		for (const child of (Array.isArray(children) ? children : [children]).slice(0, 100)) {
			visit(own(child, "props"), depth + 1);
		}
	};
	const props = reactProps(element);
	if (props.length > 1) return null;
	if (props.length === 1) visit(props[0], 0);
	if ([...ids.values()].some((values) => values.size > 1)) return null;
	for (const field of [
		"conversationId",
		"conversationShortId",
		"groupId",
		"secUid",
		"_toParticipantSecUserId",
		"userId",
	]) {
		const value = ids.get(field)?.values().next().value;
		// A sec_uid is the person, not the conversation; name it as such so a
		// caller can tell the two apart.
		if (value) return field === "_toParticipantSecUserId" ? `secuid:${value}` : `rendered:${field}:${value}`;
	}
	const links = find<HTMLAnchorElement>(
		element,
		header ? 'a[href*="/user/"]' : 'a[data-e2e="conversation-user"],.conversationConversationItemtitle a[href]',
	);
	// A group has no profile link, and a direct chat's link is the person rather
	// than the conversation, so the conversation record itself is tried before
	// giving up. The open header carries the same record under another prop.
	const group = fiberConversationID(element);
	if (group) return group;
	if (links.length !== 1) return null;
	const url = new URL(links[0].href);
	return url.origin === "https://www.douyin.com" && /^\/user\/[^/]+\/?$/.test(url.pathname)
		? `user:${url.origin}${url.pathname.replace(/\/$/, "")}`
		: null;
}

export function readContacts(): Contact[] {
	guardPage();
	return find(document, '[data-e2e="im-dialog"] [data-e2e="conversation-item"]').map((row) => ({
		id: identity(row),
		name: clean(row.querySelector('[data-e2e="conversation-name"],.conversationConversationItemtitle')?.textContent),
		type: row.getAttribute("data-conversation-type") ?? "unknown",
		unread: !!row.querySelector('[class*="unread"],[class*="Unread"],[data-e2e="unread-count"]'),
	}));
}

export function chatRoot() {
	const header = one(
		find(
			document,
			'[data-e2e="im-dialog"] [data-e2e="chat-header"],[data-e2e="im-dialog"] [data-e2e="group-chat-header"],[data-e2e="im-dialog"] [class*="StackLayoutStackChatHeaderuser"]',
		),
		"chat header",
	);
	const root = header.closest<HTMLElement>('[data-e2e="chat-page"],[class*="StackLayoutpagespageRoot"]');
	if (!root) fail("selector_changed", "Chat page container is missing");
	return { header, root };
}

declare global {
	interface Window {
		__dyMediaCapture?: {
			token: string;
			conversation: string;
			message: string;
			node: HTMLElement;
			container: HTMLElement;
			index: number;
			image: HTMLImageElement;
			source: string;
		};
	}
}

export function prepareChatMedia(conversation: string, message: string, index: number, token: string) {
	readChat(conversation);
	const { root } = chatRoot();
	const rows = findRendered(
		root,
		'[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]',
	).filter((node) => {
		const row = node.closest<HTMLElement>('[data-e2e="message-row"],[class*="messageMessageBoxmessageBox"]') ?? node;
		return (
			(row.getAttribute("data-message-id") ??
				row.getAttribute("data-msg-id") ??
				node.getAttribute("data-message-id")) === message
		);
	});
	const node = one(rows, "message with the requested ID");
	const container = one(
		findRendered(
			node,
			'[data-e2e="message-image"],[data-e2e="message-emoji"],[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"],[class*="MessageItemEmojiemojiBox"]',
		),
		"image or emoji container",
	);
	const image = findRendered<HTMLImageElement>(container, "img")[index - 1];
	if (!image || !image.complete || !image.naturalWidth || !image.naturalHeight)
		fail("unsupported_media", "The requested image is not loaded");
	if (image.naturalWidth > 4096 || image.naturalHeight > 4096 || image.naturalWidth * image.naturalHeight > 16_000_000)
		fail("unsupported_media", "Image is too large to capture");
	image.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
	window.__dyMediaCapture = {
		token,
		conversation,
		message,
		node,
		container,
		index,
		image,
		source: image.currentSrc || image.src,
	};
	return { ready: true };
}

export function verifyChatMedia(token: string) {
	const state = window.__dyMediaCapture;
	if (!state || state.token !== token) fail("identity_mismatch", "Image capture target changed");
	const conversation = readChat(state.conversation);
	if (conversation.messages.filter((message) => message.id === state.message).length !== 1)
		fail("identity_mismatch", "Message identity became ambiguous during capture");
	const { root } = chatRoot();
	const row =
		state.node.closest<HTMLElement>('[data-e2e="message-row"],[class*="messageMessageBoxmessageBox"]') ?? state.node;
	const id =
		row.getAttribute("data-message-id") ??
		row.getAttribute("data-msg-id") ??
		state.node.getAttribute("data-message-id");
	if (
		!state.image.isConnected ||
		!root.contains(state.image) ||
		!state.node.contains(state.image) ||
		id !== state.message ||
		findRendered<HTMLImageElement>(state.container, "img")[state.index - 1] !== state.image ||
		(state.image.currentSrc || state.image.src) !== state.source ||
		!state.image.complete ||
		!state.image.naturalWidth
	)
		fail("identity_mismatch", "Image or message changed during capture");
	return { verified: true };
}

export function pixelsChatMedia(token: string) {
	verifyChatMedia(token);
	const state = window.__dyMediaCapture;
	if (!state) fail("identity_mismatch", "Image capture target changed");
	const base64 = decodedImage(state.image);
	verifyChatMedia(token);
	return { base64 };
}

function decodedImage(image: HTMLImageElement): string {
	if (
		!image.complete ||
		!image.naturalWidth ||
		!image.naturalHeight ||
		image.naturalWidth > 4096 ||
		image.naturalHeight > 4096 ||
		image.naturalWidth * image.naturalHeight > 16_000_000
	)
		fail("unsupported_media", "Image is not loaded or is too large to capture");
	const canvas = document.createElement("canvas");
	canvas.width = image.naturalWidth;
	canvas.height = image.naturalHeight;
	const context = canvas.getContext("2d");
	if (!context) fail("unsupported_media", "Image extraction is unavailable");
	try {
		context.drawImage(image, 0, 0);
		const data = canvas.toDataURL("image/png");
		if (!data.startsWith("data:image/png;base64,") || data.length > 26_666_700)
			fail("unsupported_media", "Captured image exceeds the size limit");
		return data.slice("data:image/png;base64,".length);
	} catch (error) {
		if (error instanceof DOMException && error.name === "SecurityError")
			fail("unsupported_media", "This image cannot be extracted because the source does not permit canvas access");
		throw error;
	}
}

export function pixelsNote(videoID: string, index: number) {
	const before = guardVideo(videoID);
	if (!before.note || before.video || before.page_kind !== "note")
		fail("unsupported_media", "Current work is not an image post");
	const root = noteRoot();
	if (!root) fail("selector_changed", "Image post container is unavailable");
	const images = () =>
		find<HTMLImageElement>(root, "img").filter(
			(element) => !element.closest(`${privateArea},[data-e2e="comment-item"]`),
		);
	const image = images()[index - 1];
	if (!image) fail("not_found", "Requested loaded image is unavailable");
	const source = image.currentSrc || image.src;
	const base64 = decodedImage(image);
	const after = guardVideo(videoID);
	if (
		!after.note ||
		after.page_kind !== "note" ||
		noteRoot() !== root ||
		images()[index - 1] !== image ||
		(image.currentSrc || image.src) !== source
	)
		fail("identity_mismatch", "Image post changed during capture");
	return { base64, slide: before.note.slide, available_images: before.note.images.length };
}

export function cleanupChatMedia(token: string) {
	if (window.__dyMediaCapture?.token === token) {
		delete window.__dyMediaCapture;
	}
	return {};
}

// Media readers report only observable fields. A missing name or identifier
// stays null so the caller knows it needs visual inspection.
function readEmoji(container: HTMLElement) {
	const images = [...container.querySelectorAll("img")].map((element) => ({
		src: null,
		source_available: !!(element.currentSrc || element.getAttribute("src")),
		label: clean(element.getAttribute("alt") || element.getAttribute("aria-label") || element.getAttribute("title")),
	}));
	const label =
		clean(container.getAttribute("aria-label") || container.getAttribute("title")) ||
		images
			.map((image) => image.label)
			.filter(Boolean)
			.join(" ");
	return { name: label || null, images, requires_visual: !label };
}

function readShare(container: HTMLElement) {
	let videoID: string | null = null;
	let kind: "video" | "note" | null = null;
	for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
		const url = new URL(anchor.href, location.href);
		if (url.origin !== "https://www.douyin.com" || url.username || url.password) continue;
		const match = /^\/(video|note)\/(\d{1,64})\/?$/.exec(url.pathname);
		if (match) {
			kind = match[1] as "video" | "note";
			videoID = match[2];
			break;
		}
	}
	const title = container.querySelector(
		'[data-e2e="shared-video-title"],[class*="MessageItemShareAwemetitle"],[class*="MessageItemShareAwemedesc"]',
	);
	const author = container.querySelector('[data-e2e="shared-video-author"],[class*="MessageItemShareAwemeauthorName"]');
	// Verified on the live page on 2026-10-27: a share card renders only the
	// author name and a cover image. It carries no link and no aweme id, so
	// video_id is genuinely unavailable rather than a failed lookup. The author
	// is display text with no account id either.
	return {
		video_id: videoID,
		url: videoID ? `https://www.douyin.com/${kind}/${videoID}` : null,
		title: clean(title?.textContent),
		author: clean(author?.textContent),
		is_image_post: kind === "note" || !!container.querySelector('[class*="MessageItemShareAwemephotosTag"]'),
		identifiable: videoID !== null,
	};
}

function readImages(container: HTMLElement) {
	const images = [...container.querySelectorAll<HTMLImageElement>("img")].map((element) => ({
		src: null,
		source_available: !!(element.currentSrc || element.getAttribute("src")),
		label: clean(element.getAttribute("alt") || element.getAttribute("aria-label")) || null,
		// A placeholder never counts as content.
		ready: element.complete && element.naturalWidth > 0,
	}));
	return { images };
}

function readVoice(container: HTMLElement) {
	const audio = container.querySelector<HTMLAudioElement>("audio");
	const transcript = container.querySelector<HTMLElement>('[data-e2e="voice-transcript"]');
	return {
		native_audio_present: !!audio,
		duration_seconds: audio && Number.isFinite(audio.duration) && audio.duration >= 0 ? audio.duration : null,
		ready_state: audio?.readyState ?? null,
		source_available: audio ? !!(audio.currentSrc || audio.getAttribute("src")) : null,
		transcript: transcript ? clean(transcript.textContent) || null : null,
	};
}

export function readChat(expected?: string) {
	guardPage();
	const { header, root } = chatRoot();
	const id = identity(header, true);
	if (!id || (expected && id !== expected)) {
		fail("identity_mismatch", "Current conversation does not match the requested stable ID");
	}
	const messages = find(
		root,
		'[data-e2e="msg-item-content"],[data-e2e="message-content"],[data-testid="message-content"]',
	)
		.filter((node) => !node.parentElement?.closest('[data-e2e="msg-item-content"],[data-e2e="message-content"]'))
		.map((node) => {
			const row = node.closest<HTMLElement>('[data-e2e="message-row"],[class*="messageMessageBoxmessageBox"]') ?? node;
			const ancestors: HTMLElement[] = [];
			for (let parent: HTMLElement | null = node; parent && parent !== root; parent = parent.parentElement)
				ancestors.push(parent);
			const outgoing = ancestors.some(
				(element) =>
					element.getAttribute("data-direction") === "outgoing" ||
					element.getAttribute("data-is-self") === "true" ||
					element.getAttribute("data-is-from-me") === "true" ||
					[...element.classList].some((value) => /isFromMe/i.test(value)),
			);
			// The live page marks only the sender's own rows. A row without that
			// marker came from the other side, which is the common case in a group;
			// requiring an explicit incoming marker would report every peer message
			// as unknown and make replies to them impossible.
			const incoming = !outgoing;
			const text = node.querySelector<HTMLElement>('[data-e2e="message-text"],[class*="MessageItemTextcontainer"]');
			const emoji = node.querySelector<HTMLElement>('[data-e2e="message-emoji"],[class*="MessageItemEmojiemojiBox"]');
			const share = node.querySelector<HTMLElement>(
				'[data-e2e="shared-video-card"],[class*="MessageItemShareAwemecontainer"]',
			);
			const image = node.querySelector<HTMLElement>(
				'[data-e2e="message-image"],[class*="MessageItemImagecontainer"],[class*="MessageItemImageimageBox"]',
			);
			const voice = node.querySelector<HTMLElement>('[data-e2e="message-voice"],[class*="MessageItemAudio"]');
			const kind = text
				? "text"
				: emoji
					? "emoji"
					: share
						? "share"
						: image
							? "image"
							: voice
								? "voice"
								: "unsupported";
			const fiber = fiberMessage(node);
			const fiberRow = fiber.id ? fiber : fiberMessage(row);
			return {
				id:
					row.getAttribute("data-message-id") ??
					row.getAttribute("data-msg-id") ??
					node.getAttribute("data-message-id") ??
					fiberRow.id,
				direction: outgoing && !incoming ? "outgoing" : incoming && !outgoing ? "incoming" : "unknown",
				text: text?.innerText.trim() ?? "",
				kind,
				...(emoji ? { emoji: readEmoji(emoji) } : {}),
				...(share ? { share: readShare(share) } : {}),
				...(image ? { image: readImages(image) } : {}),
				...(voice ? { voice: readVoice(voice) } : {}),
				timestamp: row.getAttribute("data-sent-at") ?? row.getAttribute("data-timestamp") ?? fiberRow.created_at,
				pending: !!row.querySelector('[data-e2e="message-pending"],[class*="sending"],[class*="Sending"]'),
				failed: !!row.querySelector('[data-e2e="message-failed"],[class*="sendFail"],[class*="SendFail"]'),
			};
		});
	return {
		id,
		name: clean(
			header.querySelector(
				'[data-e2e="chat-title"],[data-e2e="group-chat-title"],[class*="StackLayoutStackChatHeadertitle"]',
			)?.textContent,
		),
		type: header.getAttribute("data-conversation-type") ?? "unknown",
		messages,
		scope: "loaded_dom",
		complete: false,
	};
}

export function chatSignature(): string {
	const { header, root } = chatRoot();
	return JSON.stringify([identity(header, true), header.innerText, root.getAttribute("data-conversation-id")]);
}

export function watermark(): string {
	const { root } = chatRoot();
	const media = [
		...root.querySelectorAll<HTMLImageElement>(
			'[data-e2e="message-content"] img,[data-e2e="msg-item-content"] img,[data-testid="message-content"] img',
		),
	].map((image) => image.currentSrc || image.getAttribute("src"));
	return JSON.stringify([readChat().messages, media]);
}

export function userIdentity(expected?: string): string {
	guardPage();
	const match = /^\/user\/([^/]+)\/?$/.exec(location.pathname);
	if (!match || (expected && match[1] !== expected)) fail("identity_mismatch", "Unexpected user profile");
	return match[1];
}

// The signed-in account, from the page's own login store. Every DOM route to
// this is conditional: the nav says only "self", the composer's avatar link is
// absent on the recommended feed, and a profile page has to be loaded first. The
// store is what the page itself uses, so it answers on every surface.
// Only scalar fields are read, and no function on the store is ever called.
interface LoginInfo {
	secUid?: unknown;
	nickname?: unknown;
}

function loginStore(): LoginInfo | null {
	// The window property is a data property; curLoginUserInfo is a getter on the
	// store instance, which is why own() alone returned nothing.
	const store = own(window, "userInfoStore");
	const info = own(store, "curLoginUserInfo") ?? getterValue(store, "curLoginUserInfo");
	return info && typeof info === "object" ? (info as LoginInfo) : null;
}

// The login record is a class instance: secUid and nickname are getters on the
// instance itself, not data properties, which is why reading only own() found
// the record and then none of its fields.
function loginField(info: LoginInfo | null, key: "secUid" | "nickname"): unknown {
	return own(info, key) ?? getterValue(info, key);
}

export function signedInName(): string | null {
	const name = loginField(loginStore(), "nickname");
	const text = typeof name === "string" ? clean(name) : "";
	return text || null;
}

export function authenticatedUser(): string | null {
	const stored = loginField(loginStore(), "secUid");
	if (typeof stored === "string" && /^[A-Za-z0-9_-]{5,}$/.test(stored)) return stored;
	// The store can be absent before the app hydrates. The composer's avatar link
	// then carries the same id; find() is viewport-bound, so findRendered is used
	// and the fallback survives a scrolled comment list.
	const composer = findRendered<HTMLAnchorElement>(
		document,
		'#comment-input-container a[href*="/user/"],.comment-input-container a[href*="/user/"],.comment-input-inner-container a[href*="/user/"]',
	)
		.map((anchor) => /\/user\/([^/?#]+)/.exec(new URL(anchor.href).pathname)?.[1] ?? null)
		.filter((id): id is string => !!id && id !== "self");
	if (new Set(composer).size === 1) return composer[0];
	const links = find<HTMLAnchorElement>(document, ".tab-user_self a[href]").filter(
		(element) => visible(element) && clean(element.textContent) === "我的",
	);
	if (links.length !== 1) return null;
	const url = new URL(links[0].href);
	const id = url.origin === "https://www.douyin.com" ? (/^\/user\/([^/]+)/.exec(url.pathname)?.[1] ?? null) : null;
	return id && id !== "self" ? id : null;
}
