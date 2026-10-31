import { clean, fail, find, one, own, type Point, point, reactProps } from "./dom.ts";
import { guardVideo } from "./readers.ts";
import { currentSlide } from "./slide.ts";

// Native share panel: forwarding a work as a platform card instead of a plain
// URL.
//
// Verified against the live page on 2026-10-27: the panel is
// [data-e2e="video-share-container"], each recipient row contains exactly one
// [data-userid] send button, and the row wrapper carries a per-build
// obfuscated class. The account identity (user.sec_uid) sits on the row's
// wrapper, not its leaves; it is the same value chat.list reports for a
// conversation, which is what lets a caller name a recipient by account rather
// than by display name. A row without it, or one whose value conflicts, is
// refused instead of guessed.

const PANEL = '[data-e2e="video-share-container"],.lC5eOSqy';
const SEND = "[data-userid]";

export interface ForwardRow {
	/** Stable numeric recipient id rendered on the send button. */
	userid: string;
	/** Account identity shared with chat.list; null when the row exposes none. */
	sec_uid: string | null;
	name: string;
	/** Member count shown for group chats, null for direct chats. */
	members: number | null;
	/** The page's own label for this row's action: 分享, 发送 or 捎句话. */
	send_label: string;
	disabled: boolean;
}

function visible(element: Element): boolean {
	const rect = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return (
		rect.width > 0 &&
		rect.height > 0 &&
		rect.bottom > 0 &&
		rect.right > 0 &&
		rect.top < innerHeight &&
		rect.left < innerWidth &&
		style.display !== "none" &&
		style.visibility !== "hidden"
	);
}

// The row is the nearest ancestor holding exactly one send button; that keeps
// a nested avatar or label from being mistaken for another recipient.
function rowOf(button: Element, panel: Element): HTMLElement | null {
	let node: Element | null = button.parentElement;
	while (node && node !== panel) {
		if (node.querySelectorAll(SEND).length === 1) return node as HTMLElement;
		node = node.parentElement;
	}
	return null;
}

// The row's own React props carry the recipient's sec_uid, which is the same
// identity chat.list reports for a conversation. Without it a row cannot be
// tied to a conversation, so it is read here rather than assumed.
function rowSecUid(row: HTMLElement, panel: Element): string | null {
	const found = new Set<string>();
	const seen = new Set<unknown>();
	const walk = (props: unknown, depth: number): void => {
		if (!props || typeof props !== "object" || seen.has(props) || depth > 4) return;
		seen.add(props);
		for (const holder of [own(props, "user"), own(own(props, "userInfo"), "info")])
			for (const field of ["sec_uid", "secUid"]) {
				const value = own(holder, field);
				if (typeof value === "string" && value) found.add(value);
			}
		const children = own(props, "children");
		for (const child of (Array.isArray(children) ? children : [children]).slice(0, 50))
			walk(own(child, "props"), depth + 1);
	};
	// The account identity sits on the row's wrapper, not its leaf nodes, so the
	// scan climbs while the subtree still holds exactly this one send button.
	// One step further would include sibling rows and mix recipients.
	for (let element: Element | null = row; element && element !== panel; element = element.parentElement) {
		const buttons = element.querySelectorAll(SEND).length;
		if (buttons !== 1) break;
		for (const node of [element, ...element.querySelectorAll("*")].slice(0, 80))
			for (const props of reactProps(node)) walk(props, 0);
		if (found.size) break;
	}
	return found.size === 1 ? [...found][0] : null;
}

