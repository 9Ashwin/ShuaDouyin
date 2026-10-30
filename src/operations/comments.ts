import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session, Snapshot } from "../browser.ts";
import { classifyComment } from "../comment-stance.ts";
import { CliError } from "../errors.ts";
import type { Memory } from "../memory/concept.ts";
import { measureEngagement, measureWit, profileVoice, voiceGuidance } from "../voice.ts";
import { control, listResults } from "./navigation.ts";
import {
	availablePhrases,
	COOLDOWN_DAYS,
	candidatePhrase,
	measureSameness,
	PHRASE_RULE,
	phraseMemories,
	phraseMemoryText,
	usePhrase,
} from "./phrases.ts";
import type { Input } from "./validate.ts";
import { shapeOf, summarise, voiceMemories } from "./voice-memory.ts";

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

// How this section writes, so a draft can sound like it belongs here. The
// profile is per work: two sections read minutes apart had a median length of
// 11 and 28 characters, so a single global style would be wrong for both.
export async function commentVoice(session: Session, input: Input, signal: AbortSignal): Promise<unknown> {
	const listed = (await listComments(session, input, signal)) as {
		items?: { text?: string; stance?: string; likes?: number | null; liked_by_author?: boolean }[];
		complete?: boolean;
	};
	const samples = (listed.items ?? [])
		.filter((item) => item.text)
		.map((item) => ({ text: item.text ?? "", stance: item.stance }));
	const profile = profileVoice(samples);
	return {
		video_id: input.video_id ?? null,
		sampled: samples.length,
		complete: listed.complete ?? false,
		profile,
		shape: shapeOf(profile),
		engagement: {
			...measureEngagement(listed.items ?? []),
			// The verdicts are what a caller acts on: which comments in this
			// section had something to say, and which were adjectives.
			wit: (listed.items ?? [])
				.filter((item) => item.text)
				.map((item) => ({ text: (item.text ?? "").slice(0, 80), ...measureWit(item.text ?? "") }))
				.sort((left, right) => Number(right.verdict === "has-wit") - Number(left.verdict === "has-wit"))
				.slice(0, 8),
		},
		guidance: voiceGuidance(profile),
		// The comments that landed, reduced to a phrase that could travel. The
		// whole sentence is tied to one work; these are the shapes worth keeping.
		candidates: (listed.items ?? [])
			.filter((item) => item.text)
			.map((item) =>
				candidatePhrase(
					{ text: item.text ?? "", likes: item.likes ?? null },
					measureWit(item.text ?? ""),
					input.video_id ?? "",
				),
			)
			.filter((phrase): phrase is NonNullable<typeof phrase> => phrase !== null),
		scope: "loaded_comments_of_this_work",
		limitations: [
			"Measured from the comments this page had loaded, not from every comment on the work.",
			"A profile describes the section, not every reader in it. Writing to the median is a start, not a rule.",
			"Imitating a section is a style choice; it does not make a comment worth reading.",
		],
	};
}

// Record that a learned phrase was used, from the send path rather than from a
// caller remembering to say so.
//
// The ledger only works if every use is counted, and asking a caller to run
// `comment phrases --use` after each send meant the count was as reliable as the
// caller's memory — which is exactly what a ledger is supposed to replace. A send
// whose text matches a learned phrase records the use itself. Text that matches
// nothing is not an error here: most comments are not quotes from the ledger.
export async function recordPhraseUse(
	known: { execute: (operation: string, input: Record<string, unknown>) => Promise<unknown> },
	text: string,
	now = new Date(),
): Promise<{ text: string; used: number } | null> {
	if (!text.trim()) return null;
	// The ledger is looked up across every memory, not the first page. memory.list
	// defaults to 20, ordered by update time, so a ledger entry that had not been
	// touched recently fell off the end and the send silently stopped counting —
	// the same failure the automatic recording was added to prevent.
	const memories = (await known.execute("memory.list", { limit: 1000 })) as Memory[];
	const found = phraseMemories(memories).find((phrase) => phrase.text === text.trim());
	if (!found) return null;
	const target = memories.find(
		(memory) => memory.tags?.includes("phrase-ledger") && memory.body.includes(`「${found.text}」`),
	);
	// The ledger entry is what makes the count durable. A phrase memory without one
	// is a broken state and is reported rather than silently skipped: treating it
	// as absent would let the same phrase be reused indefinitely.
	if (!target) throw new CliError("state_corrupt", "The phrase ledger entry is missing");
	const updated = usePhrase(found, now);
	await known.execute("memory.update", {
		resource: target.id,
		text: phraseMemoryText(updated),
		source: `phrase:${found.from_video}`,
		if_match: target.revision,
		layer: "experience",
		memory_type: "insight",
		topic: "可用句式",
		tags: "phrase-ledger,comment-style",
	});
	return { text: updated.text, used: updated.used };
}

