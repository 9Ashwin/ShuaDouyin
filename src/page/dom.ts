export interface PageError {
	code: string;
	message: string;
	hint?: string;
}

export function fail(code: string, message: string, hint = ""): never {
	throw { code, message, hint } satisfies PageError;
}

export function one<T>(items: T[], label: string): T {
	if (items.length !== 1) {
		fail(
			"selector_changed",
			`Expected one ${label}, found ${items.length}`,
			"Read status and screenshot; the page may have changed.",
		);
	}
	return items[0];
}

export function visible(element: Element | null): element is HTMLElement {
	if (!element) return false;
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
		style.visibility !== "hidden" &&
		style.opacity !== "0"
	);
}

export function find<T extends HTMLElement = HTMLElement>(root: ParentNode, selectors: string): T[] {
	return [...root.querySelectorAll<T>(selectors)].filter(visible);
}

// Laid out but possibly scrolled out of view. Reading a long list must not
// depend on the viewport: a comment below the fold is still a comment.
export function rendered(element: Element | null): element is HTMLElement {
	if (!element) return false;
	const rect = element.getBoundingClientRect();
	const style = getComputedStyle(element);
	return rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
}

export function findRendered<T extends HTMLElement = HTMLElement>(root: ParentNode, selectors: string): T[] {
	return [...root.querySelectorAll<T>(selectors)].filter(rendered);
}

export function clean(value: string | null | undefined): string {
	return (value ?? "").replace(/\s+/g, " ").trim();
}

// Only inspect scalar values on already rendered controls; never invoke React callbacks or getters.
export function own(object: unknown, key: string): unknown {
	if (!object || typeof object !== "object") return undefined;
	return Object.getOwnPropertyDescriptor(object, key)?.value;
}

// A page store may expose a value through a getter on the instance rather than
// as a data property. `own` deliberately refuses those, and that rule exists to
// stop this adapter from running React callbacks; a plain getter returning a
// record is a different thing, but it is still page code. So reading one is
// opt-in, by name, at the call site — never a blanket walk of a props object.
export function getterValue(object: unknown, key: string): unknown {
	if (!object || typeof object !== "object") return undefined;
	const descriptor = Object.getOwnPropertyDescriptor(object, key);
	if (!descriptor || typeof descriptor.get !== "function") return undefined;
	try {
		return descriptor.get.call(object);
	} catch {
		return undefined;
	}
}

// Some page records expose their id on the prototype instead of the instance.
// Walking the chain is safe only while every step is a plain data property: a
// getter would run page code, so the first accessor ends the search.
export function inherited(object: unknown, key: string): unknown {
	let node: object | null = object && typeof object === "object" ? object : null;
	for (let depth = 0; node && depth < 6; depth++) {
		const descriptor = Object.getOwnPropertyDescriptor(node, key);
		if (descriptor) return "value" in descriptor ? descriptor.value : undefined;
		node = Object.getPrototypeOf(node) as object | null;
	}
	return undefined;
}

export function scalarID(value: unknown): string | null {
	if (typeof value === "string" && value.trim() && value.length <= 512) return value;
	if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
	return null;
}

export function reactProps(element: Element): unknown[] {
	return Object.getOwnPropertyNames(element)
		.filter((key) => key.startsWith("__reactProps$"))
		.map((key) => own(element, key));
}

// Douyin serves the same id under /video/ and /note/; the path decides which
// kind the page is, and modal links always carry the id as a query parameter.
export function routeKind(href: string): { kind: "video" | "note" | null; id: string | null } {
	try {
		const url = new URL(href, location.href);
		if (url.origin !== "https://www.douyin.com") return { kind: null, id: null };
		const path = /\/(video|note)\/(\d{1,64})(?:\/|$)/.exec(url.pathname);
		if (path) return { kind: path[1] as "video" | "note", id: path[2] };
		const id = url.searchParams.get("modal_id");
		return id && /^\d{1,64}$/.test(id) ? { kind: "video", id } : { kind: null, id: null };
	} catch {
		return { kind: null, id: null };
	}
}

export function videoID(value: string): string | null {
	return routeKind(value).id;
}

export function editorText(editor: HTMLElement): string {
	const text =
		editor instanceof HTMLTextAreaElement || editor instanceof HTMLInputElement ? editor.value : editor.innerText;
	return text.replace(/\r\n/g, "\n");
}

// A chosen @ is not plain text, and the page spells it differently in the
// composer than in a delivered row: the editor marks it with a uuid, the row
// uses a class. Both spellings mean the same thing here, so one helper decides
// what counts as a mention and every caller agrees on it.
export function mentionNodes(root: ParentNode): HTMLElement[] {
	return [...root.querySelectorAll<HTMLElement>('[data-uuid^="mention"], [class*="mentionText"]')];
}

export function mentionName(node: HTMLElement): string {
	// The composer pads the insert with a trailing space so typing continues
	// after the name; it is layout, not part of who was addressed.
	return clean(node.textContent).replace(/^@/, "").trim();
}

