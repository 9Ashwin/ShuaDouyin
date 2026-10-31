import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { navigate } from "./navigation.ts";
import type { Input } from "./validate.ts";

// What this account has saved, read from its own collection tab.
//
// Writing a favorite already existed; reading the list did not, so a caller could
// add to a collection it had no way to look at. The tab is the only place the
// list exists — there is no endpoint this tool can ask.
//
// Two things about that page matter. The tab is an icon plus a count; the label
// lives in the parent's text, and the `user-favorite-tab` marker is 0x0 unless
// the tab is already selected, so a reader that trusts the marker clicks nothing.
// And the grid arrives after the click, so reading immediately returns whatever
// list was there before — which looks like a successful read of the wrong tab.

interface Work {
	id: string;
	url: string;
	title: string;
}

export interface Favorites {
	tab: string;
	works: Work[];
	/** Whether every work on the tab was read, or only what had loaded. */
	complete: boolean;
	limits: string[];
}

// The tab labels the profile offers. Reading a different tab is the same code
// path with a different label, so this is not only about favorites.
const TABS = ["收藏", "喜欢", "观看历史", "稍后再看", "我的预约"] as const;

export async function readFavorites(session: Session, input: Input, signal: AbortSignal): Promise<Favorites> {
	const requested = (input.target ?? "收藏").trim();
	if (!TABS.includes(requested as (typeof TABS)[number]))
		throw new CliError("invalid_argument", `Unknown profile tab "${requested}"`, {
			hint: `Accepted: ${TABS.join(", ")}`,
		});
	const limits: string[] = [
		"Screenshots and the private area are not read; this is the work grid as the page renders it.",
		"Only works loaded in the current window are listed. Scroll the page for more.",
		"A work being listed here says it is on this tab, not why the account saved it.",
	];
	await navigate(session, "https://www.douyin.com/user/self", "profile", signal);
	// The tab strip renders with the header, a moment after the route settles. A
	// read taken on the navigation's word found no tabs at all and reported the
	// page as changed.
	const tabDeadline = Date.now() + 6000;
	while (Date.now() < tabDeadline) {
		signal.throwIfAborted();
		try {
			await session.call("profile.tab.point", { target: requested });
			break;
		} catch (error) {
			if (error instanceof CliError && error.code === "selector_changed") {
				await delay(300, undefined, { signal });
				continue;
			}
			throw error;
		}
	}
	const before = await session.call<{ works: Work[] }>("profile.tab.works", {});
	const point = await session.call<{ x: number; y: number }>("profile.tab.point", { target: requested });
	await session.tab.mouse.click(point.x, point.y);
	await delay(400, undefined, { signal });
	// The grid replaces the previous tab's list rather than appending to it, so
	// waiting for the first work to differ is what tells the two apart. Reading
	// before that returns the previous tab and calls it this one.
	const deadline = Date.now() + 6000;
	let works = before.works;
	while (Date.now() < deadline) {
		signal.throwIfAborted();
		await delay(300, undefined, { signal });
		const read = await session.call<{ works: Work[] }>("profile.tab.works", {});
		if (read.works.length && JSON.stringify(read.works) !== JSON.stringify(before.works)) {
			works = read.works;
			break;
		}
		// An empty tab is a real answer: the list is empty rather than still
		// loading. It is taken once the wait has run out, never on the first read.
		works = read.works;
	}
	return {
		tab: requested,
		works,
		// The page does not state a total, so "complete" would be a claim about a
		// number nothing here knows.
		complete: false,
		limits,
	};
}
