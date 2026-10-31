import { fail, findRendered, one } from "./dom.ts";

// Which work is on screen.
//
// There is exactly one answer to this question, and it is answered here.
//
// It used to be answered in three places with three different rules, and they
// disagreed the moment the feed laid out more than one slide:
//
//   the reader      laid-out videos, preferring the one inside feed-active-video
//   the controls    videos whose centre is in the middle of the viewport
//   the comment box whether any comment row exists in the DOM at all
//
// The feed preloads its neighbours and keeps hidden panels mounted, so those
// three rules could point at different slides at the same time. The visible
// symptom was a command reading one work and pressing a control on another, or a
// comment panel reported as open because a row from the previous work was still
// attached. None of them was wrong on its own; together they were.
//
// The rule below is the one every caller now shares:
//
//   The current work is the slide occupying the viewport. It is identified by its
//   container — `feed-active-video` on the feed, `video-detail` on a detail page,
//   `player-container` in the overlay — and never by the <video> element, because
//   the feed keeps several of those mounted and the next slide's is always there.
//
// A slide that is only partly inside the viewport is not current: that is a
// transition, and acting during one is how a press lands on the work arriving
// rather than the work being looked at.

export interface CurrentSlide {
	/** The element that owns the work: its title, author links and controls. */
	root: HTMLElement;
	/** The player inside it, when the page has one. */
	player: HTMLVideoElement | null;
	/** Whether the slide is a live broadcast rather than a work. */
	live: boolean;
}

// How much of the viewport a slide has to cover to count as the current one.
//
// Fraction of its own box that is on screen, not fraction of the viewport. A slide
// does not have to fill the window — the overlay's player is a strip in the middle
// of a dark page, and requiring half the window excluded it. What has to be true
// is that the slide is not half-scrolled-away: a transition shows part of two
// slides, and neither is wholly inside the viewport at the same time.
const OCCUPIED = 0.9;

// How much of the element itself is on screen: 1 is wholly visible, 0 is off
// screen. This is the fraction that tells a slid-in slide from one mid-transition,
// and it is independent of how much of the window the slide happens to fill — the
// overlay's player is a strip, not a full page, and measuring against the window
// would have called it absent.
function coverage(element: Element): number {
	const box = element.getBoundingClientRect();
	if (box.width <= 0 || box.height <= 0) return 0;
	const top = Math.max(box.top, 0);
	const bottom = Math.min(box.bottom, innerHeight);
	const left = Math.max(box.left, 0);
	const right = Math.min(box.right, innerWidth);
	const shown = Math.max(0, bottom - top) * Math.max(0, right - left);
	return shown / (box.width * box.height);
}

function containerOf(video: Element): HTMLElement | null {
	return (
		video.closest<HTMLElement>('[data-e2e="feed-active-video"],[data-e2e="video-detail"]') ??
		video.closest<HTMLElement>('[data-e2e="player-container"]')
	);
}

// Every slide the page has laid out, current or not.
export function slides(): CurrentSlide[] {
	const privateArea = '[data-e2e="im-dialog"]';
	const out: CurrentSlide[] = [];
	const seen = new Set<HTMLElement>();
	for (const video of findRendered<HTMLVideoElement>(document, "video")) {
		if (video.closest(privateArea)) continue;
		const root = containerOf(video);
		if (!root || seen.has(root)) continue;
		seen.add(root);
		out.push({ root, player: video, live: !!root.closest('[data-e2e="feed-live"]') });
	}
	// A live slide is not always a <video>, so its own container is added when no
	// player inside it produced one.
	for (const live of findRendered<HTMLElement>(document, '[data-e2e="feed-live"]')) {
		if (live.closest(privateArea) || seen.has(live)) continue;
		seen.add(live);
		out.push({ root: live, player: live.querySelector<HTMLVideoElement>("video"), live: true });
	}
	return out;
}

// The slide being looked at, or null when the page is between slides.
export function currentSlide(): CurrentSlide | null {
	const laid = slides();
	if (!laid.length) return null;
	// A container can wrap several slides — the feed's own scroller does — so the
	// innermost container is what is measured, and the deepest match wins when two
	// cover the same area.
	const scored = laid
		.map((slide) => ({ slide, cover: coverage(slide.root) }))
		.filter((entry) => entry.cover >= OCCUPIED)
		.sort((a, b) => b.cover - a.cover);
	if (!scored.length) {
		// No slide is wholly on screen. On a work page a single laid-out slide is
		// still the answer; on the feed this is a transition, and naming "the first
		// one" would name the slide that just left.
		const only = laid.length === 1 ? laid[0] : null;
		return only && /\/video\/|\/note\//.test(location.pathname) ? only : null;
	}
	return scored[0]?.slide ?? null;
}

export function currentSlideRoot(): HTMLElement {
	const slide = currentSlide();
	if (!slide) fail("identity_mismatch", "The page is between slides");
	return slide.root;
}

export function currentPlayer(): HTMLVideoElement {
	const slide = currentSlide();
	if (slide?.player) return slide.player;
	// No identified slide but exactly one player laid out: a page that renders a
	// player without a recognisable container. Taking it is better than refusing a
	// read on a page that visibly has a work.
	const players = findRendered<HTMLVideoElement>(document, "video").filter(
		(element) => !element.closest('[data-e2e="im-dialog"]'),
	);
	return one(players, "visible video");
}

// The comment panel, answered the same way for every caller.
//
// "Is there a comment row in the DOM" was the old test, and it reports open on a
// work whose panel was never opened: the feed keeps the rows of an earlier work
// attached. What is being asked here is whether a panel is showing, so the panel
// itself is measured — the list container, by its own size.
export function commentPanel(): { open: boolean; rows: number; root: HTMLElement | null } {
	const roots = findRendered<HTMLElement>(document, '[data-e2e="comment-list"],.comment-list-container');
	const open = roots.filter((element) => {
		const box = element.getBoundingClientRect();
		return box.width > 0 && box.height > 0;
	});
	const root = open[0] ?? null;
	const rows = root ? root.querySelectorAll('[data-e2e="comment-item"]').length : 0;
	return { open: !!root, rows, root };
}
