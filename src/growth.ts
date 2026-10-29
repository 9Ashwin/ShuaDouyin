import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError, isMissing } from "./errors.ts";
import { atomicWrite, type Event, Store } from "./store.ts";
import type { Workspaces } from "./workspace.ts";

interface Checkpoint {
	account: string;
	event_id: string;
}

export class Growth {
	readonly workspaces: Workspaces;
	constructor(workspaces: Workspaces) {
		this.workspaces = workspaces;
	}

	private async checkpoints(): Promise<Checkpoint[]> {
		const path = join(this.workspaces.root(), "growth.json");
		try {
			const info = await lstat(path);
			if (!info.isFile() || info.isSymbolicLink() || info.size > 65536)
				throw new CliError("state_corrupt", "Invalid growth checkpoint file");
			const state: unknown = JSON.parse(await readFile(path, "utf8"));
			if (!state || typeof state !== "object" || !("checkpoints" in state) || !Array.isArray(state.checkpoints))
				throw new CliError("state_corrupt", "Invalid growth checkpoints");
			const checkpoints: Checkpoint[] = [];
			for (const item of state.checkpoints) {
				if (
					!item ||
					typeof item !== "object" ||
					typeof item.account !== "string" ||
					typeof item.event_id !== "string" ||
					checkpoints.some((entry) => entry.account === item.account)
				)
					throw new CliError("state_corrupt", "Invalid growth checkpoint");
				checkpoints.push({ account: item.account, event_id: item.event_id });
			}
			return checkpoints;
		} catch (error) {
			if (isMissing(error)) return [];
			if (error instanceof SyntaxError)
				throw new CliError("state_corrupt", "Invalid growth checkpoints", { cause: error });
			throw error;
		}
	}

	private async events(store: Store): Promise<Event[]> {
		return (await store.events()).filter((event) => event.bot_id === store.bot_id);
	}

	async review(since: string | undefined, limit: number) {
		const store = new Store(this.workspaces.base);
		const account = store.profile;
		const events = await this.events(store);
		const checkpoints = await this.checkpoints();
		const checkpoint = checkpoints.find((entry) => entry.account === account)?.event_id;
		let start = 0;
		if (checkpoint) {
			const position = events.findIndex((event) => event.id === checkpoint);
			if (position < 0)
				throw new CliError("state_corrupt", "Growth checkpoint is missing from this bot's activity history");
			start = position + 1;
		}
		const pending = since ? events.filter((event) => event.at >= new Date(since).toISOString()) : events.slice(start);
		const items = pending.slice(0, limit).map((event) => ({ ...event, source: `event:${account}:${event.id}` }));
		// The same events, grouped by the browsing round they belong to. The flat
		// list stays exactly as it was: a checkpoint still advances one event at a
		// time, and grouping must never become a way to acknowledge several at once.
		const grouped = groupByRound(pending.slice(0, limit), account);
		// Receipts are durable before dispatch and may exist without a history
		// event. Keep them separate from the ordered event checkpoint.
		const shareReceipts = Object.values(await store.receipts())
			.filter(
				(receipt) =>
					receipt.bot_id === store.bot_id &&
					["chat.share", "chat.forward"].includes(receipt.operation) &&
					["dispatching", "confirmed"].includes(receipt.status) &&
					(!since || receipt.created_at >= new Date(since).toISOString()),
			)
			.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
			.slice(0, limit)
			.map((receipt) => ({ ...receipt, source: `receipt:${account}:${receipt.request_id}` }));
		return {
			bot: { id: store.bot_id, account },
			account,
			// One installation has exactly one account, so the pending count always
			// describes the same history that was just read. The array is kept so
			// callers that read it still see the same shape.
			accounts: [{ account, pending: events.length - start }],
			onboarding: await this.workspaces.onboarding(),
			checkpoint: checkpoint ?? null,
			events: items,
			rounds: grouped,
			share_receipts: shareReceipts,
			total: pending.length,
			truncated: items.length < pending.length,
			workflow: [
				"Review owner setup, persona, profiles and existing relevant memories.",
				"Interpret the activity yourself; distinguish visible metadata from media actually inspected.",
				"Search first, then add or revise durable memories using the returned event:<account>:<id> sources.",
				"Review share receipts separately; dispatching is uncertain and does not establish delivery. Receipts do not advance event checkpoints.",
				"Keep owner statements separate from tentative impressions; update persona and profiles with revision checks when justified.",
				// The persona is not only what the agent decides to write: the voice
				// section is measured from this account's own comments and is meant to
				// keep moving. Running it here is what makes that automatic instead of
				// something a caller has to remember.
				"Run persona evolve after a round that included commenting. It rewrites one section of AGENTS.md from what this account actually wrote, and refuses until there are enough comments to describe a voice.",
				"Save a caller-authored report when requested; acknowledge each pending event in order only after saving relevant outcomes.",
			],
		};
	}

