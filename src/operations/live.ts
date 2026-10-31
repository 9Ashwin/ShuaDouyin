import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt, Store } from "../store.ts";
import type { Input } from "./validate.ts";

// The live room is a different surface from the works feed: a canvas picture the
// adapter cannot read, a Slate composer, and a gift grid that spends money. Two
// things here are deliberately stricter than their comment equivalents, both
// from a walkthrough that got them wrong: a draft must be proven clear rather
// than assumed, and a gift must be matched by name and price before and after.

interface LiveState {
	room_id: string;
	status: "live" | "ended";
	host: string | null;
	viewers: number | null;
	can_comment: boolean;
	video_readable: boolean;
}

export async function liveInfo(session: Session): Promise<LiveState> {
	return session.call<LiveState>("live.state", {});
}

export async function liveChatRead(session: Session, input: Input) {
	const state = await session.call<{ items: { author: string; text: string; kind: string }[]; complete: boolean }>(
		"live.chat",
		{},
	);
	const limit = input.limit ?? 30;
	const items = state.items.slice(-limit);
	return {
		room_id: (await liveInfo(session)).room_id,
		items,
		counts: {
			chat: items.filter((item) => item.kind === "chat").length,
			gift: items.filter((item) => item.kind === "gift").length,
			join: items.filter((item) => item.kind === "join").length,
			system: items.filter((item) => item.kind === "system").length,
		},
		scope: "loaded_dom",
		complete: false,
		limitations: [
			"The chat list shows what has loaded in this window, not the full history.",
			"Gifts and joins are reported separately from what viewers say.",
			"Only text already public in the room is returned.",
		],
	};
}

export async function liveSay(session: Session, input: Input, store: Store, signal: AbortSignal) {
	const text = (input.text ?? "").trim();
	if (!text) throw new CliError("invalid_argument", "A danmaku needs text");
	// The same request id is the same danmaku. Without this the second call typed
	// and sent again — the caller reusing an id believes it is retrying a request
	// that failed, and gets two lines in the room instead of one.
	const key = input.request_id ?? randomUUID();
	const receipts = await store.receipts();
	const existing = Object.hasOwn(receipts, key) ? receipts[key] : undefined;
	if (existing) return { request_id: key, confirmed: existing.status === "confirmed", replayed: true };
	const state = await liveInfo(session);
	if (state.status === "ended")
		throw new CliError("state", "The broadcast has ended", { hint: "Wait for the next one." });
	if (!state.can_comment)
		throw new CliError("state", "This room does not accept comments from this account", {
			hint: "Some rooms require following, a level, or a small wait.",
		});
	// Clearing is proven, not assumed. A composer left holding anything — old text
	// or the operator's own draft — makes the sent line a join of two strings,
	// and the result cannot be told apart from what was intended.
	const cleared = await session.call<{ cleared: boolean; before: string }>("live.clear", {});
	if (!cleared.cleared)
		throw new CliError("draft_conflict", "The danmaku editor could not be cleared", {
			hint: "A draft is already in the room's input box; clear it by hand before sending.",
			details: { held: cleared.before },
		});
	// The room keeps a hidden copy of the editor first in the document, so a
	// locator on the first match clicks something invisible and the typing goes
	// nowhere. The adapter measured the editor it validated; click that.
	const point = await session.call<{ x: number; y: number }>("live.composer.point", {});
	await session.tab.mouse.click(point.x, point.y);
	await session.tab.keyboard.insertText(text);
	const held = await session.call<{ text: string }>("live.composer", {});
	// The editor renders each line with a trailing zero-width sentinel. Stripping
	// only that character keeps a comparison exact for everything a user typed.
	const comparable = (value: string) =>
		value
			.replace(/\u200b/g, "")
			.replace(/\s+/g, " ")
			.trim();
	if (comparable(held.text) !== comparable(text))
		throw new CliError("draft_conflict", "The editor does not hold the requested text", {
			details: { requested: text, held: held.text },
		});
	const before = await session.call<{ items: { text: string; author: string }[] }>("live.chat", {});
	const known = new Set(before.items.map((item) => `${item.author}\u0000${item.text}`));
	// The receipt is written before the key press, exactly as the gift path does:
	// a crash between here and the confirmation must leave evidence that a line
	// may already be in the room, so a retry does not become a second line.
	const receipt: Receipt = {
		request_id: key,
		fingerprint: `live.say:${state.room_id}:${text}`,
		status: "prepared",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		operation: "live.say",
	};
	await store.saveReceipt(receipt);
	receipt.status = "dispatching";
	receipt.updated_at = new Date().toISOString();
	await store.saveReceipt(receipt);
	await session.tab.keyboard.press("Enter");
	const deadline = Date.now() + 6000;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		await delay(300, undefined, { signal });
		const after = await session.call<{ items: { text: string; author: string }[] }>("live.chat", {});
		const fresh = after.items.filter((item) => item.text === text && !known.has(`${item.author}\u0000${item.text}`));
		if (fresh.length) {
			receipt.status = "confirmed";
			receipt.updated_at = new Date().toISOString();
			receipt.result = { text, seen_in_chat: fresh.length, room_id: state.room_id };
			await store.saveReceipt(receipt);
			return { confirmed: true, request_id: key, text, seen_in_chat: fresh.length, room_id: state.room_id };
		}
	}
	throw new CliError("delivery_uncertain", "The danmaku was typed and sent but not seen in the chat", {
		hint: "Read the room before sending again; the line may still be there.",
		details: { request_id: input.request_id ?? null, text },
	});
}

