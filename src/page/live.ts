import { classifyLine, parseGiftLabel } from "../live-text.ts";
import { clean, fail, findRendered } from "./dom.ts";

// The live room is a different site from the works feed: live.douyin.com, a
// canvas for the picture, a Slate editor for the danmaku, and a chat list that
// mixes viewer messages with gifts and joins. Everything here reads what the
// room states and nothing about the picture, which is a canvas and carries no
// readable text at all — a guess about the game is not a reading.

// Matched against pathname, so it holds the path and not the origin.
const ROOM = /^\/(\d{1,32})\/?$/;

export const LIVE_ORIGIN = "https://live.douyin.com";

export function liveRoom(href: string): string | null {
	try {
		const url = new URL(href);
		if (url.origin !== LIVE_ORIGIN) return null;
		return ROOM.exec(url.pathname)?.[1] ?? null;
	} catch {
		return null;
	}
}

export function liveState() {
	const room = liveRoom(location.href);
	if (!room) fail("unsupported_page", "The owned tab is not a live room", "Open a live room first.");
	// The room's own status text. A finished broadcast keeps the page and says so,
	// which is different from the tab having been navigated away.
	const text = clean(document.body.innerText);
	const ended = /直播已结束|主播离开|已下播/.test(text);
	const anchor = findRendered<HTMLElement>(
		document,
		'[class*="webcast-chatroom___input-container"],[class*="chatroom"]',
	).length;
	// The host name comes from the document title, which the room sets to
	// "<host>的抖音直播间". A nickname class was tried first and matched the chat
	// list instead: a viewer's name is not the room's host.
	const title = clean(document.title)
		.replace(/的抖音直播间.*$/, "")
		.trim();
	const viewers = /在线观众\s*(\d+)/.exec(text)?.[1];
	return {
		room_id: room,
		url: location.href,
		// The picture is a canvas with no text layer. Saying so is the honest
		// answer to "what is happening"; inventing a game name is not.
		video_readable: false,
		status: ended ? "ended" : "live",
		host: title || null,
		viewers: viewers ? Number(viewers) : null,
		can_comment: !ended && anchor > 0,
	};
}

// The chat list mixes four kinds of row and they mean different things: a gift
// is not a comment, and a join is not a viewer saying anything. Collapsing them
// into one list would make a room look busier and chattier than it is.
export function liveChat() {
	// The room gives each danmaku its own element with a stable class; the wrapper
	// around it repeats the same sentence. Searching by text length instead pulled
	// in a whole block of the chat as one row, which is how a gift line ended up
	// holding twenty other people's messages.
	const rows = [...document.querySelectorAll<HTMLElement>('[class*="webcast-chatroom___item"]')].filter(
		(element) =>
			!(element.className ?? "").toString().includes("item-wrapper") && clean(element.textContent).length > 0,
	);
	// The room keeps a wrapper and an inner element for the same line; both match
	// the class. One line is one item, so the pair is collapsed by its text.
	const seen = new Set<string>();
	const items = rows
		.map((row) => classifyLine(clean(row.textContent)))
		.filter((item) => {
			const key = `${item.kind}\u0000${item.author}\u0000${item.text}`;
			if (seen.has(key)) return false;
			seen.add(key);
			return true;
		});
	return { items, scope: "loaded_dom", complete: false };
}

export function liveComposer(): HTMLElement {
	// Slate's editor, not a textarea: it is a contenteditable div marked by the
	// editor kit. The width check skips the hidden copies the room keeps around.
	const editors = findRendered<HTMLElement>(
		document,
		'[data-slate-editor="true"],.zone-container.editor-kit-container',
	);
	const usable = editors.filter((element) => {
		const rect = element.getBoundingClientRect();
		return rect.width > 80 && rect.height > 8;
	});
	if (usable.length !== 1)
		fail(
			"editor_not_ready",
			usable.length ? "More than one danmaku editor is visible" : "The danmaku editor is not on screen",
			"The room may be closed or the account may not be allowed to comment.",
		);
	return usable[0];
}

export function readComposer(): string {
	return clean(liveComposer().textContent);
}