function parseRow(button: Element, row: HTMLElement, secUid: string | null): ForwardRow | null {
	const userid = button.getAttribute("data-userid");
	if (!userid || !/^\d{1,32}$/.test(userid)) return null;
	const lines = (row.innerText || "")
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const label = clean(button.textContent);
	// The last line is the button; a purely numeric line before it is the
	// member count the page shows for group chats.
	const body = lines.filter((line) => line !== label);
	const members = body.length > 1 && /^\d+$/.test(body[body.length - 1]) ? Number(body[body.length - 1]) : null;
	const name = (members === null ? body[body.length - 1] : body[body.length - 2]) ?? "";
	return {
		userid,
		sec_uid: secUid,
		name,
		members,
		send_label: label,
		// The label varies by page state, not by a relationship the CLI can
		// verify: 捎句话 and 分享 are both share actions.
		disabled:
			button.hasAttribute("disabled") ||
			button.getAttribute("aria-disabled") === "true" ||
			!/^(分享|发送|捎句话)$/.test(label),
	};
}

export function readForwardPanel(): ForwardRow[] {
	const panel = find(document, PANEL).find((element) => visible(element));
	if (!panel) return [];
	const seen = new Set<string>();
	const rows: ForwardRow[] = [];
	for (const button of panel.querySelectorAll(SEND)) {
		if (!visible(button)) continue;
		const row = rowOf(button, panel);
		if (!row) continue;
		const parsed = parseRow(button, row, rowSecUid(row, panel));
		// The same recipient rendered twice cannot be resolved to one row.
		if (!parsed || seen.has(parsed.userid)) {
			if (parsed) return [];
			continue;
		}
		seen.add(parsed.userid);
		rows.push(parsed);
	}
	return rows;
}

// The live chat list does not expose a stable conversation ID, so the share
// panel's own numeric recipient id is the target. It is the only stable
// identifier either surface offers, and it identifies the account, not a name.
export function forwardTarget(recipient: string, rows: ForwardRow[]): ForwardRow {
	// The conversation ID and the panel row both carry the same sec_uid, so the
	// account identity is the join key. The numeric uid is accepted as a
	// secondary form for callers that already read it from the panel.
	const wanted = recipient.startsWith("secuid:") ? recipient.slice("secuid:".length) : recipient;
	const matches = rows.filter((row) => (row.sec_uid && row.sec_uid === wanted) || row.userid === wanted);
	if (matches.length !== 1)
		fail(
			"identity_mismatch",
			"Share panel does not expose exactly one matching recipient",
			"Run chat list for a secuid value, or forward list for the panel's own recipients.",
		);
	const row = matches[0];
	if (row.disabled)
		fail(
			"recipient_unavailable",
			`This recipient offers "${row.send_label}" rather than a share action`,
			"Run forward list to see which recipients the panel currently offers.",
		);
	return row;
}

// Enumeration is how a caller learns which recipients are available; it is the
// only stable way to find a userid, because the chat list has none.
export function listForwardRecipients(): ForwardRow[] {
	return readForwardPanel();
}

export function scrollSharePanel(pixels: number): { before: number; after: number } {
	const scroller = shareScroller();
	if (!scroller) fail("selector_changed", "Share panel has no scrollable list");
	const before = scroller.scrollTop;
	scroller.scrollBy(0, pixels);
	return { before, after: scroller.scrollTop };
}

function shareScroller(): HTMLElement | undefined {
	const panel = find(document, PANEL).find((element) => visible(element));
	if (!panel) return undefined;
	return [panel, ...panel.querySelectorAll<HTMLElement>("*")].find((element) => {
		const style = getComputedStyle(element);
		return /(auto|scroll)/.test(style.overflowY) && element.scrollHeight > element.clientHeight;
	});
}

// A recipient can be rendered but covered by the panel's own footer, so being
// in the DOM is not the same as being clickable. Scrolling it into the clear is
// what makes the click land on the intended row.
export function revealForwardRow(userid: string): { revealed: boolean; found: boolean; blocked: boolean } {
	const container = shareScroller();
	const button = forwardButton(userid);
	if (!button) return { revealed: false, found: false, blocked: false };
	const rect = button.getBoundingClientRect();
	// A row is clickable only when its own centre hits it; a panel footer or the
	// video overlay otherwise receives the click.
	if (button.contains(document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2)))
		return { revealed: true, found: true, blocked: false };
	if (!container) return { revealed: false, found: true, blocked: true };
	// Centre the row in the list and let the page settle; the caller re-reads.
	const offset = rect.top - container.getBoundingClientRect().top;
	container.scrollTop = Math.max(0, container.scrollTop + offset - container.clientHeight / 2);
	return { revealed: false, found: true, blocked: true };
}

