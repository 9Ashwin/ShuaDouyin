import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { atomicCreate } from "../store.ts";
import { control, selectChat } from "./navigation.ts";
import type { Input } from "./validate.ts";

// Private chats: the stable conversation ID is the only valid send target.
// Display names are data, not identifiers.

export async function listChats(session: Session): Promise<unknown> {
	await control(session, "chat.open");
	await delay(200);
	return session.call("chat.list");
}

export async function readChat(session: Session, input: Input, signal: AbortSignal): Promise<unknown> {
	await selectChat(session, input.conversation_id ?? "", signal);
	// `--scrolls N` walks N pages back before reading. The list is virtualised, so
	// rows from before this window only exist once the scroller has moved; reading
	// first and scrolling after would report the same window twice.
	const scrolls = input.scrolls ?? 0;
	const walked: { before: number; after: number; at_top: boolean }[] = [];
	for (let step = 0; step < scrolls; step++) {
		const moved = await session.call<{ before: number; after: number; at_top: boolean }>("chat.scroll", {
			index: 1,
			pixels: input.pixels ?? 1200,
		});
		walked.push(moved);
		if (moved.at_top) break;
		await delay(400, undefined, { signal });
	}
	const read = (await session.call<Record<string, unknown>>("chat.read", input)) as Record<string, unknown>;
	return walked.length
		? { ...read, scrolled: { pages: walked.length, reached_top: walked.at(-1)?.at_top ?? false } }
		: read;
}

export async function captureChatImage(
	session: Session,
	store: { path: (name: string) => string },
	input: Input,
	signal: AbortSignal,
) {
	await selectChat(session, input.conversation_id ?? "", signal);
	const token = randomUUID();
	try {
		await session.call("chat.capture.prepare", { ...input, token });
		const pixels = await session.call<{ base64: string }>("chat.capture.pixels", { token });
		const bytes = Buffer.from(pixels.base64, "base64");
		signal.throwIfAborted();
		await session.call("chat.capture.verify", { token });
		if (bytes.length > 20_000_000) throw new CliError("unsupported_media", "Captured image exceeds the size limit");
		const path = resolve(input.output ?? store.path(join("captures", `chat-${randomUUID()}.png`)));
		try {
			await atomicCreate(path, bytes);
		} catch (cause) {
			if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
				throw new CliError("revision_conflict", "Capture output already exists", { cause, details: { path } });
			throw cause;
		}
		return {
			path,
			mime: "image/png",
			bytes: bytes.length,
			conversation_id: input.conversation_id,
			message_id: input.message_id,
			index: input.index ?? 1,
			scope: "decoded_image",
		};
	} finally {
		await session.call("chat.capture.cleanup", { token }).catch(() => undefined);
	}
}
