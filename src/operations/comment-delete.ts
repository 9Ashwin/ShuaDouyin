import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeManager, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt } from "../store.ts";
import type { Input } from "./validate.ts";

// Deleting one of this account's own comments.
//
// The page asks for no confirmation, so everything that keeps this from deleting
// the wrong thing has to live here: the row must be loaded, it must carry this
// account's identity, and the id must be the one that was asked for. A display
// name is never used, because two people can share one and the page would happily
// delete whichever row it opened.
//
// The receipt is written before the menu is opened, like every other write. Unlike
// a send, this one has a provable outcome: after the menu entry is clicked, the
// row either disappears or it does not, and the page is read to find out which.

// The same Store the send path uses. A narrower interface was tried and it does
// not fit: the receipt type is shared, and inventing a second shape for the same
// file would let the two drift.
export type DeleteStore = {
	receipts: () => Promise<Record<string, Receipt>>;
	saveReceipt: (receipt: Receipt) => Promise<void>;
	append: (operation: string, data: unknown) => Promise<{ id: string }>;
	bot_id?: string;
};

export async function deleteComment(
	input: Input,
	signal: AbortSignal,
	deps: { store: DeleteStore; chrome: ChromeManager; timeout: number },
) {
	const requestID = input.request_id ?? randomUUID();
	const commentID = input.comment_id ?? "";
	const videoID = input.video_id ?? "";
	if (!commentID) throw new CliError("invalid_argument", "--comment-id is required");
	const receipts = await deps.store.receipts();
	const existing = Object.hasOwn(receipts, requestID) ? receipts[requestID] : undefined;
	if (existing) {
		// A delete that already happened is not repeated: the second attempt would
		// find no row and report not_found, which reads like the first one failed.
		if (existing.status === "confirmed")
			return { request_id: requestID, confirmed: true, replayed: true, result: existing.result ?? null };
		throw new CliError("delivery_uncertain", "This request ID was already used for a delete that did not finish", {
			hint: `Inspect receipt get ${requestID} and the work before using a new request id.`,
			details: { request_id: requestID, receipt: existing },
		});
	}
	const session = await deps.chrome.connect(signal, deps.timeout);
	try {
		// The row has to be the page's current work and already loaded. Hunting for
		// it by scrolling would mean clicking an id the page had not shown yet, and
		// the id is the only thing being protected here.
		const state = await session.call<{ video?: { id?: string } | null; note?: { id?: string } | null }>(
			"video.info",
			{},
		);
		const current = state.video?.id ?? state.note?.id ?? null;
		if (!current || (videoID && current !== videoID))
			throw new CliError("identity_mismatch", "The page is not showing the requested work", {
				hint: "Open the work with dy video open <id> first.",
				details: { expected: videoID, current },
			});
		const target = await session.call<{ hover: { x: number; y: number }; text: string }>("comment.delete.open", {
			video_id: current,
			comment_id: commentID,
		});
		const receipt = {
			request_id: requestID,
			fingerprint: `${current}:${commentID}`,
			operation: "comment.delete",
			target: { video_id: current, comment_id: commentID },
			...(deps.store.bot_id ? { bot_id: deps.store.bot_id } : {}),
			status: "prepared",
			// What the row said, so a later reader can tell which comment this was
			// without the comment existing any more.
			comment_text: target.text,
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		await deps.store.saveReceipt(receipt as Receipt);
		// The menu button only exists while the row is hovered, so the caller hovers
		// the point the page measured and then asks where the button landed.
		await session.tab.mouse.move(target.hover.x, target.hover.y);
		await delay(300, undefined, { signal });
		const token = randomUUID();
		const dots = await session.call<{ x: number; y: number; selector: string }>("comment.delete.menu", {
			comment_id: commentID,
			token,
		});
		await session.click(dots);
		await delay(250, undefined, { signal });
		const entry = await session.call<{ x: number; y: number; selector: string }>("comment.delete.item", {
			comment_id: commentID,
			token: randomUUID(),
		});
		receipt.status = "dispatching";
		receipt.updated_at = new Date().toISOString();
		await deps.store.saveReceipt(receipt as Receipt);
		await session.click(entry);
		// Deletion has no confirmation dialog, so the row being gone is the whole
		// proof. It is read a few times because the list re-renders after the click.
		const deadline = Date.now() + 5000;
		let present = true;
		while (Date.now() < deadline) {
			const check = await session.call<{ present: boolean }>("comment.delete.state", { comment_id: commentID });
			present = check.present;
			if (!present) break;
			await delay(200, undefined, { signal });
		}
		if (present) {
			// The click landed on something that did not delete. This is the one case
			// where "uncertain" is the honest word, so the receipt says so rather than
			// claiming either outcome.
			receipt.status = "dispatching";
			receipt.updated_at = new Date().toISOString();
			await deps.store.saveReceipt(receipt as Receipt);
			throw new CliError("delivery_uncertain", "The delete was clicked but the comment is still there", {
				hint: `Inspect receipt get ${requestID} and the work before trying again.`,
				details: { request_id: requestID, receipt },
			});
		}
		receipt.status = "confirmed";
		receipt.updated_at = new Date().toISOString();
		await deps.store.saveReceipt(receipt as Receipt);
		await deps.store.append("comment.delete", {
			request_id: requestID,
			video_id: current,
			comment_id: commentID,
			text: target.text,
		});
		return { request_id: requestID, confirmed: true, changed: true, deleted: commentID, text: target.text };
	} finally {
		await session.call("cleanup").catch(() => undefined);
		await session.close();
	}
}

// The stored receipt type is shared with the send path; this keeps the shape
// honest without duplicating it.
export type DeleteSession = Session;