function forwardButton(userid: string): HTMLElement | undefined {
	const panel = find(document, PANEL).find((element) => visible(element));
	if (!panel) return undefined;
	return [...panel.querySelectorAll<HTMLElement>(SEND)].find(
		(element) => element.getAttribute("data-userid") === userid,
	);
}

// The share control is a hover-revealed entry, not a click target: its wrapper
// only has onMouseEnter/onMouseLeave on the live page. The icon inside it is
// what the page reacts to, so this returns the icon when it is present.
export function shareEntry(): HTMLElement {
	guardVideo();
	// The share control is in the current slide's rail. Scoping to `feed-active-video`
	// only found it on the feed; other forms that render a slide mark it differently,
	// and the entry was missing there.
	const slide = currentSlide();
	if (!slide) fail("identity_mismatch", "The page is between slides");
	const entries = find(slide.root, '[data-e2e="video-player-share"],[data-e2e="video-share-icon-container"]');
	const entry = one(entries, "share entry");
	const icon = find(entry, ".s7K4YLGp");
	return icon.length === 1 ? icon[0] : entry;
}

export function prepareForward(args: { token: string; recipient_id?: string; video_id: string }) {
	guardVideo(args.video_id);
	const rows = readForwardPanel();
	if (!rows.length) fail("selector_changed", "Share panel did not expose any recipient rows");
	const target = forwardTarget(args.recipient_id ?? "", rows);
	// The row can be rendered but covered by the panel footer. Scrolling is what
	// moves it into the clear; point() below would otherwise refuse, so the
	// caller retries once the page has settled.
	const panel = find(document, PANEL).find((element) => visible(element));
	if (!panel) fail("selector_changed", "Share panel disappeared before sending");
	const button = [...panel.querySelectorAll<HTMLElement>(SEND)].find(
		(element) => element.getAttribute("data-userid") === target.userid,
	);
	if (!button) fail("selector_changed", "Share button disappeared before sending");
	button.setAttribute("data-douyin-cli-forward", args.token);
	setForwardState({
		token: args.token,
		userid: target.userid,
		button,
		videoID: args.video_id,
		sendLabel: target.send_label,
	});
	return point(button, args.token);
}

interface ForwardState {
	token: string;
	userid: string;
	button: HTMLElement;
	videoID: string;
	/** The panel row text captured before the click, for the receipt. */
	label: string;
	/** The label the page showed on this row's action button. */
	sendLabel: string;
	dispatched: boolean;
	/**
	 * What the button said before the click, and what the page set it to after.
	 * A share that landed turns 分享 into 捎句话 and the button greys out; that
	 * change is the page's own statement that it took the action, and it is a
	 * better witness than the panel closing, which also happens on a cancel.
	 */
	label_before?: string;
	label_after?: string;
}
declare global {
	interface Window {
		__douyinCLIForward?: ForwardState;
	}
}

