import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeManager, Point, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt } from "../store.ts";
import type { Input } from "./validate.ts";

// Telling Douyin what this account wants less or more of.
//
// This is the first write here that changes the recommendation model rather than
// reaching another person. That difference shapes everything below:
//
// A comment or a message leaves this installation and someone else may read it.
// A steer only changes what this account is shown. Nobody can see it, nothing is
// addressed to anyone, and pressing it twice changes nothing that pressing it once
// did not. So the identity checks that guard a send against reaching the wrong
// person are not what matters here; what matters is that it lands on the work the
// caller named and reports what the page actually said.
//
// It is still a write. It passes the pause gate and the goal quota like every
// other outward action, it leaves a receipt before anything can be pressed, and it
// is never retried automatically: a press that may have landed is reported as
// uncertain, because "less of this" pressed twice is a stronger instruction than
// the caller gave.

export type Direction = "less" | "more";

export const STEER_LIMITS = [
	"This changes what the platform recommends to this account. It is not visible to anyone, and it is not undoable from the page: the menu's 推荐 switch cancels a positive signal, it does not withdraw a 不感兴趣.",
	"The page states no recommendation state, so nothing here reports what the model now holds. Only that the press was made and what the page said about it.",
	"less is an instruction, not a switch: the page never reports whether it applied, and one press is one instruction. Do not press it again to make sure.",
];

export interface SteerReceiptStore {
	receipts: () => Promise<Record<string, Receipt>>;
	saveReceipt: (receipt: Receipt) => Promise<void>;
	append: (operation: string, data: unknown) => Promise<{ id: string }>;
	bot_id?: string;
}

interface SteerReport {
	request_id: string;
	confirmed: boolean;
	changed: boolean;
	direction: Direction;
	video_id: string;
	// "less" always false: the page offers no state for it.
	value: boolean;
	// What the page said after the press, verbatim.
	toast: string | null;
	evidence: "page_toast" | "menu_label" | "moved_on" | "already" | null;
	limits: string[];
}

// What each direction's confirmation looks like. Keeping the two next to each
// other is what makes the asymmetry obvious to a later reader: one is a toast, the
// other is a label.
const TOASTS: Record<Direction, RegExp> = {
	less: /减少此类视频/,
	more: /取消推荐|操作成功/,
};

// The state asked for is part of the request's identity: asking for "more" and
// then for "not more" on the same work are opposite instructions, and a replay
// must not answer one with the other.
export function fingerprintOf(videoID: string, direction: Direction, value: boolean): string {
	return createHash("sha256")
		.update(JSON.stringify({ video_id: videoID, direction, value }))
		.digest("hex")
		.slice(0, 16);
}

