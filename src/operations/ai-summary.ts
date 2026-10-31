import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session } from "../browser.ts";
import { CliError } from "../errors.ts";
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
	const workID = input.video_id ?? open.video?.id ?? null;
	if (!workID) throw new CliError("unsupported_media", "There is no work on screen to summarise");
	// The panel lives on the feed's overlay, not on the /video/<id> detail page.
	//
	// The page is reopened unless it is already the right form showing the right
	// work, and that condition is checked rather than assumed. Three states reach
	// here and two of them need a navigation:
	//
	//   /video/<id> detail      the menu is laid out at 0×0, so reopen
	//   ?modal_id=<other work>  a previous command left it on a different work
	//   ?modal_id=<this work>   already right, reopen would wipe the panel
	//
	// The middle one is why this is a comparison and not a URL pattern: `video open`
	// lands on /jingxuan?modal_id=…, which looks like the overlay but can be showing
	// whatever was open last.
	const overlayWork = open.url ? new URL(open.url).searchParams.get("modal_id") : null;
	const rightForm = !!overlayWork && overlayWork === workID;
	if (!rightForm) {
		await session.tab.goto(`https://www.douyin.com/?modal_id=${workID}`, { waitUntil: "domcontentloaded" });
		await delay(1500, undefined, { signal });
	}
	// The work the panel will describe is whatever is on screen, so the page is
	// asked directly rather than trusted to be the one that was requested.
	const shown = await session.call<{ video?: { id?: string } | null }>("video.info", {});
	if (!shown.video?.id)
		throw new CliError("unsupported_media", "The page is not showing a work", {
			hint: "Open it with dy video open <id> first.",
			details: { asked: workID },
		});
	if (shown.video.id !== workID)
		throw new CliError("identity_mismatch", "The page is showing a different work than the one asked for", {
			hint: "Open it again with dy video open, then retry.",
			details: { asked: workID, showing: shown.video.id },
		});
	// Autoplay is what made this expensive and unreliable. A short work finishes
	// while the panel is still writing, the feed advances, and the panel goes with
	// it — so the wait ran out on a work the page was no longer showing. Pausing is
	// also what the panel is for: it describes the work, and a work that plays to
	// its end while you read about it is a different work by the time you finish.
	// Best-effort: a work that will not pause still gets a summary, just a slower
	// and less certain one.
	await session.call("video.pause", { ...input, video_id: workID }).catch(() => undefined);
	// The entry is a toggle, not an opener: pressed while the panel is up it closes
	// it. A panel left behind by an earlier call is therefore a different problem
	// from a covered control — pressing would close the very thing this is here to
	// read — and it has to be closed before anything is pressed.
	//
	// It is closed by pressing the entry itself. `chat.close` is the private-message
	// panel and does nothing here; Escape does not close this one either. Only the
	// entry's own press does, which is the same fact that makes the first phase
	// below necessary.
	if ((await session.call<{ open: boolean }>("ai.panel.open", {})).open) {
		await session.click(await settledEntryPoint(session, signal)).catch(() => undefined);
		await waitPanelClosed(session, signal);
	}

	// The press lands on a measured point, so the layout has to stop moving first.
	// Entering the feed slides the rail in over a few hundred milliseconds, and a
	// point measured halfway through is a point the icon has left by the time the
	// press arrives. Two measurements that agree is what tells "settled" from
	// "still animating".
	const target = await settledEntryPoint(session, signal);
	await session.click(target);

	// The panel opens a moment after the press, and the answer streams after that.
	// The first phase waits for the panel itself, which is a different thing from
	// waiting for text: a press that opened nothing was reported as "still writing"
	// for thirty seconds. The second phase is the answer.
	const opened = Date.now() + 2500;
	let panel: { open: boolean } = { open: false };
	while (Date.now() < opened) {
		signal.throwIfAborted();
		await delay(250, undefined, { signal });
		panel = await session.call<{ open: boolean }>("ai.panel.open", {});
		if (panel.open) break;
	}
	if (!panel.open) {
		// A press that did nothing is retried once, from the beginning: the point is
		// re-measured, because the first failure leaves the page in a state the first
		// measurement did not describe — the rail may have finished sliding in, or a
		// hover bubble may be over the icon.
		//
		// A second press is safe here in a way it would not be for a write: it opens a
		// reader and sends nothing. But the entry is a toggle, so a retry has to know
		// the panel is still shut — pressing an entry whose panel did open would close
		// it again. That is checked, not assumed.
		const stillShut = Date.now() + 6000;
		let asked = false;
		while (Date.now() < stillShut) {
			signal.throwIfAborted();
			const state = await session.call<{ open: boolean }>("ai.panel.open", {});
			if (state.open) {
				panel = state;
				break;
			}
			// The first failure is often the page finishing its own transition. Half the
			// window is spent watching before trying again, so a panel that was merely
			// slow is never closed by the retry.
			if (!asked && Date.now() > stillShut - 2500) {
				asked = true;
				await session.click(await settledEntryPoint(session, signal)).catch(() => undefined);
			}
			await delay(250, undefined, { signal });
		}
	}
	if (!panel.open) {
		const at = await session
			.call<{ url?: string | null; video?: { id?: string } | null; slide?: { kind?: string } }>("video.info", {})
			.catch(() => null);
		throw new CliError("selector_changed", "The AI panel did not open", {
			hint: "The press landed twice and the panel did not appear. The work may not offer a summary, or another panel is over it.",
			details: {
				video_id: workID,
				pressed: { x: target.x, y: target.y },
				page_after: at?.url ?? null,
				work_after: at?.video?.id ?? null,
				slide_kind: at?.slide?.kind ?? null,
			},
		});
	}
	let previous = "";
	let stable = 0;
	let last = { complete: false, summary: "", why: "" };
	const deadline = Date.now() + 60_000;
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
	// The panel stays up over the next work and would be read as that work's
	// summary. It is closed the same way it was opened — by pressing the entry —
	// because that is the only thing that closes it: `chat.close` is the private
	// message panel and Escape does nothing here.
	//
	// Best-effort, and it re-measures first: by now the answer has been read, and a
	// panel that will not close must not turn a delivered summary into a failure.
	// The next call closes a leftover anyway, so a miss here costs one press later
	// rather than an answer now.
	await session.click(await settledEntryPoint(session, signal)).catch(() => undefined);
	// The pause is this command's doing, so it is this command's to undo. Leaving
	// the work paused would make a browsing round stop at the first summary.
	await session.tab.keyboard.press("Space").catch(() => undefined);
	return {
		work_id: workID,
		summary: last.summary,
		complete: last.complete && stable >= 1,
		limits: AI_SUMMARY_LIMITS,
	};
}

