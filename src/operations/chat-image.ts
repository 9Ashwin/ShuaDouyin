import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeManager } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt, Store } from "../store.ts";
import type { readImage } from "./image-file.ts";
import { selectChat } from "./navigation.ts";
import type { Input } from "./validate.ts";

type Image = Awaited<ReturnType<typeof readImage>>;

export async function sendChatImage(
	input: Input,
	image: Image,
	signal: AbortSignal,
	deps: { store: Store; chrome: ChromeManager; timeout: number },
) {
	const { store, chrome, timeout } = deps;
	const request = input.request_id ?? "";
	const fingerprint = createHash("sha256")
		.update(
			JSON.stringify({ action: "chat.image", conversation_id: input.conversation_id, image_sha256: image.sha256 }),
		)
		.digest("hex");
	const receipts = await store.receipts();
	const existing = Object.hasOwn(receipts, request) ? receipts[request] : undefined;
	if (existing) {
		if (existing.fingerprint !== fingerprint)
			throw new CliError("idempotency_conflict", "The request ID belongs to different input");
		if (existing.status === "confirmed")
			return { request_id: request, confirmed: true, replayed: true, result: existing.result };
		if (existing.status !== "not_sent") throw uncertain(request, existing);
	}
	const session = await chrome.connect(signal, timeout);
	const token = randomUUID();
	let receipt: Receipt | undefined;
	let mayHaveDispatched = false;
	try {
		await selectChat(session, input.conversation_id ?? "", signal);
		const prepared = await session.call<{ selector: string }>("chat.image.prepare", {
			conversation_id: input.conversation_id,
			token,
			file_name: image.name,
			file_size: image.bytes.length,
			file_mime: image.mime,
		});
		const now = new Date().toISOString();
		receipt = {
			request_id: request,
			fingerprint,
			operation: "chat.image",
			...(store.bot_id ? { bot_id: store.bot_id } : {}),
			status: "prepared",
			created_at: now,
			updated_at: now,
			target: { conversation_id: input.conversation_id },
			media: { sha256: image.sha256, mime: image.mime, bytes: image.bytes.length },
		};
		await store.saveReceipt(receipt);
		signal.throwIfAborted();
		await session.call("chat.image.preflight", { token });
		receipt.status = "dispatching";
		receipt.media_stage = "selection_attempted";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		await session.call("chat.image.preflight", { token });
		mayHaveDispatched = true;
		await session.tab
			.locator(prepared.selector)
			.setInputFiles({ name: image.name, mimeType: image.mime, buffer: image.bytes }, { timeout: 3000 });
		const state = await session.call<{ accepted: boolean; blocked: boolean }>("chat.image.state", {
			conversation_id: input.conversation_id,
			token,
		});
		if (state.blocked || !state.accepted) {
			receipt.uncertainty_reason = state.blocked
				? "image_upload_guard_blocked_after_dispatch"
				: "image_upload_witness_unavailable";
			receipt.updated_at = new Date().toISOString();
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		receipt.media_stage = "selection_dispatched";
		let confirm: { selector?: string } | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				confirm = await session.call("chat.image.confirm.prepare", {
					conversation_id: input.conversation_id,
					token,
					file_name: image.name,
					file_size: image.bytes.length,
					file_sha256: image.sha256,
				});
				break;
			} catch (error) {
				if (
					!(error instanceof CliError) ||
					error.code !== "selector_changed" ||
					!error.message.includes("image confirmation dialog, found 0")
				)
					throw error;
				await delay(250, undefined, { signal });
			}
		}
		if (!confirm?.selector) {
			receipt.uncertainty_reason = "image_preview_unverified";
			receipt.updated_at = new Date().toISOString();
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		receipt.media_stage = "confirmation_ready";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		const send = session.tab.locator(confirm.selector);
		receipt.media_stage = "send_attempted";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		const beforeSend = await session.call<{ dispatched: boolean; blocked: boolean }>("chat.image.confirm.state", {
			conversation_id: input.conversation_id,
			token,
		});
		if (beforeSend.dispatched || beforeSend.blocked) {
			receipt.uncertainty_reason = "image_confirmation_already_attempted";
			receipt.updated_at = new Date().toISOString();
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		await send.click({ timeout: 3000 });
		const result = await session.call<{ dispatched: boolean; blocked: boolean; dialog_closed: boolean }>(
			"chat.image.confirm.state",
			{ conversation_id: input.conversation_id, token },
		);
		if (result.dispatched) receipt.media_stage = "send_dispatched";
		receipt.media_observation = {
			preview_verified: true,
			confirm_dispatched: result.dispatched,
			dialog_closed: result.dialog_closed,
			delivery_verified: false,
		};
		receipt.uncertainty_reason = result.blocked
			? "image_send_guard_blocked_after_attempt"
			: "image_delivery_unverified";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		throw uncertain(request, receipt);
	} catch (error) {
		if (receipt && !mayHaveDispatched) {
			receipt.status = "not_sent";
			delete receipt.media_stage;
			receipt.updated_at = new Date().toISOString();
			await store.saveReceipt(receipt);
		}
		if (mayHaveDispatched) {
			if (error instanceof CliError && error.code === "delivery_uncertain") throw error;
			throw uncertain(request, receipt, error);
		}
		throw error;
	} finally {
		await session.call("chat.image.cleanup", { token }).catch(() => undefined);
		await session.close();
	}
}
function uncertain(requestID: string, receipt?: Receipt, cause?: unknown) {
	return new CliError("delivery_uncertain", "The image may have been uploaded or sent; it was not repeated", {
		cause,
		hint: `Inspect receipt get ${requestID} and the conversation before acting again.`,
		details: { request_id: requestID, receipt },
	});
}
