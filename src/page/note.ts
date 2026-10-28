import { fail, find, one, point } from "./dom.ts";
import { installGuard } from "./interactions.ts";
import { guardVideo, noteRoot } from "./readers.ts";

export function noteHoverPoint(videoID: string) {
	const state = guardVideo(videoID);
	if (!state.note || state.page_kind !== "note") fail("unsupported_media", "Current work is not an image post");
	const root = noteRoot();
	if (!root) fail("selector_changed", "Image post container is unavailable");
	const rect = root.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) fail("selector_changed", "Image post player is not visible");
	return {
		x: Math.max(1, Math.min(innerWidth - 1, rect.left + rect.width / 2)),
		y: Math.max(1, Math.min(innerHeight - 1, rect.top + rect.height / 2)),
	};
}

function slideControl(videoID: string, direction: "next" | "previous") {
	const state = guardVideo(videoID);
	if (!state.note || state.page_kind !== "note" || state.note.slide.index === null)
		fail("unsupported_media", "Image post slide position is unavailable");
	const root = noteRoot();
	if (!root) fail("selector_changed", "Image post container is unavailable");
	const counters = find(root, "div").filter((element) => {
		if (element.children.length !== 3) return false;
		const parts = [...element.children].map((child) => child.textContent?.trim());
		return (
			parts[0] === String(state.note?.slide.index) && parts[1] === "/" && parts[2] === String(state.note?.slide.count)
		);
	});
	const counter = one(counters, "image slide counter");
	const group = counter.parentElement;
	if (!group) fail("selector_changed", "Image slide controls are unavailable");
	const marker = direction === "next" ? "arrowRight_svg" : "arrowLeft_svg";
	const elements = [...group.children].filter(
		(child) =>
			child !== counter &&
			(child.matches(`[data-e2e="note-${direction}"]`) || child.querySelector(`g[filter*="${marker}"]`)),
	);
	const button = one(elements, `image slide ${direction} control`) as HTMLElement;
	return { state, button };
}

export function prepareNoteSlide(videoID: string, direction: "next" | "previous", token: string) {
	const state = guardVideo(videoID);
	if (!state.note || state.page_kind !== "note" || state.note.slide.index === null || state.note.slide.count === null)
		fail("unsupported_media", "Image post slide position is unavailable");
	const index = state.note?.slide.index ?? 0;
	const count = state.note?.slide.count ?? 0;
	if ((direction === "next" && index >= count) || (direction === "previous" && index <= 1))
		return { already: true, boundary: true, index, count };
	const { button } = slideControl(videoID, direction);
	installGuard(button, token, () => {
		const current = slideControl(videoID, direction);
		if (
			current.button !== button ||
			current.state.note?.slide.index !== index ||
			current.state.note.slide.count !== count
		)
			fail("identity_mismatch", "Image slide changed before input");
	});
	setTimeout(() => cleanupNoteSlide(token), 12000);
	return { ...point(button, token), index, count };
}

export function cleanupNoteSlide(token: string) {
	if (window.__douyinCLIGuard?.token === token) {
		window.__douyinCLIGuard.cleanup();
		delete window.__douyinCLIGuard;
	}
	return {};
}

export function noteSlideReceipt(videoID: string, token: string) {
	const state = guardVideo(videoID);
	if (window.__douyinCLIGuard?.token !== token) fail("identity_mismatch", "Image slide witness changed");
	return {
		slide: state.note?.slide ?? null,
		dispatched: window.__douyinCLIGuard?.state.dispatched ?? false,
		blocked: window.__douyinCLIGuard?.state.blocked ?? false,
	};
}
