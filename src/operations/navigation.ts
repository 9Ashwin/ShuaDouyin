import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session, Snapshot } from "../browser.ts";
import { CliError } from "../errors.ts";
import type { Input } from "./validate.ts";

// Opening pages and collecting their loaded results. Navigation never writes.

// The user-result route is more reliable than clicking the 用户 tab, so it is
// tried first; the tab is only a fallback and must prove itself through the URL.
export async function searchUsers(
	session: Session,
	query: string,
	input: Input,
	signal: AbortSignal,
): Promise<unknown> {
	const url = `https://www.douyin.com/search/${encodeURIComponent(query)}?type=user`;
	await session.tab.goto(url, { waitUntil: "domcontentloaded" });
	await waitSnapshot(session, (state) => state.page_kind === "search", signal);
	if (!(await onUserTab(session))) {
		await clickUserTab(session);
		await waitSnapshot(session, () => true, signal, 5000);
		if (!(await onUserTab(session))) {
			const state = await session.status();
			throw new CliError("selector_changed", "User search results are not active", {
				hint: "Open the search page and select 用户 manually, then read it again.",
				details: state,
			});
		}
	}
	await waitSearchResults(session, query, signal, "search.users");
	return listResults(session, "search.users", input, signal, "sec_uid");
}

async function onUserTab(session: Session): Promise<boolean> {
	const state = await session.status();
	return new URL(state.url ?? "https://www.douyin.com/").searchParams.get("type") === "user";
}

async function clickUserTab(session: Session): Promise<void> {
	await session.tab
		.getByText(/^用户$/)
		.first()
		.click({ timeout: 3000 })
		.catch(() => undefined);
}

export async function navigate(session: Session, url: string, kind: string, signal: AbortSignal): Promise<Snapshot> {
	await session.tab.goto(url, { waitUntil: "domcontentloaded" });
	return waitSnapshot(
		session,
		(state) =>
			kind === "video"
				? // Douyin redirects an image post from /video/ to /note/.
					!!(state.video?.id ?? state.note?.id)
				: kind === "search"
					? state.page_kind === "search"
					: // The route commits before the profile renders, so the URL alone would let
						// the caller read a page whose header has not appeared yet.
						!!state.url?.includes("/user/") && state.page_kind === "profile",
		signal,
	).catch((error: unknown) => {
		// A profile that redirects elsewhere is a real answer, not a changed selector:
		// Douyin sends restricted or unavailable accounts to the search page. Saying
		// "the page did not reach the expected state" hides which of the two happened
		// and sends the caller looking for a broken selector.
		// Only when the page actually went somewhere else. A profile that simply took
		// too long is a different answer, and calling it "not found" would send the
		// caller looking for a restricted account that is fine.
		if (kind === "profile" && error instanceof CliError && error.code === "selector_changed") {
			const landed = String((error.details as { url?: unknown } | undefined)?.url ?? "");
			if (landed && !landed.includes("/user/"))
				throw new CliError("not_found", "This profile redirected elsewhere", {
					hint: "Douyin sent this account somewhere other than its profile: it may be restricted, deleted, or require a fresh login. Run dy auth status, or open one of their works with dy video open.",
					details: { requested: url, landed },
				});
		}
		throw error;
	});
}

// The recommended feed lives at https://www.douyin.com/?recommend=1, but a
// plain load of that URL can land on the 精选 page instead, and the feed there
// renders no playing work. The 推荐 tab is an ordinary link back to the same
// URL, so clicking it recovers the feed without a second full navigation.
export const RECOMMEND_URL = "https://www.douyin.com/?recommend=1";

