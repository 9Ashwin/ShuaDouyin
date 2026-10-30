import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeManager, Point, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { quiet, type Reproduce } from "../progress.ts";
import type { Receipt, Store } from "../store.ts";
import { openComments } from "./comments.ts";
import { control, openSharePanel, selectChat } from "./navigation.ts";
import type { Input } from "./validate.ts";
import { checkVoice } from "./voice-check.ts";

// Account writes own the receipt contract: a receipt is durable before any
// input can dispatch, a confirmed request ID replays locally, and a possibly
// dispatched write is never repeated.

export interface WriteResult {
	confirmed: boolean;
	blocked?: boolean;
	dispatched?: boolean;
	value?: boolean;
	record?: unknown;
	loaded_matching_rows?: number;
	baseline_matching_text_rows?: number;
	uncertain_reason?: string;
}

function uncertain(key: string, receipt?: Receipt, cause?: unknown, reason?: string) {
	// "Inspect the page" was the whole instruction, and it is not enough: a read
	// taken while a verification mask covers the page returns a stale list, so a
	// comment that did post looks absent and the natural next move is to send it
	// again. That is how one comment became two. The hint now says what makes a
	// look trustworthy before it is used to decide.
	return new CliError("delivery_uncertain", "The operation may have reached Douyin; it was not repeated", {
		hint: [
			`Check that the page is not showing a verification or login gate — a read under one returns a stale list and says nothing about whether this landed.`,
			`dy auth status reports verification_required for both the slider gate and the SMS gate.`,
			`Only then read the page or run receipt get ${key}. A second request with a new id is a second message, not a retry.`,
		].join(" "),
		details: { request_id: key, receipt, ...(reason ? { reason } : {}), verify_before_retry: true },
		cause,
	});
}

// What the caller is told about how its own text reads. Only the verdict and the
// names of what was found travel with a successful send; the full report with
// offsets and reasons stays in `voice check`, which is where a caller goes when
// it wants to act on it.
export function verdictOf(text: string) {
	const { verdict, tells, overcorrected } = checkVoice(text);
	if (verdict === "reads-human" && !tells.length && !overcorrected.length) return { verdict };
	return {
		verdict,
		tells: [...new Set(tells.map((tell) => tell.name))],
		...(overcorrected.length ? { overcorrected: [...new Set(overcorrected.map((tell) => tell.name))] } : {}),
	};
}

