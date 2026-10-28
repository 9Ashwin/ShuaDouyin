import { createHash, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { ChromeManager } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Receipt, Store } from "../store.ts";
import type { readImage } from "./image-file.ts";
import { control } from "./navigation.ts";
import type { Input } from "./validate.ts";

type Image = Awaited<ReturnType<typeof readImage>>;
function uncertain(requestID: string, receipt?: Receipt, cause?: unknown) {
	return new CliError(
		"delivery_uncertain",
		"The image comment may have been uploaded or published; it was not repeated",
		{
			cause,
			hint: `Inspect receipt get ${requestID} and the work before acting again.`,
			details: { request_id: requestID, receipt },
		},
	);
}
export async function sendCommentImage(
	input: Input,
	image: Image,
	signal: AbortSignal,
	deps: { store: Store; chrome: ChromeManager; timeout: number },
) {
	const { store, chrome, timeout } = deps;
	const request = input.request_id ?? "";
	const fingerprint = createHash("sha256")
		.update(JSON.stringify({ action: "comment.image", video_id: input.video_id, image_sha256: image.sha256 }))
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
		await session.call("video.info", input);
		await control(session, "comment.open", input);
		const inner = session.tab.locator(".comment-input-inner-container");
		const outer = session.tab.locator(".comment-input-container");
		const composer = (await inner.count()) === 1 ? inner : outer;
		if ((await composer.count()) !== 1) throw new CliError("selector_changed", "Comment composer is ambiguous");
		await composer.scrollIntoViewIfNeeded();
		let prepared: { selector: string };
		const args = {
			video_id: input.video_id,
			token,
			file_name: image.name,
			file_size: image.bytes.length,
			file_mime: image.mime,
		};
		try {
			prepared = await session.call("comment.image.prepare", args);
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "editor_not_ready") throw error;
			await control(session, "comment.activate", input);
			await delay(250, undefined, { signal });
			prepared = await session.call("comment.image.prepare", args);
		}
		const now = new Date().toISOString();
		receipt = {
			request_id: request,
			fingerprint,
			operation: "comment.image",
			...(store.bot_id ? { bot_id: store.bot_id } : {}),
			status: "prepared",
			created_at: now,
			updated_at: now,
			target: { video_id: input.video_id },
			media: { sha256: image.sha256, mime: image.mime, bytes: image.bytes.length },
		};
		await store.saveReceipt(receipt);
		signal.throwIfAborted();
		await session.call("comment.image.preflight", { token });
		receipt.status = "dispatching";
		receipt.media_stage = "selection_attempted";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		await session.call("comment.image.preflight", { token });
		mayHaveDispatched = true;
		await session.tab
			.locator(prepared.selector)
			.setInputFiles({ name: image.name, mimeType: image.mime, buffer: image.bytes }, { timeout: 3000 });
		const state = await session.call<{ accepted: boolean; blocked: boolean }>("comment.image.state", {
			video_id: input.video_id,
			token,
		});
		if (state.blocked || !state.accepted) {
			receipt.uncertainty_reason = "comment_image_upload_unverified";
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		receipt.media_stage = "selection_dispatched";
		let confirm: { selector?: string } | undefined;
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				confirm = await session.call("comment.image.confirm.prepare", {
					video_id: input.video_id,
					token,
					file_size: image.bytes.length,
					file_sha256: image.sha256,
				});
				break;
			} catch (error) {
				if (
					!(error instanceof CliError) ||
					error.code !== "selector_changed" ||
					!error.message.includes("comment image preview, found 0")
				)
					throw error;
				await delay(250, undefined, { signal });
			}
		}
		if (!confirm?.selector) {
			receipt.uncertainty_reason = "comment_image_preview_unverified";
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		receipt.media_stage = "confirmation_ready";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		receipt.media_stage = "send_attempted";
		receipt.updated_at = new Date().toISOString();
		await store.saveReceipt(receipt);
		const before = await session.call<{ dispatched: boolean; blocked: boolean }>("comment.image.confirm.state", {
			video_id: input.video_id,
			token,
		});
		if (before.dispatched || before.blocked) {
			receipt.uncertainty_reason = "comment_image_confirmation_already_attempted";
			await store.saveReceipt(receipt);
			throw uncertain(request, receipt);
		}
		await session.tab.locator(confirm.selector).click({ timeout: 3000 });
		const result = await session.call<{ dispatched: boolean; blocked: boolean }>("comment.image.confirm.state", {
			video_id: input.video_id,
			token,
		});
		if (result.dispatched) receipt.media_stage = "send_dispatched";
		receipt.comment_observation = {
			preview_verified: true,
			publish_dispatched: result.dispatched,
			delivery_verified: false,
		};
		receipt.uncertainty_reason = result.blocked
			? "comment_image_guard_blocked_after_attempt"
			: "comment_image_delivery_unverified";
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
		await session.call("comment.image.cleanup", { token }).catch(() => undefined);
		await session.close();
	}
}