export async function openRecommendFeed(session: Session, signal: AbortSignal): Promise<Snapshot> {
	// The feed serves live slides as ordinary stops. Landing on one is the feed
	// being open, not a failed load: treating it as failure made `feed open` time
	// out and took every work-reading command after it with it.
	const arrived = (state: Snapshot) => !!state.url?.includes("recommend=1") && state.slide.kind !== "page";
	let state: Snapshot;
	try {
		await session.tab.goto(RECOMMEND_URL, { waitUntil: "domcontentloaded" });
		state = await waitSnapshot(session, arrived, signal);
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== "selector_changed") throw error;
		await enterRecommendTab(session);
		state = await waitSnapshot(session, arrived, signal);
	}
	if (!state.url?.includes("recommend=1")) {
		// A different route loaded but happened to render work; the caller asked
		// for the feed, so report what it actually got instead of pretending.
		throw new CliError("selector_changed", "The recommended feed did not open", { details: state });
	}
	// Landing on a live slide is honest but almost never what the caller wanted:
	// every work-reading command after it fails. One step forward is taken here,
	// and the result says it happened, so a caller that does want the live slide
	// still learns it was there.
	if (state.slide.kind === "live") {
		try {
			const moved = await moveFeed(session, "feed.next", signal);
			return { ...moved, ...(state.slide.id ? { skipped_live: state.slide.id } : {}) };
		} catch {
			// The live slide stayed put; the caller gets the real state rather than
			// an error, because the feed is open and this is what it is showing.
			return state;
		}
	}
	return state;
}

// A live slide swallows the first next-arrow press: the player is still
// claiming the click for its own overlay, and the feed only advances on the
// second. Pressing again is safe here in a way it would not be for a write —
// this only moves the feed, and the key comparison below still requires the
// slide to actually change, so a duplicate press can never be reported as a
// second move.
export interface SweptWork {
	id: string;
	url: string;
	author_id: string | null;
	title: string;
	duration: number | null;
}

// Walking the feed one command at a time costs a process and a CDP connection
// per work, which is most of the wall clock when a caller reads a dozen. This
// does the walk inside one connection and returns what it saw.
//
// It is deliberately a read: it moves the feed and collects identity, and never
// likes, comments or follows. Slides it cannot read are counted rather than
// silently dropped, because "10 requested, 6 returned" is the honest answer when
// the feed served live streams.
export async function sweepFeed(
	session: Session,
	options: { count: number; maxSteps?: number; signal: AbortSignal },
): Promise<{
	works: SweptWork[];
	skipped: { live: number; unreadable: number };
	steps: number;
	// Why the walk ended. Without it a short result is indistinguishable from a
	// feed that stopped moving, and the caller cannot tell whether to re-run.
	stopped: "count_reached" | "steps_exhausted" | "feed_stuck";
	error: string | null;
	step_ms: { step: number; ms: number }[];
}> {
	const works: SweptWork[] = [];
	const skipped = { live: 0, unreadable: 0 };
	const seen = new Set<string>();
	const maxSteps = options.maxSteps ?? options.count * 3;
	let steps = 0;
	let stopped: "count_reached" | "steps_exhausted" | "feed_stuck" = "count_reached";
	let error: string | null = null;
	const step_ms: { step: number; ms: number }[] = [];

	const collect = (state: Snapshot): boolean => {
		const video = state.video;
		if (!video?.id) {
			if (state.slide.kind === "live") skipped.live++;
			else skipped.unreadable++;
			return false;
		}
		if (seen.has(video.id)) return false;
		seen.add(video.id);
		works.push({
			id: video.id,
			url: `https://www.douyin.com/video/${video.id}`,
			author_id: video.author_id ?? null,
			title: typeof video.title === "string" ? video.title : "",
			duration: typeof video.duration === "number" ? video.duration : null,
		});
		return true;
	};

	// Sweeping from whatever page happens to be open fails immediately: a detail
	// page has no feed arrows at all. Open the feed first when it is not already
	// the current one, and let that failure be the caller's error rather than a
	// confusing "feed stuck" after a single step.
	const first = await session.status();
	if (!first.url?.includes("recommend=1") || first.slide.kind === "page")
		await openRecommendFeed(session, options.signal);
	collect(await session.status());
	while (works.length < options.count && steps < maxSteps) {
		steps++;
		const started = Date.now();
		try {
			// Most presses land in about 130ms, but roughly one in six does not
			// move the feed at all. `moveFeed` waits its full 8 seconds before
			// retrying, which is right for a single caller and wasteful for a
			// walk: one dead press turned a 10-work sweep into 70 seconds. Here a
			// short window is enough to tell a slow slide from a missed press, so
			// each step gets a quick attempt and the retry happens sooner.
			collect(await moveFeed(session, "feed.next", options.signal, { settle: 800, attempts: 8 }));
		} catch (caught) {
			// A slide that refuses to move ends the sweep with what was gathered.
			// Carrying the error would turn a partial read into no read at all.
			if (!(caught instanceof CliError) || caught.code !== "selector_changed") throw caught;
			stopped = "feed_stuck";
			error = caught.message;
			break;
		}
		step_ms.push({ step: steps, ms: Date.now() - started });
	}
	if (works.length >= options.count) stopped = "count_reached";
	else if (stopped !== "feed_stuck") stopped = "steps_exhausted";
	// Per-step timings stay in the response while this is measured on the real
	// page. A caller reading a dozen works cares how long each one cost, and the
	// total alone hides which step stalled.
	return { works, skipped, steps, stopped, error, step_ms };
}