// Removing just the mention span would leave behind the zero-width padding and
// the wrapper the page renders around it, and those would read as draft text.
// The page puts each mention in its own leaf inside the line, so the whole leaf
// goes when nothing else lives in it; a mention that shares a leaf with typed
// text is removed on its own.
export function detachMentions(root: HTMLElement): void {
	for (const node of mentionNodes(root)) {
		let leaf: HTMLElement = node;
		while (leaf.parentElement && leaf.parentElement !== root && !leaf.parentElement.matches('[data-node="true"]')) {
			leaf = leaf.parentElement;
		}
		let leftover = leaf.textContent ?? "";
		for (const other of mentionNodes(leaf)) leftover = leftover.replace(other.textContent ?? "", "");
		if (leftover.replace(/[\u200b\ufeff]/g, "").trim()) node.remove();
		else leaf.remove();
	}
}

export function editorHasDraft(editor: HTMLElement): boolean {
	return (
		!!editorText(editor)
			.replace(/[\u200b\ufeff]/g, "")
			.trim() || !!editor.querySelector('img,video,audio,[data-slate-void="true"]')
	);
}

export interface Point {
	x: number;
	y: number;
	selector: string;
}

export function point(element: HTMLElement, token: string): Point {
	// Controls in long lists are often laid out below the fold, and an animated
	// panel moves them after they render. Both mean a point is only valid for the
	// frame it was measured in, so the measurement is retried a few times and the
	// press is only armed once the aim actually lands on the control.
	const box = element.getBoundingClientRect();
	if (!(box.top >= 0 && box.bottom <= innerHeight && box.width > 0 && box.height > 0))
		element.scrollIntoView({ block: "center", inline: "nearest" });
	const disabled = !!element.closest(':disabled,[aria-disabled="true"]');
	// A control can be present in the DOM and still have no size yet: the comment
	// publish icon renders inside its container before it is painted, so a
	// measurement taken at that moment is 0x0 and the press is refused. Ten tries
	// over 800ms was not enough on a real page, and the failure said only that the
	// control was hidden — which is why this cost a send twice without anything
	// pointing at the wait.
	let last = { width: 0, height: 0, covered: false };
	for (let attempt = 0; attempt < 25; attempt++) {
		const rect = element.getBoundingClientRect();
		const x = rect.left + rect.width / 2;
		const y = rect.top + rect.height / 2;
		const hit = document.elementFromPoint(x, y);
		const sized = rect.width > 0 && rect.height > 0;
		const aimed = sized && !!hit && (hit === element || element.contains(hit));
		last = { width: Math.round(rect.width), height: Math.round(rect.height), covered: sized && !aimed };
		if (aimed && !disabled) {
			element.setAttribute("data-douyin-cli-control", token);
			return { x, y, selector: `[data-douyin-cli-control="${token}"]` };
		}
		sleepSync(80);
	}
	// The three ways this fails need different reactions, so the message says which
	// one happened rather than leaving the caller to guess.
	const why = disabled
		? "it is disabled"
		: last.width === 0 || last.height === 0
			? `it has no size (${last.width}x${last.height}); the page had two seconds to paint it`
			: "something is covering it";
	fail("selector_changed", `Target control is not clickable because ${why}`);
}

// The page adapter runs inside the page, where blocking briefly is the only way
// to let a layout settle between two measurements.
function sleepSync(ms: number): void {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		/* wait for the page to finish laying out */
	}
}

// A stable id for a page record, without being told which field holds it.
//
// The conversation record's ids have moved and been renamed more than once:
// a direct chat keeps conversationId/conversationShortId, a group keeps plain
// id/shortId, and the fields live on the prototype rather than the instance.
// Each rename cost a silent failure, because a lookup by name returns nothing
// and the caller cannot tell "no id" from "the field is called something else".
//
// This scans the record's own prototype chain for values shaped like a platform
// id and returns the one the whole chain agrees on. Agreement is what makes it
// safe: a record with two different id-shaped values is refused rather than
// guessed at.
export function stableId(record: unknown, preferred: string[] = []): string | null {
	const found = new Map<string, Set<string>>();
	let node: object | null = record && typeof record === "object" ? record : null;
	for (let depth = 0; node && depth < 6; depth++) {
		for (const key of Object.getOwnPropertyNames(node)) {
			// `id`-shaped names only: this is a record scan, not a content scan.
			if (!/(?:^id$|Id$|_id$|ShortId$|GroupId$)/.test(key)) continue;
			const descriptor = Object.getOwnPropertyDescriptor(node, key);
			if (!descriptor) continue;
			let value: unknown;
			if ("value" in descriptor) value = descriptor.value;
			else if (typeof descriptor.get === "function") {
				try {
					value = descriptor.get.call(record);
				} catch {
					continue;
				}
			} else continue;
			const id = scalarID(value);
			if (!id || !isPlatformId(id)) continue;
			const set = found.get(key) ?? new Set<string>();
			set.add(id);
			found.set(key, set);
		}
		node = Object.getPrototypeOf(node) as object | null;
	}
	// A name the caller trusts wins when it is unambiguous.
	for (const key of preferred) {
		const values = found.get(key);
		if (values?.size === 1) return [...values][0];
	}
	// Otherwise every field that reported must agree on one value.
	const all = new Set([...found.values()].flatMap((values) => [...values]));
	return all.size === 1 ? [...all][0] : null;
}

// A platform id: a bare number, or a colon-joined numeric tuple. Anything
// shorter than five digits is a count or an index, not an identity.
function isPlatformId(value: string): boolean {
	if (/^\d{5,32}$/.test(value)) return true;
	return /^\d{1,20}(?::\d{1,20}){1,4}$/.test(value);
}
