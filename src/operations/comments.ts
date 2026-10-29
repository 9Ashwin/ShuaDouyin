import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session, Snapshot } from "../browser.ts";
import { classifyComment } from "../comment-stance.ts";
import { control, listResults } from "./navigation.ts";
import type { Input } from "./validate.ts";

// Public comment reads. The page reports loaded rows only, never a full history.

export async function listComments(session: Session, input: Input, signal: AbortSignal): Promise<unknown> {
	const state = await session.call<Snapshot>("video.info", input);
	input.video_id = state.video?.id ?? state.note?.id ?? undefined;
	const wasOpen = await panelVisible(session);
	await openComments(session, input, signal);
	const result = (await listResults(session, "comment.list", input, signal)) as { items?: Record<string, unknown>[] };
	// A read closes what it opened. The panel covers the right edge of the player,
	// which is where the feed arrows are, so leaving it up made the next
	// feed next fail with "the feed did not move" — reading comments and then
	// paging was impossible without reloading. A panel the caller already had
	// open is theirs and stays.
	if (!wasOpen) await closeComments(session, signal);
	if (!result.items) return result;
	// Each comment is labelled by what it is doing, not just what it says. The
	// verdict comes with the evidence that produced it, so a reader can disagree
	// with the label instead of having to trust it.
	return {
		...result,
		items: result.items.map((item) => {
			const text = typeof item.text === "string" ? item.text : "";
			const classified = classifyComment(text);
			return { ...item, stance: classified.stance, stance_signals: classified.signals };
		}),
	};
}

// The comment icon lives in an action rail that the page redraws while the
// work settles, so a coordinate measured in one frame can be stale by the next
// and the press lands on whatever moved under it. Playwright's locator click
// waits for the element to be actionable and retries, which is the behaviour
// this needs; the page guard is armed first so the click still fails closed if
// the work changed underneath.
// Whether the comment panel is actually showing. Counting rows is wrong: a panel
// that was closed keeps its rows in the document, hidden, so a count said the
// panel was open when it was not — and said it stayed open after closing. Only
// layout decides.
async function panelVisible(session: Session): Promise<boolean> {
	const visible = await session.tab
		.locator('[data-e2e="comment-item"]')
		.filter({ visible: true })
		.count()
		.catch(() => 0);
	return visible > 0;
}

// Closing is the panel's own X. It is the second svg to the right of the tab
// strip, and it has no role, label or stable class, so it is found by position:
// the tab strip's right edge plus a few pixels, on the strip's own row.
export async function closeComments(session: Session, signal: AbortSignal): Promise<boolean> {
	if (!(await panelVisible(session))) return true;
	const point = await session.call<Point>("comment.close-point", {});
	if (point.x === undefined || point.y === undefined) return false;
	await session.tab.mouse.click(point.x, point.y);
	await delay(300, undefined, { signal });
	return !(await panelVisible(session));
}

export async function openComments(session: Session, input: Input, signal: AbortSignal): Promise<void> {
	// The rail is not in the DOM until the work has rendered, and arming a control
	// that does not exist yet fails before the locator can wait for it. Waiting
	// for the icon itself is what makes the following click meaningful.
	// A work page renders its comment list without any toggle: the rows and the
	// composer are already in the document, just far below the fold. Waiting for
	// an icon there would time out on a panel that is already open.
	const rows = (await panelVisible(session)) ? 1 : 0;
	if (rows === 0) {
		await session.tab
			.locator(
				'[data-e2e="feed-comment-icon"],[data-e2e="video-player-comment"],[data-e2e="note-comment"],[data-e2e="comment-button"]',
			)
			.first()
			.waitFor({ state: "attached", timeout: 5000 });
		await delay(150, undefined, { signal });
	}
	if (rows > 0) return;
	const token = randomUUID();
	await session.call("arm-comment-open", { ...input, token });
	// The click targets this call's token, not the first marked element. The feed
	// lays out neighbouring slides, so several comment icons carry the attribute
	// from earlier calls and the DOM-first one is on a slide that is off screen:
	// clicking it opened nothing, and `comment list` returned zero rows on a work
	// that visibly had 34. Playwright's own scroll-to-element does not save this,
	// because the icon that matched was not the icon that was armed.
	await session.tab.locator(`[data-douyin-cli-control="${token}"]`).first().click({ timeout: 5000, signal });
	// The click resolves before the panel has rendered, and reading immediately
	// after it returned zero rows on a work that had 930 comments. Wait for the
	// rows the caller is about to read. This is only a wait: the icon does open
	// the panel, so a fallback that pressed the tooltip's "评论 X" shortcut would
	// toggle a slow panel shut instead of opening it.
	try {
		await session.tab.locator('[data-e2e="comment-item"]').first().waitFor({ state: "attached", timeout: 5000 });
		await delay(200, undefined, { signal });
	} catch {
		// No rows rendered. The read below reports what it found rather than this
		// helper deciding the work has no comments.
	}
}

export async function listReplies(session: Session, input: Input, signal: AbortSignal): Promise<unknown> {
	const args = { video_id: input.video_id, comment_id: input.comment_id };
	await session.call("video.info", args);
	await control(session, "comment.open", args);
	const read = async () => {
		const rows = await session.call<Record<string, unknown>[]>("comment.list", args);
		const unique = new Map<string, Record<string, unknown>>();
		for (const row of rows) {
			if (row.parent_id === input.comment_id && typeof row.id === "string") unique.set(row.id, row);
		}
		return [...unique.values()];
	};
	const collected = new Map<string, Record<string, unknown>>();
	const collect = (rows: Record<string, unknown>[]) => {
		for (const row of rows) if (typeof row.id === "string") collected.set(row.id, row);
	};
	collect(await read());
	let clicks = 0;
	let stop = "step_limit";
	while (clicks < (input.steps ?? 1) && collected.size < (input.limit ?? 20)) {
		signal.throwIfAborted();
		const point = await session.call<Point | null>("comment.expand", { ...args, token: randomUUID() });
		if (!point) {
			stop = "no_control";
			break;
		}
		const before = collected.size;
		await session.click(point);
		clicks++;
		let changed = false;
		for (let attempt = 0; attempt < 10; attempt++) {
			await delay(200, undefined, { signal });
			collect(await read());
			if (collected.size > before) {
				changed = true;
				break;
			}
		}
		if (!changed) {
			stop = "no_progress";
			break;
		}
	}
	if (collected.size >= (input.limit ?? 20)) stop = "limit";
	return {
		video_id: input.video_id,
		parent_id: input.comment_id,
		items: [...collected.values()].slice(0, input.limit ?? 20),
		scope: "loaded_dom",
		complete: false,
		clicks,
		stop,
	};
}