export async function moveFeed(
	session: Session,
	name: "feed.next" | "feed.previous",
	signal: AbortSignal,
	// How long one attempt waits, and how many presses are granted in total. A
	// single caller reads a slow page once, so the defaults favour patience; a
	// sweep presses repeatedly and would rather retry than wait.
	tuning: { settle?: number; attempts?: number } = {},
): Promise<Snapshot> {
	const before = await session.status();
	const slideKey = (state: Snapshot) =>
		state.slide.kind === "page" ? null : `${state.slide.kind}:${state.slide.id ?? ""}`;
	const was = slideKey(before);
	const moved = (state: Snapshot) => {
		const now = slideKey(state);
		return !!now && !!state.slide.id && now !== was;
	};
	const settle = tuning.settle ?? 8000;
	const attempts = tuning.attempts ?? 2;
	// A live slide swallows the first press and then obeys. That is specific to
	// live and is why the extra press is granted there. For any other slide a
	// second press is only allowed when the page is provably still on the work it
	// started from: pressing again after a move that merely took longer than the
	// window would skip a work the caller never asked to pass.
	for (let attempt = 0; attempt < attempts; attempt++) {
		await control(session, name, { video_id: before.video?.id });
		const live = before.slide.kind === "live";
		try {
			return await waitSnapshot(session, moved, signal, live && attempt === 0 ? 2500 : settle);
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "selector_changed") throw error;
			// A short window can expire just before the slide lands. Before treating
			// that as a missed press — and pressing again, which would skip a work —
			// read where the page actually is. It moved; report it.
			const now = await session.status().catch(() => null);
			if (now && moved(now)) return now;
			if (attempt === attempts - 1) throw error;
			// Unmoved is the precondition for pressing again, and it has to be read
			// from the page rather than assumed from the timeout.
			if (!now || slideKey(now) !== was) throw error;
			await delay(250, undefined, { signal });
		}
	}
	// Where it actually is, not just that it failed. A caller deciding whether to
	// retry, skip or stop needs to know if it is stuck on a live slide, a detail
	// page or the same work; "selector_changed" alone answers none of that.
	const now = await session.status().catch(() => null);
	throw new CliError("selector_changed", "The feed did not move to another slide", {
		details: {
			from: { kind: before.slide.kind, id: before.slide.id, page_kind: before.page_kind },
			now: now
				? {
						kind: now.slide.kind,
						id: now.slide.id,
						page_kind: now.page_kind,
						video_id: now.video?.id ?? null,
					}
				: null,
			// The advice differs by state: a live slide swallows the first press,
			// a detail page has no feed arrows at all.
			hint:
				before.slide.kind === "live"
					? "A live slide can swallow a press; try once more."
					: before.page_kind !== "video"
						? "This page is not the feed; open the feed first."
						: "The feed did not respond; check that the tab is not covered by a panel.",
		},
		hint:
			before.slide.kind === "live"
				? "A live slide can swallow a press; try once more."
				: "Check the page state before retrying.",
	});
}

async function enterRecommendTab(session: Session): Promise<void> {
	const tab = session.tab.locator('a[href*="recommend=1"]').first();
	await tab.click({ timeout: 3000 }).catch(() => undefined);
}