// Waits for a panel left open by an earlier call to go away.
//
// The entry is under the panel while it is up, so the press has to wait for it.
// Best-effort: a panel that will not close leaves the press to fail, which is the
// honest answer rather than pressing through the panel.
async function waitPanelClosed(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 2000;
	while (Date.now() < deadline) {
		const state = await session.call<{ open: boolean }>("ai.panel.open", {});
		if (!state.open) return;
		await delay(150, undefined, { signal });
	}
}

// Where the AI entry is, on a layout that has stopped moving.
//
// The point is measured in one moment and pressed at another, and this rail
// animates: it slides in when a work is opened, and every frame of that is a
// different y. Reading twice and requiring the same answer is what tells "settled"
// from "still animating". The answer is the last read rather than the first of the
// agreeing pair, because the second read is the one whose marker is still attached
// and whose coordinates are the newest.
async function settledEntryPoint(session: Session, signal: AbortSignal): Promise<Point> {
	const deadline = Date.now() + 6000;
	let previous: string | null = null;
	let last: Point | null = null;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		const target = await session.call<Point>("ai.entry.point", {});
		// The selector carries a fresh token each call, so it is not part of the
		// comparison: what has to agree is where the icon is.
		const key = `${target.x},${target.y}`;
		if (key === previous && last) return target;
		previous = key;
		last = target;
		await delay(150, undefined, { signal });
	}
	// It never stopped moving. The last measurement is still worth a press: the
	// alternative is refusing a summary on a page that may just be jittery, and a
	// locator click re-checks the position when the press lands.
	if (last) return last;
	throw new CliError("selector_changed", "The AI entry never appeared on a still layout");
}