export async function liveGifts(session: Session) {
	const state = await session.call<{ items: { name: string; price: number | null; text: string }[] }>("live.gifts", {});
	return {
		items: state.items.map((item) => ({ name: item.name, price: item.price })),
		count: state.items.length,
		scope: "loaded_panel",
		limitations: [
			"Prices are read from the panel as shown, in the room's own currency.",
			"Only gifts the panel has loaded are listed.",
		],
	};
}

// Sending a gift is the one action here that costs money and cannot be undone.
// The receipt is written before the click; the confirmation afterwards reads
// what the room says was sent, because the click itself is not evidence of
// which item it landed on.
export async function liveGiftSend(
	session: Session,
	input: Input,
	store: Store,
	signal: AbortSignal,
): Promise<unknown> {
	const name = (input.name ?? "").trim();
	const price = input.price;
	if (!name) throw new CliError("invalid_argument", "Name the gift to send", { hint: "Run live gift list first." });
	if (typeof price !== "number" || !Number.isFinite(price) || price < 0)
		throw new CliError("invalid_argument", "State the gift's price with --price", {
			hint: "The price is checked against the panel so a wrong item cannot be sent.",
		});
	const count = input.count ?? 1;
	if (!Number.isInteger(count) || count < 1 || count > 10)
		throw new CliError("invalid_argument", "--count must be 1..10; a gift costs real money");
	const key = input.request_id ?? randomUUID();
	const receipts = await store.receipts();
	const existing = Object.hasOwn(receipts, key) ? receipts[key] : undefined;
	if (existing) return { request_id: key, confirmed: existing.status === "confirmed", replayed: true };
	const state = await liveInfo(session);
	if (state.status === "ended") throw new CliError("state", "The broadcast has ended");
	const target = await session.call<Point & { name: string; price: number }>("live.gift.prepare", { name, price });
	// Whose gift is ours is decided by the signed-in name the page holds, not by a
	// name written into this file: the caller sends from one account among many.
	const selfName = await session.call<string | null>("self.name", {});
	const before = await session.call<{ items: { text: string; for_self: boolean }[] }>("live.gifts.sent", {
		text: selfName ?? "",
	});
	const receipt: Receipt = {
		request_id: key,
		fingerprint: `${state.room_id}:${name}:${price}:${count}`,
		operation: "live.gift",
		status: "prepared",
		created_at: new Date().toISOString(),
		updated_at: new Date().toISOString(),
		target: { video_id: undefined, user_id: state.host ?? undefined },
	};
	await store.saveReceipt(receipt);
	receipt.status = "dispatching";
	receipt.updated_at = new Date().toISOString();
	await store.saveReceipt(receipt);
	await session.click(target);
	const deadline = Date.now() + 8000;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		await delay(500, undefined, { signal });
		const after = await session.call<{ items: { text: string; for_self: boolean }[] }>("live.gifts.sent", {
			text: selfName ?? "",
		});
		const mine = after.items.filter((item) => item.for_self);
		const beforeMine = before.items.filter((item) => item.for_self);
		if (mine.length > beforeMine.length) {
			// What the room says, not what was clicked. A broader selector once sent
			// a second, pricier gift than the one intended; the report has to carry
			// the truth rather than the intention.
			const sent = mine.slice(beforeMine.length).map((item) => item.text);
			const matched = sent.filter((text) => text.includes(name)).length;
			receipt.status = "confirmed";
			receipt.updated_at = new Date().toISOString();
			receipt.result = { sent, matched };
			await store.saveReceipt(receipt);
			return {
				request_id: key,
				confirmed: matched > 0,
				requested: { name, price, count },
				sent,
				// Anything else the room reports is stated, not hidden: a gift that was
				// not asked for still left the account.
				unexpected: sent.filter((text) => !text.includes(name)),
			};
		}
	}
	throw new CliError("delivery_uncertain", "The gift click was dispatched but the room shows nothing sent", {
		hint: "Check the room and the account's balance before trying again.",
		details: { request_id: key, name, price },
	});
}