// Search renders its cards after the route is ready. An empty initial DOM is
// not evidence that the search has no results, so allow a bounded load window.
export async function waitSearchResults(
	session: Session,
	query: string,
	signal: AbortSignal,
	operation = "search.results",
): Promise<void> {
	const deadline = Date.now() + 6000;
	while (true) {
		await checkSearchIdentity(session, query, operation);
		const rows = await session.call<unknown[]>(operation);
		await checkSearchIdentity(session, query, operation);
		if (rows.length || Date.now() >= deadline) return;
		await delay(250, undefined, { signal });
	}
}

async function checkSearchIdentity(session: Session, query: string, operation: string) {
	const state = await session.status();
	if (state.verification_required) throw new CliError("verification_required", "Human verification is required");
	if (state.login_required) throw new CliError("login_required", "Douyin requires login");
	const url = state.url ? new URL(state.url) : null;
	const type = url?.searchParams.get("type") ?? null;
	if (
		!url ||
		state.private_chat_visible ||
		url.pathname !== `/search/${encodeURIComponent(query)}` ||
		state.page_kind !== "search" ||
		(operation === "search.users" ? type !== "user" : ![null, "general"].includes(type))
	)
		throw new CliError("identity_mismatch", "Search page changed while loading results");
}

async function clickSearchControl(session: Session, point: Point) {
	if (point.already) return;
	if (!point.selector) throw new CliError("selector_changed", "Search filter has no verified selector");
	await session.tab.locator(point.selector).click({ timeout: 3000 });
}

export async function applySearchFilters(session: Session, input: Input, signal: AbortSignal) {
	const requested: { group: number; choice: number; name: string; value: string }[] = [];
	if (input.sort)
		requested.push({
			group: 0,
			choice: ["relevance", "newest", "likes"].indexOf(input.sort),
			name: "sort",
			value: input.sort,
		});
	if (input.published)
		requested.push({
			group: 1,
			choice: ["any", "day", "week", "half-year"].indexOf(input.published),
			name: "published",
			value: input.published,
		});
	if (!requested.length) return undefined;
	const query = input.query ?? "";
	await delay(600, undefined, { signal });
	await clickSearchControl(session, await session.call<Point>("search.filters.open", { query, token: randomUUID() }));
	await delay(150, undefined, { signal });
	const state = async () => {
		for (let attempt = 0; ; attempt++) {
			try {
				return await session.call<{ selected: number[]; marker: string }>("search.filters.state", { query });
			} catch (error) {
				if (!(error instanceof CliError) || error.message !== "Search filter options changed" || attempt >= 2)
					throw error;
				await clickSearchControl(
					session,
					await session.call<Point>("search.filters.open", { query, token: randomUUID() }),
				);
				await delay(250, undefined, { signal });
			}
		}
	};
	for (const filter of requested) {
		const before = await state();
		const point = await session.call<Point>("search.filters.select", {
			query,
			group: filter.group,
			choice: filter.choice,
			token: randomUUID(),
		});
		await clickSearchControl(session, point);
		const deadline = Date.now() + 3000;
		while (true) {
			await delay(150, undefined, { signal });
			const after = await state();
			if (after.marker !== before.marker) throw new CliError("identity_mismatch", "Search filter marker changed");
			if (after.selected.some((value, index) => index !== filter.group && value !== before.selected[index]))
				throw new CliError("identity_mismatch", "Another search filter changed");
			if (after.selected[filter.group] === filter.choice) break;
			if (Date.now() >= deadline)
				throw new CliError("selector_changed", "Search filter selection could not be verified");
		}
	}
	const final = await state();
	if (requested.some((filter) => final.selected[filter.group] !== filter.choice))
		throw new CliError("identity_mismatch", "A requested search filter was reset");
	return {
		selected: Object.fromEntries(requested.map(({ name, value }) => [name, value])),
		results_verified: false,
		baseline: final.selected,
		marker: final.marker,
	};
}