export async function write(
	operation: string,
	input: Input,
	signal: AbortSignal,
	deps: { store: Store; chrome: ChromeManager; timeout: number; progress?: Reproduce },
): Promise<unknown> {
	const { store, chrome, timeout } = deps;
	const step = deps.progress ?? quiet;
	const action =
		operation === "comment.reply"
			? "comment.post"
			: operation === "chat.share" || operation === "chat.reply"
				? "chat.send"
				: operation;
	const payload = {
		action,
		video_id: input.video_id,
		comment_id: input.comment_id,
		user_id: input.user_id,
		conversation_id: input.conversation_id,
		recipient_id: input.recipient_id,
		reply_to: input.reply_to,
		// A quote target is part of the request identity, not decoration: the same
		// text replying to a different message is a different write.
		...(operation === "chat.reply" ? { message_index: input.message_index } : {}),
		// Who is addressed changes what the message is, so it belongs to the
		// request identity as well as to the page arguments.
		...(input.mention ? { mention: input.mention } : {}),
		// The sticker is part of what gets sent, so it is part of the identity too.
		...(input.emoji ? { emoji: input.emoji } : {}),
		text: input.text,
		value: input.enabled ?? true,
	};
	const fingerprint = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
	const key = input.request_id ?? randomUUID();
	const receipts = await store.receipts();
	const existing = Object.hasOwn(receipts, key) ? receipts[key] : undefined;
	if (existing) {
		if (existing.fingerprint !== fingerprint)
			throw new CliError("idempotency_conflict", "The request ID belongs to different input", {
				details: { request_id: key },
			});
		if (existing.status === "confirmed")
			return { request_id: key, confirmed: true, replayed: true, result: existing.result };
		if (existing.status !== "not_sent") throw uncertain(key, existing);
	}
	step("connecting", { operation });
	const session = await chrome.connect(signal, timeout);
	const args = { ...payload, token: randomUUID() };
	let receipt: Receipt | undefined;
	let mayHaveDispatched = false;
	let confirmedSaved = false;
	// A comment on someone's work is contact with that person, so the account
	// behind the work is recorded with the write. It is not part of the
	// fingerprint: it is read off the page, not supplied by the caller, and a
	// request that was already decided must not become a conflict because the
	// page happened not to expose it at review time.
	let authorID: string | null = null;
	let workAuthorID: string | null = null;
	// True once this attempt has typed into a composer. Everything in that editor
	// from then on came from this command, so a failure may clear it.
	let typed = false;
	try {
		if (operation === "chat.forward") {
			// The work must be the page's current work before its panel opens.
			const state = await session.call<{ video?: { id: string | null } | null; note?: { id: string } | null }>(
				"video.info",
				{},
			);
			const current = state.video?.id ?? state.note?.id ?? null;
			if (!current || current !== input.video_id)
				throw new CliError("identity_mismatch", "Current work does not match the requested video ID");
			await openSharePanel(session);
		}
		if (action === "chat.send") {
			step("selecting_conversation", { conversation_id: input.conversation_id ?? null });
			await selectChat(session, input.conversation_id ?? "", signal);
		}
		if (operation === "chat.reply") {
			// The quote state lives in the page, not in the text: the row's own reply
			// control is what makes the platform render 回复消息, and it must be set
			// before the composer is read or armed.
			const target = await session.call<{ x: number; y: number }>("chat.reply.prepare", {
				conversation_id: input.conversation_id,
				message_index: input.message_index,
				token: args.token,
			});
			if (target.x === undefined || target.y === undefined)
				throw new CliError("selector_changed", "Reply target has no click point");
			// A menu left open by an earlier attempt covers the target row and would
			// swallow the right-click, so any stale floating layer is dismissed first.
			await session.tab.keyboard.press("Escape");
			await delay(150, undefined, { signal });
			await session.tab.mouse.click(target.x, target.y, { button: "right" });
			await openQuoteMenu(session, signal);
			await waitQuote(session, signal);
		}
		if (action === "comment.post") {
			// Read before the panel opens: the detail card is what links the work to
			// its author, and the comment panel can cover it. Failing to read it is
			// not a reason to refuse the write, only a reason to record less.
			const state = await session.call<{ video?: { author_id?: string | null } | null }>("video.info", {});
			workAuthorID = state.video?.author_id ?? null;
			authorID = workAuthorID;
			step("opening_comments", { video_id: input.video_id ?? null });
			await openComments(session, input, signal);
			// A work whose author closed comments still shows the ones already there,
			// so nothing upstream can tell "this is a work with a comment box" from
			// "this is a work with a list and no box". Asking now is what turns a
			// silent eight-second wait into an answer: without it the send typed into
			// nothing, measured a zero-size button and reported delivery_uncertain —
			// which says the comment may exist when in fact it never could.
			const writable = await session.call<{ writable: boolean; reason: string | null }>("comment.writable", {});
			if (!writable.writable)
				throw new CliError("unsupported_page", writable.reason ?? "This work does not accept comments", {
					hint: "Nothing was typed or sent. Pick a work whose comment box is present.",
					details: { video_id: input.video_id ?? null, writable: false },
				});
			// The composer may already be in this comment's reply state, in which
			// case its reply control has become 回复中 and is no longer clickable.
			if (input.comment_id && !(await replyComposerReady(session, input.comment_id, signal))) {
				// The target may be further down a list that loads while scrolling.
				await revealCommentRow(session, input.comment_id, signal);
				await control(session, "comment.reply", input);
				// The composer is rendered by the page after the click; reading it
				// immediately would report an inactive editor.
				await waitReplyBound(session, input.comment_id, signal);
			}
			// A reply reaches the comment's author, not the work's. Crediting the
			// work's author would put the contact on the wrong person's card, which
			// is worse than recording no person at all: a wrong card is trusted.
			if (operation === "comment.reply" && input.comment_id) {
				await revealCommentRow(session, input.comment_id, signal);
				const owner = await session.call<{ found: boolean; author_id: string | null }>("comment.author", {
					comment_id: input.comment_id,
				});
				// An unreadable author leaves this null, and the event says so instead
				// of falling back to the work's author.
				authorID = owner.author_id;
			}
		}
		// A sticker never touches the composer, so it does not go through prepare:
		// that step exists to prove the text this command inserted is the text the
		// page holds, and it refuses a composer someone else filled. A draft left
		// by the owner is a reason not to type, not a reason to refuse a sticker.
		const sticker = action === "chat.send" && !!input.emoji;
		if (sticker) {
			const base = await session.call<{ before: unknown[]; emoji?: string }>("chat.baseline", {
				token: args.token,
				conversation_id: input.conversation_id,
				emoji: input.emoji,
			});
			if (!Array.isArray(base.before))
				throw new CliError("state_corrupt", "Baseline window was not readable", { details: base });
			if (base.emoji !== input.emoji)
				throw new CliError("state_corrupt", "Baseline did not record the sticker", {
					details: { sent: input.emoji, recorded: base.emoji },
				});
		}
		const prepared: { x?: number; y?: number; selector?: string; already?: boolean } = sticker
			? {}
			: operation === "chat.forward"
				? await prepareForwardPoint(session, input, args.token)
				: await prepare(session, action, input, args);
		// prepare() refuses a composer that already holds a draft, so the mention
		// must come after it: choosing one inserts a node into the editor.
		if (prepared.already) return { confirmed: true, changed: false, value: input.enabled ?? true };
		const now = new Date().toISOString();
		receipt = {
			request_id: key,
			fingerprint,
			operation,
			target: {
				...(input.video_id ? { video_id: input.video_id } : {}),
				...(input.comment_id ? { comment_id: input.comment_id } : {}),
				...(input.user_id ? { user_id: input.user_id } : {}),
				...(input.recipient_id ? { recipient_id: input.recipient_id } : {}),
				...(input.conversation_id ? { conversation_id: input.conversation_id } : {}),
			},
			...(store.bot_id ? { bot_id: store.bot_id } : {}),
			status: "prepared",
			created_at: now,
			updated_at: now,
		};
		await store.saveReceipt(receipt);
		let point = prepared;
		// A sticker in a conversation is a whole message: the platform sends it
		// the moment it is clicked, so there is no composer to fill and no send
		// button to press. Validation already refused text beside one, which means
		// this path both types nothing and dispatches nothing further.
		const stickerOnly = sticker;
		if (stickerOnly) {
			await pickEmoji(session, input, args.token, signal);
			// Choosing the sticker is the send, so the page has to be told that a
			// dispatch happened before its result can be read at all. A witness
			// that lost its target here means the page changed under the click.
			const after = await session.call<{ emoji: string | null; dispatched: boolean }>("chat.witness", {});
			if (after.emoji !== input.emoji)
				throw new CliError("state_corrupt", "Sticker witness was lost while sending", {
					details: { after, want: input.emoji },
				});
		}
		if (!stickerOnly && prepared.selector && (action === "comment.post" || action === "chat.send")) {
			await session.tab.locator(prepared.selector).focus();
			// The mention must be chosen while the composer is still empty: it is a
			// node the page inserts, and typing the text first would leave the picker
			// filtering against the wrong prefix.
			if (action === "chat.send" && input.mention) await mentionMember(session, input, signal);
			// From the first inserted character this command owns the composer, so
			// anything in it afterwards is this attempt's residue. A send that then
			// fails used to leave its own text behind, and the next send to that
			// conversation was refused as a draft conflict — one failure made every
			// later attempt fail, and chat close refused too because it was a draft.
			typed = true;
			await session.tab.keyboard.insertText(input.text ?? "");
			// In a comment a sticker is a fragment rather than a message, so it is
			// picked after the text and lands at its end.
			if (input.emoji) await pickEmoji(session, input, args.token, signal);
			point = await session.call<Point>("arm-write", args);
		}
		// A reply lands inside the target's collapsed reply section. Opening it
		// before the send lets the receipt read the new row afterwards; without
		// this the reply is invisible and the send can never be confirmed.
		if (operation === "comment.reply" && input.comment_id) {
			await expandReplies(session, input.video_id ?? "", input.comment_id, signal);
			// Expansion has its own click guard; restore the send guard and recheck
			// the original composer and draft before any dispatch.
			point = await session.call<Point>("arm-write", args);
		}
		// The share row is re-verified immediately before the click lands.
		if (operation === "chat.forward")
			point = await session.call<Point>("forward.arm", {
				token: args.token,
				recipient_id: input.recipient_id,
				video_id: input.video_id ?? "",
			});
		receipt.status = "dispatching";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		mayHaveDispatched = true;
		// A caller watching this line knows the point of no return has passed:
		// everything before it could still fail without sending anything, and
		// everything after it is confirmation.
		step("dispatching", { request_id: key });
		// The sticker was already dispatched by the click that chose it, so
		// clicking anything else here would send a second message.
		if (!stickerOnly) await session.click(point);
		// The new reply lands in the target's reply section, which the page
		// collapses after posting. Re-opening it is what makes the row readable
		// for the receipt; a section already open is left alone.
		if (operation === "comment.reply" && input.comment_id) {
			await delay(700, undefined, { signal });
			await expandReplies(session, input.video_id ?? "", input.comment_id, signal);
		}
		step("confirming", { request_id: key });
		const confirmed =
			operation === "chat.forward"
				? await settleForward(session, {
						token: args.token,
						recipient_id: input.recipient_id,
						video_id: input.video_id ?? "",
						signal,
					})
				: await settle(session, args, signal);
		if (confirmed.blocked && !confirmed.dispatched) {
			mayHaveDispatched = false;
			// The guard knows which check refused; without carrying that through,
			// every refusal read the same and none of them could be acted on.
			const fields = confirmed && typeof confirmed === "object" ? (confirmed as Record<string, unknown>) : {};
			const reason = String(fields.blocked_reason ?? "");
			const detail = String(fields.blocked_detail ?? "");
			throw new CliError("identity_mismatch", "Input was blocked because the target or draft changed", {
				hint: reason ? `The page refused the click: ${reason} ${detail}`.trim() : "",
				details: reason ? { blocked_reason: reason, ...(detail ? { blocked_detail: detail } : {}) } : undefined,
			});
		}
		if (!confirmed.result) {
			const candidate = confirmed.record;
			if (
				confirmed.dispatched &&
				typeof confirmed.loaded_matching_rows === "number" &&
				confirmed.loaded_matching_rows > 0
			)
				receipt.observation = {
					candidate_id:
						candidate && typeof candidate === "object" && "id" in candidate && typeof candidate.id === "string"
							? candidate.id
							: null,
					kind: "matching_loaded_row",
					loaded_matching_rows: confirmed.loaded_matching_rows,
					baseline_matching_text_rows: confirmed.baseline_matching_text_rows ?? 0,
					delivery_verified: false,
				};
			if (confirmed.uncertain_reason) {
				receipt.uncertainty_reason = confirmed.uncertain_reason;
				receipt.updated_at = new Date().toISOString();
			}
			if (confirmed.uncertain_reason || receipt.observation) await store.saveReceipt(receipt);
			throw uncertain(key, receipt, undefined, confirmed.uncertain_reason);
		}
		receipt.status = "confirmed";
		receipt.updated_at = new Date().toISOString();
		receipt.result = confirmed.result;
		await store.saveReceipt(receipt);
		confirmedSaved = true;
		await store.append(operation, {
			request_id: key,
			...payload,
			// The author is who this write reached. Without it a comment is only an
			// event about a work, and the relationship card the social layer builds
			// from events never learns the person exists. A reply names the person it
			// replied to; the work's author is kept beside it as context, never as the
			// subject, because the card is built from the subject.
			...(authorID ? { user_id: authorID } : {}),
			...(operation === "comment.reply" && workAuthorID && workAuthorID !== authorID
				? { work_author_id: workAuthorID }
				: {}),
			...(operation === "comment.reply" && !authorID ? { reply_author_unavailable: true } : {}),
			// Which goal this action served. It decides the card's stage vocabulary
			// and counts against that goal's daily limit.
			...(input.goal ? { goal: input.goal } : {}),
			result: confirmed.result,
		});
		step("confirmed", { request_id: key });
		return {
			request_id: key,
			confirmed: true,
			changed: true,
			result: confirmed.result,
			// A public comment carries this account's voice, so the report says how
			// it reads. Reported, never enforced: the tell catalog is advice, and
			// blocking a send on it would be the tool deciding what the account may
			// say. Chat messages are left out — they are not public prose.
			...(operation === "comment.post" || operation === "comment.reply" ? { voice: verdictOf(input.text ?? "") } : {}),
		};
	} catch (error) {
		// Clear this attempt's own typing before anything else. Nothing is sent, so
		// the text is residue, and leaving it makes the composer look like a user
		// draft to every later command on this conversation.
		if (typed && !mayHaveDispatched) await clearComposer(session, action);
		if (receipt && !mayHaveDispatched) {
			receipt.status = "not_sent";
			receipt.updated_at = new Date().toISOString();
			await store.saveReceipt(receipt);
		}
		if (mayHaveDispatched && !confirmedSaved) {
			if (error instanceof CliError && error.code === "delivery_uncertain") throw error;
			throw uncertain(key, receipt, error);
		}
		throw error;
	} finally {
		await session.call("cleanup").catch(() => undefined);
		await session.close();
	}
}

