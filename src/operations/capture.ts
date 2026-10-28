import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Session, Snapshot } from "../browser.ts";
import { CliError, normalizeError } from "../errors.ts";
import { atomicCreate, atomicWrite } from "../store.ts";
import { summarizePlayback } from "./playback.ts";
import type { Input } from "./validate.ts";

// Screenshots, sampled frames and audio are evidence for the calling agent.
// The CLI never interprets them and never claims a whole video was watched.

function sameVideo(left: Snapshot, right: Snapshot): boolean {
	const id = left.video?.id;
	return (
		left.page_kind === "video" &&
		right.page_kind === "video" &&
		!!id &&
		id === right.video?.id &&
		!left.video_selection.ambiguous &&
		!right.video_selection.ambiguous
	);
}

async function captureSnapshot(
	session: Session,
	store: { path: (name: string) => string },
	output?: string,
	exclusive = false,
	verify?: (state: Snapshot) => void,
) {
	const state = await session.status();
	const sampledClock = performance.now();
	const sampledAt = new Date().toISOString();
	if (state.unsupported_page) throw new CliError("unsupported_page", "The owned tab is outside Douyin");
	verify?.(state);
	const bytes = await session.tab.screenshot({ type: "png" });
	if (verify) verify(await session.status());
	const path = resolve(output ?? store.path(join("captures", `frame-${randomUUID()}.png`)));
	if (exclusive) {
		try {
			await atomicCreate(path, bytes);
		} catch (cause) {
			if (typeof cause === "object" && cause !== null && "code" in cause && cause.code === "EEXIST")
				throw new CliError("revision_conflict", "Observation frame already exists; no file was overwritten", {
					cause,
					details: { path },
				});
			throw cause;
		}
	} else await atomicWrite(path, bytes);
	return { frame: { path, mime: "image/png", bytes: bytes.length, state }, sampledClock, sampledAt };
}

export async function capture(session: Session, store: { path: (name: string) => string }, output?: string) {
	return (await captureSnapshot(session, store, output)).frame;
}

export async function noteImage(
	session: Session,
	store: { path: (name: string) => string },
	input: Input,
	signal: AbortSignal,
) {
	const result = await session.call<{
		base64: string;
		slide: { index: number | null; count: number | null };
		available_images: number;
	}>("note.capture", input);
	signal.throwIfAborted();
	const bytes = Buffer.from(result.base64, "base64");
	if (bytes.length > 20_000_000) throw new CliError("unsupported_media", "Captured image exceeds the size limit");
	const path = resolve(input.output ?? store.path(join("captures", `note-${randomUUID()}.png`)));
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
		video_id: input.video_id,
		index: input.index ?? 1,
		slide: result.slide,
		available_images: result.available_images,
		scope: "visible_images",
	};
}

export async function noteSlide(session: Session, input: Input, direction: "next" | "previous", signal: AbortSignal) {
	const token = randomUUID();
	try {
		const hover = await session.call<{ x: number; y: number }>("note.slide.hover", { video_id: input.video_id });
		await session.tab.mouse.move(hover.x, hover.y);
		await delay(200, undefined, { signal });
		const prepared = await session.call<{
			already?: boolean;
			boundary?: boolean;
			index: number;
			count: number;
			selector?: string;
		}>("note.slide.prepare", { video_id: input.video_id, direction, token });
		if (prepared.already)
			return { video_id: input.video_id, index: prepared.index, count: prepared.count, moved: false, boundary: true };
		if (!prepared.selector) throw new CliError("selector_changed", "Image slide control is unavailable");
		await session.tab.locator(prepared.selector).click({ timeout: 3000 });
		const deadline = Date.now() + 3000;
		const expected = prepared.index + (direction === "next" ? 1 : -1);
		while (true) {
			await delay(150, undefined, { signal });
			const result = await session.call<{
				slide: { index: number | null; count: number } | null;
				dispatched: boolean;
				blocked: boolean;
			}>("note.slide.result", { video_id: input.video_id, token });
			if (result.blocked) throw new CliError("identity_mismatch", "Image slide changed before input");
			if (result.slide?.count !== prepared.count)
				throw new CliError("identity_mismatch", "Image post slide count changed");
			if (result.dispatched && result.slide.index === expected)
				return {
					video_id: input.video_id,
					index: result.slide.index,
					count: result.slide.count,
					moved: true,
					scope: "page_observation",
					autoplay_may_change_slide: true,
					cause_verified: false,
				};
			if (result.slide.index !== null && result.slide.index !== prepared.index)
				throw new CliError("decision_uncertain", "Image slide changed without an observable expected transition");
			if (Date.now() >= deadline)
				throw new CliError("decision_uncertain", "Image slide transition could not be confirmed");
		}
	} finally {
		await session.call("note.slide.cleanup", { token }).catch(() => undefined);
	}
}

