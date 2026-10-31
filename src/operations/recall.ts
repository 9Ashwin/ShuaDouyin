import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt, Store } from "../store.ts";
import { control } from "./navigation.ts";
import type { Input } from "./validate.ts";

// Recalling one of this account's own messages.
//
// Three things make this different from the other chat writes, and each of them
// is a way the obvious implementation goes wrong:
//
// The platform's window is three minutes, but the page renders the menu entry
// regardless. So "the entry is there" is not permission — the request is what
// settles it, and a refusal has to be reported as the refusal it is rather than
// as a changed selector.
//
// There is no confirmation dialog. The click is the whole action, so the receipt
// has to exist before it, and the only evidence afterwards is that the message
// is gone from the conversation.
//
// The menu only opens from a real mouse sequence on the row. Calling the menu
// item's onClick does nothing: the handler that sends the request lives on the
// message element, not on the entry.

interface Target {
	message_id: string;
	outgoing: boolean;
	created_at: string | null;
	x: number;
	y: number;
}

export async function recallMessage(
	session: Session,
	input: Input,
	store: Store,
	signal: AbortSignal,
): Promise<unknown> {
	const conversation = input.conversation_id ?? "";
	const messageID = input.message_id ?? "";
	if (!conversation) throw new CliError("invalid_argument", "--conversation-id is required");
	if (!messageID) throw new CliError("invalid_argument", "--message-id is required");
	const requestID = input.request_id;
	if (!requestID)
		throw new CliError("invalid_argument", "--request-id is required", {
			hint: "Recalling has no confirmation step, so the receipt is the only record.",
		});

	// The conversation has to be the one on screen before its rows can be
	// trusted: a row from another conversation would be a different message with
	// the same shape.
	await session.call("chat.list", { limit: 50 });
	await control(session, "chat.open");
	const target = await session.call<Target>("chat.recall.target", { message_id: messageID });
	if (!target.outgoing)
		throw new CliError("invalid_argument", "Only a message this account sent can be recalled", {
			hint: "The page offers no recall entry on anyone else's message.",
			details: { message_id: messageID },
		});

	const receipts = await store.receipts();
	if (Object.hasOwn(receipts, requestID)) {
		const existing = receipts[requestID];
		return { request_id: requestID, confirmed: existing.status === "confirmed", replayed: true };
	}

	const now = new Date().toISOString();
	const receipt: Receipt = {
		request_id: requestID,
		fingerprint: `chat.recall:${conversation}:${messageID}`,
		operation: "chat.recall",
		target: { conversation_id: conversation },
		...(store.bot_id ? { bot_id: store.bot_id } : {}),
		status: "prepared",
		created_at: now,
		updated_at: now,
	};
	await store.saveReceipt(receipt);

	// The right-click opens the row's menu. It must be aimed at the row itself:
	// the menu is anchored to the pointer.
	await session.tab.mouse.click(target.x, target.y, { button: "right" });
	await delay(400, undefined, { signal });
	const point = await session.call<{ x: number; y: number }>("chat.recall.point", {});
	receipt.status = "dispatching";
	receipt.updated_at = new Date().toISOString();
	await store.saveReceipt(receipt);
	// A real press sequence, not element.click(): the handler the page binds is a
	// synthetic listener, and a bare click on the element does not reach it.
	await session.tab.mouse.move(point.x, point.y);
	await session.tab.mouse.down();
	await session.tab.mouse.up();

	// The request is in flight. Wait for either the message to leave the list or
	// the page to say why it did not.
	const deadline = Date.now() + 8000;
	let outcome: { recalled: boolean; expired: boolean } = { recalled: false, expired: false };
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		await delay(400, undefined, { signal });
		outcome = await session.call<{ recalled: boolean; expired: boolean }>("chat.recall.outcome", {});
		if (outcome.recalled || outcome.expired) break;
	}
	if (outcome.expired) {
		// The message may already be out of the window before we clicked. Say so
		// plainly instead of leaving a pending receipt behind: nothing happened.
		receipt.status = "not_sent";
		receipt.updated_at = new Date().toISOString();
		receipt.uncertainty_reason = "past_window";
		await store.saveReceipt(receipt);
		throw new CliError("invalid_argument", "The message is past the three-minute recall window", {
			hint: "The page still shows the entry but the platform refuses the request.",
			details: { message_id: messageID, created_at: target.created_at },
		});
	}
	if (!outcome.recalled) {
		// No toast either way. The receipt stays dispatching: the request may have
		// gone out and the page may not have repainted.
		throw new CliError("delivery_uncertain", "The recall was requested but the page did not confirm it", {
			hint: "Re-read the conversation before trying again; the message may already be gone.",
			details: { request_id: requestID, message_id: messageID },
		});
	}
	// The page said so, which is the only evidence available. Confirming from the
	// list as well would be stronger, but the list updates lazily and a missing
	// row and an unloaded row look identical.
	receipt.status = "confirmed";
	receipt.updated_at = new Date().toISOString();
	receipt.result = { message_id: messageID, conversation_id: conversation };
	await store.saveReceipt(receipt);
	return { request_id: requestID, confirmed: true, message_id: messageID, conversation_id: conversation };
}
