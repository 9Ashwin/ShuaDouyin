import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { control } from "./navigation.ts";
import type { Input } from "./validate.ts";

// The platform's own description of the work on screen.
//
// Every other read here reports what the page literally shows: a title, sampled
// frames, comment rows. This one reports prose a model wrote about the work, and
// that is a different kind of evidence. It sees the whole video rather than a
// handful of stills, so it answers questions frames cannot — what happens, what
// the lyrics say, what the comments are actually about. It is also the platform
// describing itself, so it can be wrong, vague, or flattering in ways a frame
// never is.
//
// The distinction goes in every response, not only in the docs: a caller that
// quotes this as an observation would be quoting a summary instead.

export interface AiSummary {
	work_id: string | null;
	summary: string;
	complete: boolean;
	limits: string[];
}

export const AI_SUMMARY_LIMITS = [
	"Written by Douyin's model about its own content, not observed by this tool. Quote it as the platform's description, never as something seen here.",
	"It can describe what the frames cannot: the whole video, lyrics, and what the comments are about.",
	"Read the ending marker as the signal it finished. Without it the answer was still streaming, and this returns complete:false rather than the partial text.",
];

export async function readAiSummary(session: Session, input: Input, signal: AbortSignal): Promise<AiSummary> {
	const open = await session.call<{ video?: { id?: string } }>("video.info", input);
	const workID = open.video?.id ?? null;
	const point = await session.call<{ x: number; y: number }>("ai.entry.point", {});
	await session.tab.mouse.click(point.x, point.y);

	// The panel streams. Two reads in a row with the same text means it stopped;
	// waiting for a non-empty read alone would return the first sentence of an
	// answer that is still being written.
	const deadline = Date.now() + 30_000;
	let previous = "";
	let stable = 0;
	let last = { complete: false, summary: "", why: "" };
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		await delay(600, undefined, { signal });
		last = await session.call<{ complete: boolean; summary: string; why: string }>("ai.summary", {});
		// The disclaimer is the page stating the answer is done, which is stronger
		// evidence than a stable read.
		if (last.complete) {
			if (last.summary && last.summary === previous) stable++;
			else stable = 0;
			previous = last.summary;
			if (stable >= 1) break;
		}
	}
	if (!last.summary)
		throw new CliError("timeout", "The AI panel did not produce a summary", {
			hint: last.why || "The entry may have opened a different panel, or the page changed.",
		});
	// A panel stays open across feed moves and would be read as this work's
	// summary. Closing is best-effort: a panel that is already gone has nothing
	// to close, and failing here would throw away a summary already read.
	await control(session, "chat.close").catch(() => undefined);
	return {
		work_id: workID,
		summary: last.summary,
		complete: last.complete && stable >= 1,
		limits: AI_SUMMARY_LIMITS,
	};
}