// Which phrases are available to say right now, and which have been used
// enough that saying them again would read as a repeat.
export function phraseReport(memories: Memory[], now = new Date()): unknown {
	const { usable, spent } = availablePhrases(phraseMemories(memories), now);
	return {
		usable: usable.map((phrase) => ({
			text: phrase.text,
			kind: phrase.kind,
			status: phrase.status,
			used: phrase.used,
			idle_days: phrase.idle_days,
			likes: phrase.likes,
			from_video: phrase.from_video,
		})),
		spent: spent.map((phrase) => ({
			text: phrase.text,
			used: phrase.used,
			idle_days: phrase.idle_days,
			// How long until it is worth saying again, rather than a flat "no".
			// The same constant the status decision uses. Writing 14 here meant a
			// change to the cooldown would leave this line reporting a different
			// number from the one that decided the phrase was resting.
			resting_days_left: Math.max(0, COOLDOWN_DAYS - phrase.idle_days),
		})),
		rule: PHRASE_RULE,
		scope: "phrase_ledger",
	};
}

// Whether the comments actually written are starting to look the same. The
// ledger guards one phrase; this guards the pattern across phrases, which is
// what a reader notices first.
export function samenessReport(comments: { text: string; at?: string }[]): unknown {
	const sameness = measureSameness(comments);
	return {
		...sameness,
		rule:
			sameness.verdict === "template"
				? "The last comments repeat a phrase. Change the angle, not just the wording."
				: sameness.verdict === "narrowing"
					? "The last comments are converging on one shape. That is fine for a while; it stops being fine when a reader can predict the next one."
					: "The last comments vary in length and opening.",
	};
}

// What previous sections looked like. Reading a new one without this means
// measuring from nothing every time; the list is what turns one measurement
// into a habit.
export function knownVoices(memories: Memory[]): unknown {
	const records = voiceMemories(memories);
	const summary = summarise(records);
	return {
		...summary,
		recent: records
			.sort((left, right) => right.at.localeCompare(left.at))
			.slice(0, 10)
			.map((record) => ({
				video_id: record.video_id,
				at: record.at,
				shape: shapeOf(record.profile),
				median: record.profile.length.median,
			})),
		scope: "stored_voice_profiles",
		limitations: [
			"Counts only the sections this bot has saved with comment voice --save.",
			"A shape is a summary of style, not a judgement about the work or its audience.",
		],
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
// Whether the panel is open, not whether any of it is on screen.
//
// This asked for visible comment rows, and on a work page the list is in the
// document below the fold: rows existed, none were in the viewport, so this said
// "closed", and opening tried to click an entry icon that had already been
// replaced by an empty 0x0 box. Every comment read and send on that page then
// failed with a control that could not be measured.
async function panelVisible(session: Session): Promise<boolean> {
	const list = session.tab.locator('[data-e2e="comment-list"],[data-e2e="comment-item"]');
	const attached = await list.count().catch(() => 0);
	if (!attached) return false;
	// A list that is attached is enough: the panel is open. It is deliberately not
	// a visibility test, because a panel below the fold is still open.
	return true;
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
	// A panel that is already open still has to be brought into view: on a work
	// page it is attached from the start, so this returned early and left the
	// composer below the fold — which is exactly the state that broke sends.
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