export async function verifySearchFilters(
	session: Session,
	input: Input,
	signal: AbortSignal,
	baseline?: number[],
	marker?: string,
) {
	const query = input.query ?? "";
	await clickSearchControl(session, await session.call<Point>("search.filters.open", { query, token: randomUUID() }));
	await delay(150, undefined, { signal });
	const state = await session.call<{ selected: number[]; marker: string }>("search.filters.state", { query });
	if (
		(baseline && state.selected.some((value, index) => value !== baseline[index])) ||
		(marker && state.marker !== marker)
	)
		throw new CliError("identity_mismatch", "Search filter state changed");
	if (
		(input.sort && state.selected[0] !== ["relevance", "newest", "likes"].indexOf(input.sort)) ||
		(input.published && state.selected[1] !== ["any", "day", "week", "half-year"].indexOf(input.published))
	)
		throw new CliError("identity_mismatch", "A requested search filter was reset");
}

export async function waitSnapshot(
	session: Session,
	ready: (snapshot: Snapshot) => boolean,
	signal: AbortSignal,
	timeout = 12000,
): Promise<Snapshot> {
	const deadline = Date.now() + timeout;
	while (true) {
		let state: Snapshot;
		try {
			state = await session.status();
		} catch (error) {
			// A work can redirect from /video/ to /note/ while the page adapter
			// is being evaluated. Retry only this transient navigation failure.
			if (!(error instanceof Error) || !/Execution context was destroyed/.test(error.message) || Date.now() >= deadline)
				throw error;
			await delay(150, undefined, { signal });
			continue;
		}
		if (state.verification_required)
			throw new CliError("verification_required", "Human verification is required", {
				hint: "Complete verification in headed Chrome.",
			});
		if (state.login_required)
			throw new CliError("login_required", "Douyin requires login", { hint: "Run auth login." });
		if (ready(state)) return state;
		if (Date.now() >= deadline)
			throw new CliError("selector_changed", "The page did not reach the expected state", { details: state });
		await delay(150, undefined, { signal });
	}
}

// Clicking a page control is only safe after the page confirms the target it owns.
export async function control(session: Session, name: string, args: object = {}): Promise<void> {
	await session.click(await session.call<Point>("prepare-control", { ...args, control: name, token: randomUUID() }));
}

export async function selectChat(session: Session, id: string, signal: AbortSignal): Promise<void> {
	// The conversation may already be the open one; reading it is enough then,
	// and re-clicking would need the list that its own detail view covers.
	const open = async () => {
		try {
			await session.call("chat.read", { conversation_id: id });
			return true;
		} catch (error) {
			if (error instanceof CliError && ["identity_mismatch", "selector_changed"].includes(error.code)) return false;
			throw error;
		}
	};
	if (await open()) return;
	await control(session, "chat.open");
	await delay(150, undefined, { signal });
	// The detail view can cover the list. Its back control restores the list
	// without closing and reopening the entire messaging panel.
	try {
		await session.click(
			await session.call<Point>("chat.select", {
				conversation_id: id,
				token: randomUUID(),
			}),
		);
	} catch (error) {
		if (!(error instanceof CliError) || error.code !== "selector_changed") throw error;
		await control(session, "chat.back");
		await delay(250, undefined, { signal });
		await session.click(
			await session.call<Point>("chat.select", {
				conversation_id: id,
				token: randomUUID(),
			}),
		);
	}
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		if (await open()) return;
		await delay(100, undefined, { signal });
	}
	throw new CliError("identity_mismatch", "The requested conversation did not become the open one");
}

// The share entry is hover-revealed: hovering the icon opens the panel, and a
// click is only a fallback. Rows are polled because the panel fills in
// asynchronously, so a slow panel must not be read as an empty one.
export async function openSharePanel(session: Session): Promise<void> {
	const target = await session.call<{ x: number; y: number }>("forward.open");
	await session.tab.mouse.move(target.x, target.y);
	for (let phase = 0; phase < 2; phase++) {
		for (let attempt = 0; attempt < 12; attempt++) {
			const state = await session.call<{ recipients: unknown[] }>("forward.list");
			if (state.recipients.length > 0) return;
			await delay(150);
		}
		if (phase === 0) await session.click({ x: target.x, y: target.y });
	}
	throw new CliError("selector_changed", "The share panel did not open or has no recipients", {
		hint: "Open the work in headed Chrome and check that the share control is available.",
	});
}

