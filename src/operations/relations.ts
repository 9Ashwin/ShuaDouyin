import { setTimeout as delay } from "node:timers/promises";
import type { Point, Session } from "../browser.ts";
import { navigate } from "./navigation.ts";
import type { Input } from "./validate.ts";

// Who follows this account and who it follows. This is the entry point for
// meeting people on purpose: a mutual follow is the only relationship the
// platform shows both ways, and it is what a "new friend" actually means here.
export async function userRelations(session: Session, input: Input, signal: AbortSignal) {
	const relation = input.relation === "following" ? "following" : "followers";
	const user = input.user_id ?? "self";
	// `self` has no sec_uid of its own: the site addresses the signed-in account
	// by that literal, and only the profile route accepts it.
	await navigate(session, `https://www.douyin.com/user/${user}`, "profile", signal);
	const target = await session.call<Point & { x?: number; y?: number }>("user.relation.prepare", { relation });
	if (target.x === undefined || target.y === undefined) throw new Error("The relation label has no click point");
	await session.click({ x: target.x, y: target.y });
	// The modal is filled after it opens, so the first read is waited for rather
	// than taken as the answer.
	const collected = new Map<string, { id: string; name: string; follows_back?: boolean }>();
	let open = false;
	// The modal renders after the click and fills asynchronously, so the first
	// reads are waits rather than answers: an empty list right after the press
	// means it has not been drawn yet.
	const openDeadline = Date.now() + 6000;
	while (Date.now() < openDeadline) {
		signal.throwIfAborted();
		await delay(300, undefined, { signal });
		const state = await session.call<{ users: { id: string; name: string; follows_back?: boolean }[]; open: boolean }>(
			"user.relation",
			{},
		);
		if (state.open) {
			open = true;
			for (const entry of state.users) collected.set(entry.id, entry);
			break;
		}
	}
	for (let step = 0; step <= (input.scrolls ?? 0); step++) {
		signal.throwIfAborted();
		await delay(step === 0 ? 400 : 700, undefined, { signal });
		const state = await session.call<{ users: { id: string; name: string; follows_back?: boolean }[]; open: boolean }>(
			"user.relation",
			{},
		);
		open = open || state.open;
		for (const entry of state.users) collected.set(entry.id, entry);
		if (collected.size >= (input.limit ?? 50)) break;
		if (step < (input.scrolls ?? 0)) {
			const moved = await session.call<{ moved: boolean }>("user.relation.scroll", { pixels: 600 });
			if (!moved.moved) break;
		}
	}
	const users = [...collected.values()].slice(0, input.limit ?? 50);
	return {
		user,
		relation,
		users,
		count: users.length,
		complete: false,
		scope: "loaded_modal",
		limitations: [
			"The list is loaded lazily and may stop short of the real total.",
			"A follower is not a mutual follow: the platform shows both lists separately, so compare them to find one.",
		],
	};
}