// The share panel may list more recipients than fit on screen, so a missing
// target is looked for by scrolling before the operation is refused.
async function prepareForwardPoint(session: Session, input: Input, token: string): Promise<Point> {
	const args = { token, recipient_id: input.recipient_id, video_id: input.video_id };
	// A row that is rendered but covered by the panel footer cannot be clicked.
	// Each pass scrolls it toward the middle and lets the page settle before the
	// click point is recomputed.
	let last: unknown;
	for (let attempt = 0; attempt < 5; attempt++) {
		try {
			return await session.call<Point>("forward.prepare", args);
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "identity_mismatch") throw error;
			last = error;
			const reveal = await session.call<{ revealed: boolean; found: boolean }>("forward.reveal", {
				recipient_id: input.recipient_id,
			});
			// Missing entirely: no amount of scrolling will produce the row.
			if (!reveal.found) throw error;
			// Already in the clear yet still refused: the refusal is not about
			// occlusion, so scrolling again changes nothing.
			if (reveal.revealed && attempt > 0) throw error;
			await delay(300);
		}
	}
	throw last;
}

// True when the composer is already bound to the requested comment. The reply
// control turns into 回复中 once bound and can no longer be clicked, so this must
// be settled before the click is attempted.
async function replyComposerReady(session: Session, commentID: string, signal: AbortSignal): Promise<boolean> {
	signal.throwIfAborted();
	const state = await session.call<{ bound_to?: string | null }>("comment.reply.state", { comment_id: commentID });
	return state.bound_to === commentID;
}

