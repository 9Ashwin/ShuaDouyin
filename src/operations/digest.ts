import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Session, Snapshot } from "../browser.ts";
import { classifyComment } from "../comment-stance.ts";
import { CliError } from "../errors.ts";
import { captureSnapshot, noteImage, noteSlide } from "./capture.ts";
import { listComments } from "./comments.ts";
import type { Input } from "./validate.ts";

// What a work is about, gathered for as little as it takes to tell.
//
// Reading a feed one work at a time costs one process per work and still says
// nothing about the content: a title states the form ("第30集 B1听力挑战") and
// not the point. Sampling three positions inside a work does say the point —
// on a four-minute talk the subtitles at 25%, 50% and 75% carried the whole
// argument — and the comment section says who is watching and what they took
// from it.
//
// The cost is staged so a caller can stop early: identity and comments are two
// calls, and frames are only taken when the caller asked for them.

export interface DigestFrame {
	position: number;
	elapsed_ms: number;
	path: string;
}

// Long works earn more samples; a nine-second clip is its own summary. The
// fractions avoid the opening (usually a title card) and the end (usually a
// call to follow), which are the two least informative parts of a short video.
// How many samples a work deserves, from its length.
//
// Three frames is right for a few minutes and much too few for twenty: half an hour
// sampled at 25/50/75% is three stills of somebody talking, and the argument they
// made in between is gone. A long work gets more, capped so the capture does not
// take longer than watching it.
export function samplesFor(duration: number, ceiling = 8): number {
	if (!Number.isFinite(duration) || duration <= 0) return 0;
	if (duration < 15) return 0;
	if (duration < 45) return 1;
	// One sample per two minutes past the first, plus the three the base case needs:
	// 3 minutes gets 3, 10 minutes gets 5, 20 minutes gets 8.
	if (duration < 180) return 3;
	return Math.min(ceiling, 3 + Math.floor((duration - 180) / 120));
}

export function samplePositions(duration: number, wanted?: number): number[] {
	if (!Number.isFinite(duration) || duration <= 0) return [];
	const automatic = samplesFor(duration);
	if (automatic === 0) return [];
	// An explicit count is honoured: `--frames 1` means one frame, and a caller that
	// wants the middle of a long talk has a reason. What is not honoured is asking
	// for nothing, which the hasValue check upstream already refuses.
	const count = Math.max(wanted ?? automatic, 1);
	// Until the first millisecond and after the last are both wrong: the opening is a
	// title card and the end is a request to follow.
	if (count === 1) return [duration * 0.5];
	// Spread across the middle eighty percent, so the first sample is past the
	// opening and the last is before the sign-off.
	return Array.from({ length: count }, (_, index) => duration * (0.1 + (0.8 * index) / (count - 1)));
}