// Clearing must be a real deletion through the editor, not an assignment to its
// markup: Slate keeps its own document state and merges a stale one back on the
// next keystroke. That is exactly how a previous attempt produced
// "德丽三杠零…这打野起步太顺了" — the old text and the new, joined.
export function clearComposer(): { cleared: boolean; before: string } {
	const editor = liveComposer();
	const before = clean(editor.textContent);
	if (!before) return { cleared: true, before: "" };
	editor.focus();
	const range = document.createRange();
	range.selectNodeContents(editor);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	// The key event is what Slate observes; manipulating the selection alone does
	// not update its internal document.
	document.execCommand("delete");
	return { cleared: clean(editor.textContent) === "", before };
}

// The gift grid. Class names change between builds, so an item is identified by
// its visible text: the platform writes "<price>钻<name><price>钻赠送".
export interface GiftItem {
	name: string;
	price: number | null;
	x: number;
	y: number;
	text: string;
}

export function giftItems(): GiftItem[] {
	const candidates = [...document.querySelectorAll<HTMLElement>("div,li")]
		.filter((element) => {
			const text = clean(element.textContent);
			if (!/钻/.test(text) || text.length > 60) return false;
			const rect = element.getBoundingClientRect();
			return rect.width > 40 && rect.height > 40 && rect.top > 0;
		})
		.filter((element) => {
			// The innermost element carrying that text; wrappers repeat it.
			const text = clean(element.textContent);
			return ![...element.children].some((child) => clean(child.textContent) === text);
		});
	const items: GiftItem[] = [];
	const seen = new Set<string>();
	for (const element of candidates) {
		const text = clean(element.textContent);
		const parsed = parseGiftLabel(text);
		if (!parsed) continue;
		const name = parsed.name;
		if (seen.has(name)) continue;
		seen.add(name);
		const rect = element.getBoundingClientRect();
		items.push({
			name,
			price: parsed.price,
			x: Math.round(rect.left + rect.width / 2),
			y: Math.round(rect.top + rect.height / 2),
			text,
		});
	}
	return items;
}

// Sending a gift costs real money and cannot be undone, so the item is checked
// twice: the name and price the caller asked for must match one item exactly,
// and the point handed back belongs to that item's own text.
export function prepareGift(name: string, price: number): { x: number; y: number; name: string; price: number } {
	const items = giftItems();
	const exact = items.filter((item) => item.name === name);
	if (exact.length !== 1) {
		fail("not_found", `The gift panel has ${exact.length} items named ${name}`, "Run live gift list to see the names.");
	}
	const item = exact[0];
	if (item.price !== price) {
		fail(
			"invalid_argument",
			"The gift's price does not match",
			`${item.name} costs ${item.price}, not ${price}. The panel decides the price, not the caller.`,
		);
	}
	return { x: item.x, y: item.y, name: item.name, price: item.price };
}

// What the room says was sent. Reading this back is the only evidence that the
// click landed on the intended item — a broad selector once sent a second,
// pricier gift than the one that was meant.
export function giftsSent(selfName: string) {
	const name = clean(selfName);
	const rows = liveChat().items.filter((item) => item.kind === "gift");
	// Whose gift it was comes from the row's author, which the room states; the
	// name to compare against is supplied by the caller, because this account is
	// one of many and nothing here should assume which.
	return rows.map((row) => ({
		text: row.text,
		author: row.author,
		for_self: !!name && row.author === name,
	}));
}

// Every data-e2e marker this page carries, with how many are laid out and how
// many are on screen. Used to compare what the code expects against what the
// page actually offers — the comparison that a fixture written by hand cannot
// make, because it was written from the same understanding that produced the
// code.
export function pageFacts() {
	const counts = new Map<string, { count: number; visible: number }>();
	for (const element of document.querySelectorAll<HTMLElement>("[data-e2e]")) {
		const marker = element.getAttribute("data-e2e");
		if (!marker) continue;
		const entry = counts.get(marker) ?? { count: 0, visible: 0 };
		entry.count += 1;
		const rect = element.getBoundingClientRect();
		if (rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.top < innerHeight) entry.visible += 1;
		counts.set(marker, entry);
	}
	return {
		url: location.href,
		title: document.title,
		markers: [...counts.entries()]
			.map(([selector, entry]) => ({ selector, ...entry }))
			.sort((a, b) => a.selector.localeCompare(b.selector)),
	};
}