// Only the CLI's own trigger text is removed here: an existing user draft is
// refused before this point, so anything in the composer at failure time is
// residue from this attempt.
async function clearComposer(session: Session, action = "chat.send"): Promise<void> {
	// Both composers are Draft.js editors, and a Draft.js content div carries
	// contenteditable="false" — the library drives it through React, so the
	// attribute says nothing about whether it can be typed into. Selecting on
	// contenteditable="true" therefore found the chat editor (which sets it) and
	// missed the comment editor entirely, which is why a failed comment left its
	// text in the box and every later attempt on that work was refused as a draft
	// conflict.
	const editor =
		action === "chat.send"
			? session.tab
					.locator(
						'[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"],[data-e2e="im-dialog"] .public-DraftEditor-content',
					)
					.first()
			: session.tab.locator('[class*="comment-input"] .public-DraftEditor-content,.public-DraftEditor-content').first();
	const present = await editor.count().catch(() => 0);
	if (!present) return;
	await editor.click({ timeout: 3000 }).catch(() => undefined);
	// One select-all, chosen by platform. Pressing both was tried and is wrong:
	// on macOS the editor treats Control+A as a move-to-line-start, which drops
	// the selection Meta+A had just made, and the Backspace then deleted nothing.
	await session.tab.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A").catch(() => undefined);
	await session.tab.keyboard.press("Backspace").catch(() => undefined);
	// Clearing is a claim like any other, so it is checked: a page that ignored the
	// keystrokes would otherwise leave the residue in place while the command
	// reported that it had cleaned up.
	const left = await editor.innerText().catch(() => "");
	if (left.replace(/[\u200b\ufeff]/g, "").trim()) {
		// A verification mask or another overlay can hold the click. Saying so is
		// more useful than pretending the box is empty.
		throw new CliError("draft_conflict", "The composer still holds text after clearing", {
			hint: `Clear it by hand before retrying. It now reads: ${left.slice(0, 120)}`,
			details: { remaining: left.slice(0, 200) },
		});
	}
}