	async acknowledge(eventID: string) {
		return this.workspaces.lock(async () => {
			const store = new Store(this.workspaces.base);
			const account = store.profile;
			const events = await this.events(store);
			const position = events.findIndex((event) => event.id === eventID);
			if (position < 0) throw new CliError("not_found", "Activity event is not attributed to this bot and account");
			const checkpoints = await this.checkpoints();
			const current = checkpoints.find((entry) => entry.account === account);
			if (current) {
				const previous = events.findIndex((event) => event.id === current.event_id);
				if (previous < 0)
					throw new CliError("state_corrupt", "Growth checkpoint is missing from this bot's activity history");
				if (position < previous) throw new CliError("revision_conflict", "Cannot move a growth checkpoint backwards");
				if (position > previous + 1) throw new CliError("revision_conflict", "Acknowledge pending events in order");
				current.event_id = eventID;
			} else {
				if (position !== 0) throw new CliError("revision_conflict", "Acknowledge pending events in order");
				checkpoints.push({ account, event_id: eventID });
			}
			await atomicWrite(join(this.workspaces.root(), "growth.json"), `${JSON.stringify({ checkpoints }, null, 2)}\n`);
			return { bot: store.bot_id, account, event_id: eventID };
		});
	}

	async event(eventID: string) {
		const store = new Store(this.workspaces.base);
		const account = store.profile;
		const event = (await this.events(store)).find((item) => item.id === eventID);
		if (!event) throw new CliError("not_found", "Activity event is not attributed to this bot and account");
		return { ...event, account, source: `event:${account}:${event.id}` };
	}
}

interface RoundView {
	round_id: string;
	status: "open" | "closed";
	started_at: string;
	ended_at: string | null;
	goal: string | null;
	watched: number;
	skipped: number;
	interacted: number;
	events: { id: string; at: string; operation: string; source: string }[];
	status_note?: string;
}

// Grouping is a view over the same ordered events, not a second ordering. Every
// event still carries its own source, so a caller cannot use a round to skip the
// per-event checkpoint the rest of this command is built on.
function groupByRound(events: Event[], account: string): RoundView[] {
	const byRound = new Map<string, RoundView>();
	// Which round saw which work, so an interaction can be attributed by the work
	// it names rather than by a field it does not carry.
	const seenIn = new Map<string, string>();
	const loose: RoundView | null = null;
	void loose;
	const ensure = (id: string) => {
		const existing = byRound.get(id);
		if (existing) return existing;
		const created: RoundView = {
			round_id: id,
			status: "open",
			started_at: "",
			ended_at: null,
			goal: null,
			watched: 0,
			skipped: 0,
			interacted: 0,
			events: [],
		};
		byRound.set(id, created);
		return created;
	};
	for (const event of events) {
		const data = event.data && typeof event.data === "object" ? (event.data as Record<string, unknown>) : {};
		if (event.operation === "browse.start" && typeof data.id === "string") {
			const round = ensure(data.id);
			round.started_at = event.at;
			round.goal = typeof data.goal === "string" ? data.goal : null;
			round.events.push({
				id: event.id,
				at: event.at,
				operation: event.operation,
				source: `event:${account}:${event.id}`,
			});
			continue;
		}
		const INTERACTIONS = [
			"video.like",
			"video.favorite",
			"comment.post",
			"comment.reply",
			"chat.share",
			"chat.forward",
		];
		const roundID =
			typeof data.round === "string"
				? data.round
				: typeof data.id === "string" && event.operation.startsWith("browse.")
					? data.id
					: null;
		if (!roundID) {
			// An interaction does not name the round it happened in — it names the
			// work. It belongs to the round that saw that work, which is why this is
			// resolved before the round-id check that would otherwise drop it.
			const work = typeof data.video_id === "string" ? data.video_id : null;
			if (work && INTERACTIONS.includes(event.operation)) {
				const owner = byRound.get(seenIn.get(work) ?? "");
				if (owner) {
					owner.interacted += 1;
					owner.events.push({
						id: event.id,
						at: event.at,
						operation: event.operation,
						source: `event:${account}:${event.id}`,
					});
				}
			}
			continue;
		}
		const round = ensure(roundID);
		round.events.push({
			id: event.id,
			at: event.at,
			operation: event.operation,
			source: `event:${account}:${event.id}`,
		});
		if (event.operation === "browse.end") {
			round.status = "closed";
			round.ended_at = event.at;
		} else if (event.operation === "browse.watch") {
			round.watched += 1;
			const work = typeof data.id === "string" ? data.id : null;
			if (work) seenIn.set(work, roundID);
		} else if (event.operation === "browse.skip") round.skipped += 1;
	}
	// A round whose close fell outside the returned window is reported as open,
	// because the close really is not in these events. Saying so avoids the round
	// looking unfinished when it is simply beyond the window.
	return [...byRound.values()]
		.sort((a, b) => a.started_at.localeCompare(b.started_at))
		.map((round) => ({
			...round,
			status_note:
				round.status === "open" ? "No browse.end is in this window; the round may have closed outside it." : undefined,
		}));
}
