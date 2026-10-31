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
	const open = await session.call<{ video?: { id?: string }; url?: string | null }>("video.info", input);
	const workID = open.video?.id ?? null;
	if (!workID) throw new CliError("unsupported_media", "There is no work on screen to summarise");
	// The AI entry lives on the feed's overlay, not on the /video/<id> detail page.
	// A caller that opened a work first — the normal way to read one — would find
	// nothing to click, so the work is reopened in the form that has the panel.
	// modal_id addresses one work directly; without it the feed would have to be
	// walked until this work came round again.
	// The form that has the panel is any feed or modal view, not only
	// `?recommend=1`: the modal URL is `/jingxuan?modal_id=...`, so keying on
	// recommend alone reopened the page on every call and wiped the panel that had
	// just finished writing.
	const onDetail = !!open.url && /\/video\/|\/note\//.test(open.url);
	if (onDetail) {
		await session.tab.goto(`https://www.douyin.com/?modal_id=${workID}`, { waitUntil: "domcontentloaded" });
		await delay(1500, undefined, { signal });
	}
	// The modal form keeps its `modal_id`, but the work element is addressed
	// differently there and `video.info` cannot identify it. What the panel will
	// describe is whatever is on screen, so the page is asked directly rather than
	// trusted to be the same work.
	const shown = await session.call<{ video?: { id?: string } | null }>("video.info", {});
	if (shown.video?.id && shown.video.id !== workID)
		throw new CliError("identity_mismatch", "The page is showing a different work than the one asked for", {
			hint: "Open it again with dy video open, then retry.",
			details: { asked: workID, showing: shown.video.id },
		});
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