// Typing @ opens the group member picker; choosing an entry turns it into a real
// mention node in the editor, which the platform delivers as a notification.
// The picker is filled asynchronously, so it is waited for before the choice.
async function mentionMember(session: Session, input: Input, signal: AbortSignal): Promise<void> {
	const editor = session.tab.locator('[data-e2e="im-dialog"] [data-e2e="msg-input"] [contenteditable="true"]').first();
	await editor.click();
	await session.tab.keyboard.insertText("@");
	try {
		await chooseMention(session, input, signal);
	} catch (error) {
		// The trigger this function typed is its own residue: leaving it behind
		// makes the next call look like a user draft and blocks the retry.
		await clearComposer(session);
		throw error;
	}
}

// A sticker is a platform asset, not text: it is chosen from the composer's
// smiley grid and sent as its own message. The grid names each item itself, so
// an unknown name is refused rather than approximated — sending the wrong
// sticker is visible to everyone in the conversation and cannot be taken back.
async function pickEmoji(session: Session, input: Input, token: string, signal: AbortSignal): Promise<void> {
	// The sticker panel is a modal over the composer and covers the smiley that
	// opens it, so a panel left by an earlier attempt hides the control and its
	// guard rightly refuses the click. Escape does not close this one; a press
	// outside it does, and the composer's own corner is such a place.
	await session.tab.keyboard.press("Escape");
	await delay(120, undefined, { signal });
	const outside = await session.call<{ x: number; y: number }>("emoji.dismiss", {});
	await session.tab.mouse.click(outside.x, outside.y);
	await delay(150, undefined, { signal });
	const trigger = await session.call<Point>("emoji.prepare", {
		conversation_id: input.conversation_id,
		token,
	});
	await session.click(trigger);
	const deadline = Date.now() + 4000;
	while (true) {
		signal.throwIfAborted();
		const panel = await session.call<{ open: boolean; names: string[] }>("emoji.panel", {});
		if (panel.open) {
			const wanted = (input.emoji ?? "").trim();
			if (!panel.names.includes(wanted))
				throw new CliError("invalid_argument", "The composer has no sticker with that name", {
					hint: "Open chat read or the page's smiley to see the names the platform uses.",
					details: { available: panel.names.slice(0, 24) },
				});
			// The grid is built in two passes and the panel is taller than its
			// viewport, so a measured point can be stale or covered by the time the
			// click lands. One retry is enough: a second failure means the panel
			// genuinely does not offer that sticker, and guessing again could pick
			// a neighbour and send the wrong one.
			let last: unknown;
			// The grid is appended in a second render pass, so its items are in the
			// document before their handlers are. One frame of settle time is what
			// separates "the panel is drawn" from "a press on it does something".
			await delay(250, undefined, { signal });
			for (let attempt = 0; attempt < 2; attempt++) {
				const pick = await session.call<{ found: boolean; x?: number; y?: number }>("emoji.pick", {
					emoji: wanted,
				});
				if (!pick.found) throw new CliError("selector_changed", "The sticker left the panel while choosing it");
				if (pick.x === undefined || pick.y === undefined)
					throw new CliError("selector_changed", "Sticker has no click point");
				try {
					await session.click({ x: pick.x, y: pick.y });
					// The click itself is the send, so the page has to be told a
					// dispatch happened before its result can be read as confirmed.
					const witness = await session.call<{ emoji: string | null }>("emoji.dispatched", {});
					if (witness.emoji !== wanted)
						throw new CliError("state_corrupt", "The sticker witness lost its target", {
							details: { wanted, witness },
						});
					return;
				} catch (error) {
					last = error;
					await delay(200, undefined, { signal });
				}
			}
			throw last;
		}
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The sticker panel did not open", {
				hint: "Open the conversation in headed Chrome and check the smiley in the composer.",
			});
		await delay(150, undefined, { signal });
	}
}