export async function steerWork(
	input: Input,
	signal: AbortSignal,
	deps: { store: SteerReceiptStore; chrome: ChromeManager; timeout: number },
): Promise<SteerReport> {
	const direction = input.direction as Direction;
	// "more" is a switch and needs the state it should end in. "less" is an action,
	// so a value sent with it is ignored rather than believed: the page has no state
	// for it, and accepting one would make the flag look meaningful.
	const value = direction === "more" ? (input.enabled ?? true) : true;
	const requestID = input.request_id ?? randomUUID();
	const receipts = await deps.store.receipts();
	const existing = Object.hasOwn(receipts, requestID) ? receipts[requestID] : undefined;
	if (existing) {
		// A confirmed steer replays locally: pressing again would strengthen an
		// instruction that already landed, and the caller cannot tell from a second
		// press whether the first one worked.
		if (existing.status === "confirmed")
			return { ...(existing.result as SteerReport), request_id: requestID, confirmed: true, changed: false };
		throw new CliError("delivery_uncertain", "This request ID was already used for a steer that did not finish", {
			hint: `Inspect receipt get ${requestID} before using a new request id. A second press is a second instruction.`,
			details: { request_id: requestID, receipt: existing },
		});
	}
	const session = await deps.chrome.connect(signal, deps.timeout);
	try {
		const state = await session.call<{ video?: { id?: string } | null; note?: { id?: string } | null; url?: string }>(
			"video.info",
			{},
		);
		const current = state.video?.id ?? state.note?.id ?? null;
		if (!current) throw new CliError("unsupported_media", "There is no work on screen to steer");
		// The work is whichever one is on screen, and a request for a different one
		// is refused rather than chased.
		//
		// This used to prefer the requested id and navigate to it when the page held
		// something else. That turned a mismatch into a navigation: it left the feed,
		// landed on a surface with a different control layout, and every later call
		// did the same thing again. The check is the point — a press must land on the
		// work the caller named, and the only way to be sure is that the page is
		// already showing it.
		if (input.video_id && input.video_id !== current)
			throw new CliError("identity_mismatch", "The page is showing a different work than the one asked for", {
				hint: "Run this with that work on screen: dy feed open, then dy feed next until it arrives.",
				details: { asked: input.video_id, showing: current },
			});
		const workID = current;
		// Opening the menu is a hover, not a press: the control only carries
		// mouseenter handlers, and a press on it does nothing on the feed.
		//
		// The pointer has to leave first. A press in an earlier command leaves it
		// sitting on the control, and a mouseenter does not fire again for a pointer
		// that never moved — so the menu stays shut and the state read comes from a
		// strip that is not there.
		const opener = await session.call<{ x: number; y: number }>("steer.opener", {});
		await session.tab.mouse.move(opener.x, Math.max(0, opener.y - 120));
		await delay(120, undefined, { signal });
		await session.tab.mouse.move(opener.x, opener.y);
		await waitForMenu(session, signal);
		const token = randomUUID();
		const prepared = await session.call<Point & { already?: boolean }>("steer.prepare", {
			token,
			video_id: workID,
			direction,
			value,
		});
		const receipt: Receipt = {
			request_id: requestID,
			fingerprint: fingerprintOf(workID, direction, value),
			operation: "video.steer",
			target: { video_id: workID },
			...(deps.store.bot_id ? { bot_id: deps.store.bot_id } : {}),
			status: "prepared",
			created_at: new Date().toISOString(),
			updated_at: new Date().toISOString(),
		};
		await deps.store.saveReceipt(receipt);
		// A request for the state the page is already in needs no press, and is
		// recorded as such: "already so" and "I made it so" are different things to
		// whoever reads this receipt later.
		if (prepared.already) {
			receipt.status = "confirmed";
			receipt.updated_at = new Date().toISOString();
			receipt.result = { direction, video_id: workID, value, already: true };
			await deps.store.saveReceipt(receipt);
			return {
				request_id: requestID,
				confirmed: true,
				changed: false,
				direction,
				video_id: workID,
				value,
				toast: null,
				evidence: "already",
				limits: STEER_LIMITS,
			};
		}
		// A toast from an earlier action can still be on screen. What is compared is
		// the text, not the presence, so a lingering "已取消推荐" cannot confirm a
		// "less" press.
		const toastBefore = (await session.call<{ toast: string | null }>("steer.outcome", {})).toast;
		const armed = await session.call<Point>("steer.arm", { token, video_id: workID, direction, value });
		receipt.status = "dispatching";
		receipt.updated_at = new Date().toISOString();
		await deps.store.saveReceipt(receipt);
		await session.click(armed);
		const outcome = await settleSteer(session, { direction, value, work: workID, toastBefore, signal });
		if (!outcome.confirmed) {
			// The press may have landed and the page simply did not say so in the
			// window. Reporting "did not apply" would invite a second press, which is a
			// stronger instruction than the caller gave, so the receipt stays
			// dispatching and the caller is told to look.
			receipt.updated_at = new Date().toISOString();
			receipt.uncertainty_reason = "page_did_not_confirm";
			await deps.store.saveReceipt(receipt);
			throw new CliError("delivery_uncertain", "The steer was pressed but the page did not confirm it", {
				hint: [
					`Open the work in headed Chrome and check the menu: "less" leaves no state, so only the toast says it applied.`,
					`Do not press again with a new request id to make sure — that is a second instruction to the platform.`,
					`Run receipt get ${requestID} to see what was pressed.`,
				].join(" "),
				details: { request_id: requestID, receipt, toast: outcome.toast },
			});
		}
		receipt.status = "confirmed";
		receipt.updated_at = new Date().toISOString();
		receipt.result = { direction, video_id: workID, value: outcome.value, toast: outcome.toast };
		await deps.store.saveReceipt(receipt);
		await deps.store.append("video.steer", {
			request_id: requestID,
			video_id: workID,
			direction,
			...(input.goal ? { goal: input.goal } : {}),
			toast: outcome.toast,
			value: outcome.value,
		});
		return {
			request_id: requestID,
			confirmed: true,
			changed: true,
			direction,
			video_id: workID,
			value: outcome.value,
			toast: outcome.toast,
			evidence: outcome.evidence,
			limits: STEER_LIMITS,
		};
	} finally {
		await session.call("steer.cleanup").catch(() => undefined);
		await session.call("cleanup").catch(() => undefined);
		await session.close();
	}
}