// Reading the panel's recipients is a navigation step, not a write: the panel
// is opened and the rows are reported as they are rendered.
export async function listForwardRecipients(session: Session, signal: AbortSignal): Promise<unknown> {
	await openSharePanel(session);
	signal.throwIfAborted();
	const state = await session.call<{ recipients: unknown[] }>("forward.list");
	return { recipients: state.recipients, scope: "loaded_dom", complete: false };
}

// The panel keeps more recipients than fit on screen. Its name filter did not
// reduce the rendered rows on the live page, so scrolling is what actually
// reaches a recipient that is out of view.
export async function scrollSharePanel(session: Session, pixels: number): Promise<void> {
	await session.call("forward.scroll", { pixels });
	await delay(250);
}

// Lists always describe the loaded DOM; they never claim a complete dataset.
// `key` names the stable identifier the rows carry: ids for works and comments,
// sec_uid for user results.
export async function listResults(
	session: Session,
	operation: string,
	input: Input,
	signal: AbortSignal,
	key = "id",
	filters?: { baseline: number[]; marker: string },
): Promise<unknown> {
	const items: Record<string, unknown>[] = [];
	const seen = new Set<string>();
	for (let scroll = 0; scroll <= (input.scrolls ?? 0); scroll++) {
		await delay(250, undefined, { signal });
		if (operation === "search.results" || operation === "search.users")
			await checkSearchIdentity(session, input.query ?? "", operation);
		if (filters) await verifySearchFilters(session, input, signal, filters.baseline, filters.marker);
		const rows = await session.call<Record<string, unknown>[]>(operation, input);
		if (operation === "search.results" || operation === "search.users")
			await checkSearchIdentity(session, input.query ?? "", operation);
		if (filters) await verifySearchFilters(session, input, signal, filters.baseline, filters.marker);
		for (const row of rows) {
			const id = row[key];
			if (typeof id !== "string" || seen.has(id)) continue;
			seen.add(id);
			items.push(row);
			if (items.length >= (input.limit ?? 20)) return { items, complete: false, scope: "loaded_dom", scrolls: scroll };
		}
		if (scroll < (input.scrolls ?? 0))
			await session.call("scroll", {
				target: operation === "comment.list" ? "comments" : "page",
				video_id: input.video_id,
				pixels: 900,
			});
	}
	return { items, complete: false, scope: "loaded_dom", scrolls: input.scrolls ?? 0 };
}

// The chat panel is an overlay, not a different page: it covers part of the work
// and the page reports the work as blocked, but nothing behind it changed. A read
// can close it and carry on; a caller should not have to know that order.
// Closing is refused while the composer holds a draft, and that refusal is the
// point — an unsent message is not something a read may discard.
export async function closeChatIfOpen(session: Session, signal: AbortSignal): Promise<void> {
	const state = await session.status();
	if (!state.private_chat_visible) return;
	try {
		await control(session, "chat.close");
		await waitSnapshot(session, (next) => !next.private_chat_visible, signal, 5000);
	} catch (error) {
		const problem = error instanceof CliError ? error : null;
		throw new CliError("identity_mismatch", "The private chat panel is open and could not be closed", {
			hint: "Close it with dy chat close. If it holds a draft, clear or send it first.",
			details: problem ? { close_error: problem.code } : undefined,
			cause: error,
		});
	}
}

// Between two slides the feed briefly has no work, and a live slide has none by
// design. A read that arrives in that gap fails on a page that is about to be
// fine, so it waits for the transition to land. A live slide is not waited out:
// it is a real stop, and the caller has to decide to move past it.
export async function settleOnWork(session: Session, signal: AbortSignal): Promise<void> {
	const settled = (state: Snapshot) =>
		state.private_chat_visible || state.login_required || state.verification_required || state.slide.kind !== "page";
	try {
		await waitSnapshot(session, settled, signal, 2500);
	} catch {
		// Still between slides after the window. The command that follows reports
		// the real state; guessing further here would only delay the same answer.
	}
}