async function chooseMention(session: Session, input: Input, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 4000;
	while (true) {
		signal.throwIfAborted();
		const picker: { x?: number; y?: number } = await session
			.call<{ x?: number; y?: number }>("chat.mention.prepare", {
				conversation_id: input.conversation_id,
				mention: input.mention,
				token: randomUUID(),
			})
			.catch((error: unknown) => {
				// A picker that has not rendered yet is a wait, not a failure.
				if (error instanceof CliError && error.code === "selector_changed") return {};
				throw error;
			});
		const point = picker;
		if (point.x !== undefined && point.y !== undefined) {
			await session.click({ x: point.x, y: point.y });
			break;
		}
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The group mention picker did not offer the requested member", {
				hint: "Open the group in headed Chrome and check the exact display name shown in the picker.",
			});
		await delay(150, undefined, { signal });
	}
	const deadlineState = Date.now() + 3000;
	while (true) {
		signal.throwIfAborted();
		const state = await session.call<{ mentions: string[] }>("chat.mention.state", {});
		if (state.mentions.length) return;
		if (Date.now() >= deadlineState)
			throw new CliError("selector_changed", "The mention did not become a mention node in the editor");
		await delay(120, undefined, { signal });
	}
}

// The reply menu is a floating panel anchored at the click point. Its items are
// labelled text, not buttons, and it is rendered asynchronously, so the label is
// polled briefly instead of read once.
async function openQuoteMenu(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 3000;
	while (true) {
		signal.throwIfAborted();
		const point = await session.call<Point & { already?: boolean }>("chat.reply.menu", {});
		if (point.already) return;
		if (point.x !== undefined && point.y !== undefined) {
			await session.click({ x: point.x, y: point.y });
			return;
		}
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The reply menu did not appear", {
				hint: "Right-click the message in headed Chrome and check that 回复 is offered.",
			});
		await delay(150, undefined, { signal });
	}
}