export async function digest(
	session: Session,
	store: { path: (name: string) => string },
	input: Input,
	signal: AbortSignal,
): Promise<unknown> {
	const initial = await session.call<Snapshot>("video.info", input);
	const work = initial.video ?? initial.note;
	if (!work) throw new CliError("unsupported_media", "A digest needs a work with an identity");
	input.video_id = initial.video?.id ?? undefined;
	const duration = initial.video?.duration ?? null;
	const frames: DigestFrame[] = [];
	const limitations: string[] = [];
	const directory = store.path(join("captures", `digest-${work.id}`));

	// An image post is a set of pictures, and the set is the work. Sampling a video
	// means picking moments inside one; sampling an image post means looking at every
	// one of them, because the point of the format is that you swipe through them.
	if (input.frames !== 0 && initial.note) {
		const slides: number[] = [];
		// Until the count is known there is nothing to loop over, so each step asks
		// where it is and stops when the page says it is at the end.
		for (let guard = 0; guard < (input.limit ?? 20); guard++) {
			signal.throwIfAborted();
			try {
				const captured = await noteImage(
					session,
					store,
					{ ...input, output: join(directory, `slide-${String(slides.length + 1).padStart(2, "0")}.png`) },
					signal,
				);
				slides.push(slides.length + 1);
				if (
					captured.slide.index !== null &&
					captured.slide.count !== null &&
					captured.slide.index + 1 >= captured.slide.count
				)
					break;
			} catch (error) {
				// The first page failing is worth reporting; one later page failing is
				// the boundary, and the pages already read are still the answer.
				if (!slides.length)
					limitations.push(error instanceof CliError ? error.message : "Could not read the image post");
				break;
			}
			try {
				const moved = await noteSlide(session, input, "next", signal);
				if (moved.boundary || !moved.moved) break;
			} catch {
				// No further page could be reached. What was read stands.
				break;
			}
		}
		if (slides.length) limitations.push("Every page of the image post was captured in order.");
	} else if (input.frames !== 0 && initial.video) {
		const positions = samplePositions(duration ?? 0, input.frames ?? 3);
		if (!positions.length)
			limitations.push(
				duration ? `${Math.round(duration)}s is short enough to read in one pass` : "This work reports no duration",
			);
		for (const [index, at] of positions.entries()) {
			signal.throwIfAborted();
			const started = performance.now();
			try {
				await session.call("video.seek", { ...input, at });
				const captured = await captureSnapshot(
					session,
					store,
					join(directory, `${String(index + 1).padStart(2, "0")}-${Math.round(at)}s.png`),
				);
				frames.push({
					position: Math.round(at),
					elapsed_ms: Math.round(performance.now() - started),
					path: captured.frame.path,
				});
			} catch (error) {
				// A work that will not seek is still worth digesting: the identity and
				// the comments arrived, and losing them to a seek failure would make
				// the caller start over. The reason is stated instead.
				const reason = error instanceof CliError ? error.message : "Seek failed";
				limitations.push(`Could not sample at ${Math.round(at)}s: ${reason}`);
				break;
			}
			await delay(120, undefined, { signal });
		}
	}

	// The comment section is the cheapest signal about what the work is actually
	// like: people describe what they took from it, in their own words.
	let comments: { count: number; sample: { text: string; stance: string }[] } | null = null;
	if (input.include_text !== false && input.video_id) {
		try {
			const listed = (await listComments(session, { ...input, limit: input.limit ?? 8 }, signal)) as {
				items?: { text?: string; kind?: string; stance?: string }[];
			};
			const items = listed.items ?? [];
			comments = {
				count: items.length,
				sample: items
					.filter((item) => item.text)
					.slice(0, 5)
					.map((item) => ({ text: (item.text ?? "").slice(0, 200), stance: item.stance ?? "unknown" })),
			};
			const skewed = items
				.map((item) => classifyComment(item.text ?? "").stance)
				.filter((stance) => stance === "spam").length;
			if (skewed) limitations.push(`${skewed} of the loaded comments look like promotion`);
		} catch (error) {
			if (error instanceof CliError && error.code === "verification_required") throw error;
			limitations.push(
				`Comments were not read: ${error instanceof CliError ? error.message : "the panel did not open"}`,
			);
		}
	}

	// The work's own caption is empty on a detail page for some works while the
	// document title still carries it ("… #英语听力 - 抖音"). A digest with no
	// title is much harder to judge, so the page title is a stated fallback
	// rather than an empty field.
	const own = typeof work.title === "string" ? work.title.trim() : "";
	const pageTitle = typeof initial.title === "string" ? initial.title.replace(/\s*-\s*抖音\s*$/, "").trim() : "";
	return {
		work: {
			id: work.id,
			url: "url" in work ? work.url : null,
			title: own || pageTitle,
			title_source: own ? "work" : pageTitle ? "page_title" : "none",
			author_id: initial.video?.author_id ?? null,
			duration,
			kind: initial.video ? "video" : "note",
		},
		frames,
		comments,
		scope: frames.length ? "sampled_positions_and_loaded_comments" : "loaded_comments",
		limitations: [
			"Frames are screenshots of the viewport: they show what was on screen, not a claim about the whole work.",
			...limitations,
		],
	};
}