export async function observe(
	session: Session,
	store: { path: (name: string) => string },
	input: Input,
	signal: AbortSignal,
): Promise<unknown> {
	const initial = await session.call<Snapshot>("video.info", input);
	if (!initial.video) throw new CliError("unsupported_media", "Playback observation requires a video");
	const frames: (Awaited<ReturnType<typeof capture>> & { elapsed_ms: number; captured_at: string })[] = [];
	const directory = input.output ?? store.path(join("captures", `observe-${randomUUID()}`));
	const count = input.frames ?? 3;
	const start = performance.now();
	const verify = (state: Snapshot) => {
		if (state.login_required)
			throw new CliError("login_required", "Login is required during observation", { details: { frames } });
		if (state.verification_required)
			throw new CliError("verification_required", "Verification is required during observation", {
				details: { frames },
			});
		if (state.private_chat_visible || state.unsupported_page || !sameVideo(initial, state))
			throw new CliError("identity_mismatch", "Video changed or became inaccessible during observation", {
				details: { frames },
			});
	};
	try {
		for (let index = 0; index < count; index++) {
			if (index) await delay(((input.seconds ?? 3) / Math.max(1, count - 1)) * 1000, undefined, { signal });
			verify(await session.status());
			const result = await captureSnapshot(
				session,
				store,
				join(directory, `${String(index + 1).padStart(3, "0")}.png`),
				true,
				verify,
			);
			frames.push({ ...result.frame, elapsed_ms: result.sampledClock - start, captured_at: result.sampledAt });
		}
	} catch (cause) {
		if (signal.aborted && frames.length) {
			const code = signal.reason instanceof Error && signal.reason.name === "TimeoutError" ? "timeout" : "cancelled";
			throw new CliError(code, "Observation stopped; captured frames were preserved", { cause, details: { frames } });
		}
		if (frames.length) {
			const problem = normalizeError(cause);
			throw new CliError(problem.code, problem.message, {
				cause,
				hint: problem.hint,
				details: { frames, ...(problem.details ? { operation: problem.details } : {}) },
			});
		}
		throw cause;
	}
	return {
		video: initial.video,
		frames,
		scope: "sampled_frames",
		audio_included: false,
		playback: summarizePlayback(frames),
	};
}

export async function audio(session: Session, store: { path: (name: string) => string }, input: Input) {
	const before = await session.call<Snapshot>("video.info", input);
	const captured = await session.call<{ mime: string; base64: string }>("video.audio", input);
	if (!sameVideo(before, await session.status()))
		throw new CliError("identity_mismatch", "Video changed during audio capture");
	const bytes = Buffer.from(captured.base64, "base64");
	const path = resolve(input.output ?? store.path(join("captures", `audio-${randomUUID()}.webm`)));
	await atomicWrite(path, bytes);
	return { path, mime: captured.mime, bytes: bytes.length, seconds: input.seconds, video: before.video };
}