// A quote block appearing above the editor is the only evidence that the page
// accepted the reply state; sending without it would post a plain message.
async function waitQuote(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 3000;
	while (true) {
		signal.throwIfAborted();
		const state = await session.call<{ present: boolean; quoted: string | null }>("chat.reply.state", {});
		if (state.present) return;
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The reply quote did not appear above the editor");
		await delay(120, undefined, { signal });
	}
}

// Opens the target's collapsed reply section when it is closed, so the reply
// that follows can be read back. Already-open sections and rows without an
// expand control need nothing.
async function expandReplies(session: Session, videoID: string, commentID: string, signal: AbortSignal): Promise<void> {
	const target = await session.call<Point | null>("comment.expand", {
		video_id: videoID,
		comment_id: commentID,
		token: randomUUID(),
	});
	if (!target) return;
	await session.click(target);
	await delay(600, undefined, { signal });
}

// Comments below the fold are not in the DOM until the page loads them, so the
// list is paged until the requested comment appears. A list that stops growing
// means the comment is not reachable, which is reported rather than clicked at.
async function revealCommentRow(session: Session, commentID: string, signal: AbortSignal): Promise<void> {
	for (let step = 0; step < 12; step++) {
		signal.throwIfAborted();
		const state = await session.call<{ present: boolean; moved: boolean }>("comment.reveal", {
			comment_id: commentID,
		});
		if (state.present) return;
		if (!state.moved) break;
		await delay(400, undefined, { signal });
	}
	throw new CliError("not_found", "The requested comment is not reachable by scrolling", {
		hint: "Open the work, load more comments, and retry with a comment ID from comment list.",
	});
}

