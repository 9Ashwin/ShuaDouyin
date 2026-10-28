import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { selectChat } from "./navigation.ts";
import type { Input } from "./validate.ts";

// The platform transcribes voice messages itself, from the message's context
// menu. Using that instead of downloading the audio and recognising it here
// keeps a private recording on the platform, needs no model inside the CLI, and
// reports what the sender will actually see when they open the message.
export async function transcribeVoices(session: Session, input: Input, signal: AbortSignal) {
	await selectChat(session, input.conversation_id ?? "", signal);
	for (let step = 0; step < (input.scrolls ?? 0); step++) {
		const moved = await session.call<{ at_top: boolean }>("chat.scroll", { index: 1, pixels: input.pixels ?? 1200 });
		if (moved.at_top) break;
		await delay(400, undefined, { signal });
	}
	const before = await session.call<{ voices: { index: number; transcript: string | null }[] }>("chat.voice.text", {});
	const wanted = input.index ?? null;
	// Only rows the page can actually be pressed on are targets: the list keeps
	// older rows in the document but lays them out far above the viewport, where a
	// right-click opens the browser's menu rather than the page's.
	const reachable = await reachableCount(session);
	const targets = before.voices.filter(
		(voice) => (wanted === null || voice.index === wanted) && voice.index <= reachable,
	);
	if (!targets.length)
		throw new CliError("not_found", "No reachable voice message matches that index", {
			details: {
				loaded: before.voices.length,
				reachable,
				hint: "Scroll the conversation so the voice row is on screen.",
			},
		});
	for (const target of targets) {
		signal.throwIfAborted();
		// A voice the platform has already transcribed needs no second request.
		if (target.transcript) continue;
		const point = await session.call<Point & { total: number }>("chat.voice.prepare", { index: target.index });
		if (point.x === undefined || point.y === undefined)
			throw new CliError("selector_changed", "Voice row has no click point");
		await session.tab.keyboard.press("Escape");
		await delay(120, undefined, { signal });
		await session.tab.mouse.click(point.x, point.y, { button: "right" });
		const entry = await waitForMenu(session, signal);
		await session.click({ x: entry.x, y: entry.y });
	}
	// Recognition is asynchronous on the page, so the text is polled rather than
	// read once: an absent transcript immediately after the click means it has
	// not been produced yet, not that it failed.
	const deadline = Date.now() + 12000;
	while (true) {
		const after = await session.call<{ voices: { index: number; transcript: string | null }[] }>("chat.voice.text", {});
		const pending = targets.filter((target) => !after.voices.find((voice) => voice.index === target.index)?.transcript);
		if (!pending.length || Date.now() >= deadline) {
			return {
				voices: after.voices.filter((voice) => wanted === null || voice.index === wanted),
				transcribed: after.voices.filter((voice) => voice.transcript).length,
				source: "platform_transcription",
				limitations: [
					"Recognition is the platform's, so its accuracy and any content limits are not this CLI's.",
					"A row with no transcript may be silent, too short, or unsupported rather than unreadable.",
				],
			};
		}
		await delay(400, undefined, { signal });
	}
}

async function waitForMenu(session: Session, signal: AbortSignal): Promise<{ x: number; y: number }> {
	const deadline = Date.now() + 4000;
	while (true) {
		signal.throwIfAborted();
		const entry = await session.call<{ x?: number; y?: number }>("chat.voice.menu", {});
		if (entry.x !== undefined && entry.y !== undefined) return { x: entry.x, y: entry.y };
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The voice menu did not offer 转文字", {
				hint: "Right-click the voice message in headed Chrome and check the menu.",
			});
		await delay(150, undefined, { signal });
	}
}

// How many voice rows the page can be pressed on right now. The count comes from
// the same reachability test the click uses, so the caller never asks for a row
// the press would miss.
async function reachableCount(session: Session): Promise<number> {
	for (let index = 1; index <= 20; index++) {
		try {
			await session.call("chat.voice.prepare", { index });
		} catch {
			return index - 1;
		}
	}
	return 20;
}