function setForwardState(state: Omit<ForwardState, "dispatched" | "label">): void {
	const panel = find(document, PANEL).find((element) => visible(element));
	const button = panel?.querySelector(`[data-userid="${state.userid}"]`);
	const row = button?.parentElement;
	window.__douyinCLIForward = {
		...state,
		label: clean(row?.innerText ?? ""),
		dispatched: false,
		label_before: clean(button?.textContent ?? ""),
	};
	// The witness is bound at the document level and re-reads the clicked row's
	// identity, so a React re-render that replaces the button node does not
	// lose the evidence. Only a trusted click counts.
	document.addEventListener(
		"click",
		(event) => {
			const current = window.__douyinCLIForward;
			if (!event.isTrusted || !current || current.token !== state.token) return;
			const path = event.composedPath();
			const clicked = path.find(
				(node): node is HTMLElement => node instanceof HTMLElement && node.hasAttribute("data-userid"),
			);
			// A click on a different row is not this operation's dispatch.
			if (clicked?.getAttribute("data-userid") !== current.userid) return;
			current.dispatched = true;
			// The page relabels the button when it accepts the share, but not on the
			// next frame — it happens after its own async handler, and the panel can
			// close before a single late read lands. So the label is sampled a few
			// times over the first second and the first non-empty change is kept.
			const sample = (attempt: number) => {
				if (current.label_after && current.label_after !== current.label_before) return;
				const live = find(document, PANEL)
					.find((element) => visible(element))
					?.querySelector(`[data-userid="${current.userid}"]`);
				const text = clean(live?.textContent ?? "");
				if (text) current.label_after = text;
				if (attempt < 6) setTimeout(() => sample(attempt + 1), 120 * (attempt + 1));
			};
			setTimeout(() => sample(0), 60);
		},
		{ capture: true },
	);
}

// The recipient is re-read immediately before the click lands, so a panel
// that re-rendered under a different row cannot be clicked by position.
export function armForward(args: { token: string; recipient_id?: string; video_id: string }): Point {
	const state = window.__douyinCLIForward;
	if (!state || state.token !== args.token) fail("identity_mismatch", "Share row changed before sending");
	guardVideo(args.video_id);
	const rows = readForwardPanel();
	const target = forwardTarget(args.recipient_id ?? "", rows);
	if (target.userid !== state.userid) fail("identity_mismatch", "Share recipient changed before sending");
	// Re-resolve the live button rather than trusting the node captured earlier:
	// the panel may have re-rendered, and the old node may now carry another
	// recipient's identity.
	const panel = find(document, PANEL).find((element) => visible(element));
	if (!panel) fail("selector_changed", "Share panel disappeared before sending");
	const button = [...panel.querySelectorAll<HTMLElement>(SEND)].find(
		(element) => element.getAttribute("data-userid") === target.userid,
	);
	if (!button) fail("selector_changed", "Share button disappeared before sending");
	state.button = button;
	return point(button, args.token);
}

// A disappearing row is a UI observation, not proof of message delivery.
export function forwardResult(args: { token: string; recipient_id?: string; video_id: string }) {
	const state = window.__douyinCLIForward;
	// Without the witness the click cannot be classified: it may have been
	// blocked before dispatch or it may have dispatched and lost its state.
	// Reporting that as "not sent" would invite a duplicate, so it stays
	// uncertain instead.
	if (!state || state.token !== args.token) return { confirmed: false, dispatched: true, uncertain: true };
	if (state.dispatched !== true) return { confirmed: false, blocked: true };
	const panelOpen = readForwardPanel().some((row) => row.userid === state.userid);
	// The page gives two signs that it took the share, and only one of them is
	// the panel closing — which also happens when the caller cancels. The other is
	// the button itself: 分享 turns into 捎句话 and greys out once the work has been
	// sent to that person. That relabel is the page stating the outcome, so it
	// confirms the send instead of leaving every share uncertain.
	// Read the row as it is now rather than trusting the frame captured at click
	// time: the page relabels after its own handler, which is later than the next
	// animation frame. The live read is what said 捎句话 while the captured one
	// still said 分享.
	const liveLabel = clean(
		find(document, PANEL)
			.find((element) => visible(element))
			?.querySelector(`[data-userid="${state.userid}"]`)?.textContent ?? "",
	);
	const after = liveLabel || state.label_after || "";
	const relabelled = !!after && after !== state.label_before;
	return {
		confirmed: relabelled,
		dispatched: true,
		uncertain: !relabelled && !panelOpen,
		record: {
			recipient_id: state.userid,
			video_id: state.videoID,
			panel_closed: !panelOpen,
			row: state.label,
			send_label: state.sendLabel,
			label_before: state.label_before ?? null,
			label_after: after || null,
		},
	};
}