// Waits for the composer to reach this comment's reply state after the control
// is clicked. Failing here means the reply would go to the wrong place, so it
// is reported rather than followed by an unverified send.
async function waitReplyBound(session: Session, commentID: string, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		if (await replyComposerReady(session, commentID, signal)) return;
		await delay(200, undefined, { signal });
	}
	throw new CliError("identity_mismatch", "The comment composer did not enter reply state for this comment");
}

// A lazy comment composer has to be activated before it can accept input.
async function prepare(
	session: Session,
	action: string,
	input: Input,
	args: object,
): Promise<{ x?: number; y?: number; selector?: string; already?: boolean; token: string }> {
	try {
		return await session.call("prepare-write", args);
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== "editor_not_ready" || action !== "comment.post") throw error;
		await control(session, "comment.activate", input);
		return session.call("prepare-write", args);
	}
}

// A missing share row does not prove delivery. Keep the dispatch receipt
// unresolved until a future implementation can verify the actual message.
async function settleForward(
	session: Session,
	args: { token: string; recipient_id?: string; video_id: string; signal: AbortSignal },
): Promise<{
	confirmed: boolean;
	blocked?: boolean;
	dispatched?: boolean;
	result?: unknown;
	uncertain_reason?: string;
	record?: unknown;
	loaded_matching_rows?: number;
	baseline_matching_text_rows?: number;
}> {
	const deadline = Date.now() + 10000;
	let previous: string | undefined;
	while (Date.now() < deadline) {
		const outcome = await session.call<{
			confirmed: boolean;
			blocked?: boolean;
			dispatched?: boolean;
			uncertain?: boolean;
			record?: unknown;
		}>("forward.result", {
			token: args.token,
			recipient_id: args.recipient_id,
			video_id: args.video_id,
		});
		if (outcome.blocked && !outcome.dispatched)
			return { confirmed: false, blocked: true, dispatched: false, result: undefined };
		// An uncertain first read is not a verdict: the button relabels a moment
		// after the click, and giving up on the first look reported every share as
		// uncertain even when it landed. Keep reading until the window closes.
		if (outcome.uncertain) {
			previous = undefined;
			await delay(250);
			continue;
		}
		const signature = JSON.stringify(outcome);
		if (outcome.confirmed && signature === previous)
			return { confirmed: true, dispatched: true, result: outcome.record };
		previous = outcome.confirmed ? signature : undefined;
		await delay(250);
	}
	return { confirmed: false, dispatched: true, result: undefined };
}

// Confirmation requires the same confirmed result observed twice, so a single
// optimistic DOM frame cannot be mistaken for a delivered write.
async function settle(
	session: Session,
	args: object,
	signal: AbortSignal,
): Promise<{
	confirmed?: boolean;
	blocked?: boolean;
	dispatched?: boolean;
	result?: unknown;
	uncertain_reason?: string;
	record?: unknown;
	loaded_matching_rows?: number;
	baseline_matching_text_rows?: number;
}> {
	const deadline = Date.now() + 8000;
	let previous: string | undefined;
	// The last answer is kept rather than thrown away: a send that never becomes
	// provable is still a send, and its reason is what the receipt records.
	let last: WriteResult | undefined;
	while (Date.now() < deadline) {
		const result = await session.call<WriteResult>("write-result", args);
		last = result;
		const signature = JSON.stringify(result);
		if (result.confirmed && signature === previous) return { ...result, result };
		if (result.blocked && !result.dispatched) return { ...result, result: undefined };
		// An unconfirmed answer is not final: the row a send produces is rendered a
		// moment after the click, and giving up on the first look reports delivery
		// as uncertain even though it landed. Only a repeated confirmation settles
		// the operation early; everything else waits for the full window.
		previous = result.confirmed ? signature : undefined;
		await delay(200, undefined, { signal });
	}
	if (!last) return { blocked: false, dispatched: true, result: undefined };
	return { ...last, confirmed: false, result: undefined };
}