// The menu renders a moment after the hover, and its position depends on the work
// under it. Polling the marked item is what tells "the menu opened" from "the hover
// has not been processed yet".
async function waitForMenu(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 4000;
	while (true) {
		signal.throwIfAborted();
		try {
			await session.call("steer.outcome", {});
			const opened = await session.call<{ open: boolean }>("steer.outcome", {});
			if (opened.open) return;
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "selector_changed") throw error;
		}
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The more-menu did not open", {
				hint: "The menu only exists on the recommended feed and the ?modal_id= overlay. Check that the tab is not covered.",
			});
		await delay(150, undefined, { signal });
	}
}

// What the page said after the press.
//
// "Less" is confirmed differently in the two forms the menu exists in, and that
// difference is the page's, not this command's:
//
//   on the feed     the page says so with a toast, and the feed moves on
//   in the overlay  it says nothing, and the overlay moves to the next work:
//                   `modal_id` changes under the reader
//
// Both are the platform acknowledging the instruction, and both mean the same
// thing — this work is done with. Reading only the toast made every "less" in the
// overlay unprovable, and an unprovable press is reported as uncertain, which is
// the one thing that invites a second one.
//
// What must not be mistaken for confirmation is the overlay moving on its own, so
// the press and the change have to be close in time: the work read at the start of
// this call is the work that was pressed, and a different work a moment later is
// the page moving because of it.
//
// "More" is a switch and its state is the evidence; the strip closes on that press
// too, so reading it means reopening the menu once the page has settled.
async function settleSteer(
	session: Session,
	options: { direction: Direction; value: boolean; work: string; toastBefore: string | null; signal: AbortSignal },
): Promise<{
	confirmed: boolean;
	value: boolean;
	toast: string | null;
	evidence: "page_toast" | "menu_label" | "moved_on" | null;
}> {
	const deadline = Date.now() + 6000;
	let toast: string | null = null;
	let reopened = false;
	let clicks = 0;
	while (Date.now() < deadline) {
		options.signal.throwIfAborted();
		await delay(250, undefined, { signal: options.signal });
		clicks++;
		const outcome = await session.call<{ toast: string | null; open: boolean; labels: string[]; work: string | null }>(
			"steer.outcome",
			{},
		);
		// The overlay's "less" closes the strip and says nothing else. A strip that is
		// shut, on the work that was asked for, after a press this command armed, is
		// that press landing: nothing else closes it.
		if (options.direction === "less" && !outcome.open && outcome.work && outcome.work !== options.work) {
			return { confirmed: true, value: true, toast, evidence: "moved_on" };
		}
		// A toast that was already on screen is not evidence for this press. The
		// comparison is on text, so a lingering "已取消推荐" cannot confirm a "less".
		if (outcome.toast && outcome.toast !== options.toastBefore) {
			toast = outcome.toast;
			if (TOASTS[options.direction].test(toast))
				return {
					confirmed: true,
					value: options.direction === "more" ? options.value : true,
					toast,
					evidence: "page_toast",
				};
		}
		if (options.direction !== "more") continue;
		if (outcome.open) {
			// The switch's own label is the state, so the answer is whether it now
			// reads the one that was asked for.
			const on = outcome.labels.some((label) => label === "取消推荐");
			if (on === options.value) return { confirmed: true, value: on, toast, evidence: "menu_label" };
			continue;
		}
		// The strip is closed — which is both what a completed press looks like and
		// what the page looks like in the moment before it re-renders the switch.
		// Reopening on the first closed read clicked the control again while the
		// page was still applying the first press. Two quiet reads first is what
		// separates "the press landed" from "nothing has happened yet".
		if (!reopened && clicks > 2) {
			reopened = true;
			await reopenMenu(session, options.signal);
		}
	}
	return { confirmed: false, value: false, toast, evidence: null };
}

// Hovering the `...` control opens the strip; a press does not, and does not need
// to. Best-effort: a failure here leaves the switch unread, which the caller
// reports rather than guessing at.
async function reopenMenu(session: Session, signal: AbortSignal): Promise<void> {
	try {
		const opener = await session.call<{ x: number; y: number }>("steer.opener", {});
		// The pointer is still sitting on the control from the press, and a
		// mouseenter does not fire again for a pointer that never left. Moving away
		// and back is what makes the second hover a hover at all; without it the menu
		// never reopened and every "more" press settled as unreadable.
		await session.tab.mouse.move(opener.x, Math.max(0, opener.y - 120));
		await delay(120, undefined, { signal });
		await session.tab.mouse.move(opener.x, opener.y);
		await waitForMenu(session, signal);
	} catch {
		// Left as it is: settleSteer's deadline decides the outcome.
	}
}
