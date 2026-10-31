import { clean, fail, find, one, type Point, point } from "./dom.ts";
import { guardVideo } from "./readers.ts";

// The feed's more-menu: the two controls that tell Douyin what this account wants
// to see less or more of.
//
// Verified on the live feed on 2026-10-31. Hovering the `...` control
// (`video-play-more`) reveals one strip holding five items. Only three carry a
// marker of their own:
//
//   推荐         data-e2e=""            label flips to 取消推荐 once given
//   上热门       data-e2e=""            an action, not a preference
//   不感兴趣     video-player-no-like
//   举报         video-player-report
//   快捷键列表   video-player-shoret-cut
//
// So "less" is identifiable by marker and "more" is not: it is the one target in
// the strip that must be found by exact text, and it toggles rather than acting
// once. Position is never the handle — it is only used to check that a label and
// the marked item sit in the same strip.
//
// The panel does not exist on `/video/<id>`. There, `video-play-more` is laid out
// at 0×0 and hovering the player never reveals it. It exists on the recommended
// feed and on the `?modal_id=` overlay, which is the same asymmetry the AI panel
// has.

export type Direction = "less" | "more";

export interface SteerState {
	/** The state the page is in now. "less" has none and always reads false. */
	value: boolean;
	label: string;
	/** Whether a press would change anything. "less" always presses. */
	matches: boolean;
}

interface SteerWitness {
	token: string;
	video_id: string;
	direction: Direction;
	before: boolean;
	// When this operation armed its press, so a toast already on screen from an
	// earlier action is not read as this one's.
	armed_at: number;
}

declare global {
	interface Window {
		__douyinCLISteer?: SteerWitness;
	}
}

// The strip is the parent of the marked "less" item. Anchoring on that one marker
// is what keeps a lookalike row elsewhere on the page from being read as this
// menu: the marker appears exactly once, and only while the panel is open.
function strip(): HTMLElement {
	const host = one(find(document, '[data-e2e="video-player-no-like"]'), "not-interested entry");
	const parent = host.parentElement;
	if (!parent) fail("selector_changed", "The more-menu has no strip");
	return parent;
}

function lessEntry(container: HTMLElement): HTMLElement {
	return one(
		[...container.children].filter(
			(element): element is HTMLElement =>
				element instanceof HTMLElement && element.getAttribute("data-e2e") === "video-player-no-like",
		),
		"not-interested entry",
	);
}

// "推荐" is the only target without a marker, so its own text is the handle. It is
// matched exactly and only on a leaf: the strip's text is all five labels
// concatenated, so a substring match would find the strip itself. The press goes
// to the row the label sits in, because the label is the text inside the circle
// whose handler is what reacts.
function moreEntry(container: HTMLElement): HTMLElement {
	// The label sits inside the row, and how many wrappers separate them differs
	// between the two directions' items. Climbing to the strip's direct child is
	// what makes the row the press target rather than a label whose own handler
	// may not be the one that reacts.
	const rows = find<HTMLElement>(container, "*")
		.filter((element) => !element.childElementCount && /^(推荐|取消推荐)$/.test(clean(element.textContent)))
		.map((leaf) => {
			let node: HTMLElement | null = leaf;
			while (node && node.parentElement !== container) node = node.parentElement;
			return node;
		})
		.filter((element): element is HTMLElement => !!element);
	return one(rows, "recommend entry");
}

export function steerTarget(direction: string): HTMLElement {
	const container = strip();
	return direction === "less" ? lessEntry(container) : moreEntry(container);
}

// What the page states right now.
//
// "Less" is an action, not a switch: the page offers nothing that reads back
// whether it applied, so it has no state and always presses. A caller must not
// treat that as "not yet done" and press again — one press is one instruction.
//
// "More" is a real switch and its label is its state: 推荐 means the account has
// not asked for more of this, 取消推荐 means it has. So `value` is the state the
// caller wants, and a press flips whatever is there — the same shape as the like
// and favorite toggles, for the same reason: a caller that can turn something on
// has to be able to turn it off.
export function steerState(direction: string, value: boolean): SteerState {
	const entry = steerTarget(direction);
	const label = clean(entry.innerText);
	// "Less" has no state, so nothing can match it: `value` reads false and a press
	// is always required.
	if (direction !== "more") return { value: false, label, matches: false };
	const current = label === "取消推荐";
	return { value: current, label, matches: current === value };
}

// Where the hover that opens the strip must land. The control only carries
// mouseenter handlers, so this returns a point to move to, not one to press.
export function steerOpener(): { x: number; y: number } {
	guardVideo();
	// The feed lays the next slide out too, so the control exists more than once.
	// Only the one on screen belongs to the work being looked at; the other one
	// opens the next work's menu.
	const candidates = find(document, '[data-e2e="video-play-more"]').filter((element) => {
		const box = element.getBoundingClientRect();
		return box.width > 0 && box.height > 0 && box.bottom > 0 && box.top < innerHeight;
	});
	const control = one(candidates, "more control on screen");
	const box = control.getBoundingClientRect();
	return { x: Math.round(box.left + box.width / 2), y: Math.round(box.top + box.height / 2) };
}

// Arms the press and records what the page said before it, so the result can tell
// a switch that was already in the requested state from one this press flipped.
export function prepareSteer(args: {
	token: string;
	video_id: string;
	direction: string;
	value: boolean;
}): Point & { already?: boolean } {
	guardVideo(args.video_id);
	const state = steerState(args.direction, args.value);
	// A request for the state the page is already in needs no press: "more" is a
	// switch, and "less" never matches, so it always presses.
	if (state.matches) return { x: 0, y: 0, selector: "", already: true };
	window.__douyinCLISteer = {
		token: args.token,
		video_id: args.video_id,
		direction: args.direction === "more" ? "more" : "less",
		before: state.value,
		armed_at: Date.now(),
	};
	return point(steerTarget(args.direction), args.token);
}

// The strip is re-read immediately before the press lands, so a page that
// re-rendered under a different layout cannot be pressed by a stale coordinate.
export function armSteer(args: { token: string; video_id: string; direction: string; value: boolean }): Point {
	const witness = window.__douyinCLISteer;
	if (!witness || witness.token !== args.token) fail("identity_mismatch", "The steer target changed before the press");
	guardVideo(args.video_id);
	if (steerState(args.direction, args.value).value !== witness.before)
		fail("identity_mismatch", "The menu changed before the press");
	return point(steerTarget(args.direction), args.token);
}

// Whatever the page states after the press: the text of a toast that is on screen
// now, and the menu's own labels when the menu happens to still be open.
//
// The strip closes on every press, so `open` is usually false and the caller has
// to reopen it to read the switch. Both are reported rather than guessed, and a
// null means "the page did not say", never "no".
export function steerOutcome(): { toast: string | null; open: boolean; labels: string[] } {
	const toast =
		find(document, '[data-e2e="toast"]')
			.map((element) => clean(element.textContent))
			.find((text) => text.length > 0) ?? null;
	const hosts = find(document, '[data-e2e="video-player-no-like"]');
	if (hosts.length !== 1) return { toast, open: false, labels: [] };
	const container = hosts[0].parentElement;
	const labels = container ? [...container.children].map((child) => clean((child as HTMLElement).innerText)) : [];
	return { toast, open: true, labels };
}

// Clears the page-level witness once the operation is over.
export function cleanupSteer(): void {
	delete window.__douyinCLISteer;
}
