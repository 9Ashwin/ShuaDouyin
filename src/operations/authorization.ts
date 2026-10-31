import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";

// Standing permission for one person, and only that person.
//
// The skill says permission is per round and must not be written into a
// configuration file. That rule exists because "yes, reply to anyone" turns a
// revocable decision into a permanent one. It does not conflict with remembering
// "this person may be written to": the difference is the target. A grant names
// one conversation or one account and one kind of action, has an expiry, and can
// be revoked. It never means "all replies are approved".
//
// What it does not do: it does not decide whether a message is worth sending,
// and it does not survive as a default for anyone else.

export type GrantedAction = "reply" | "comment" | "follow" | "like";

const ACTIONS: GrantedAction[] = ["reply", "comment", "follow", "like"];

export interface Grant {
	/** `user:<sec_uid>` or `conversation:<id>` — the exact target. */
	target: string;
	actions: GrantedAction[];
	/** Days from granted_at. Zero means it does not expire on its own. */
	days: number;
	granted_at: string;
	expires_at: string | null;
	reason: string;
	revoked_at: string | null;
}

const TARGET = /^(?:user|conversation):[A-Za-z0-9_:.-]{1,300}$/;

function record(event: Event): Record<string, unknown> {
	const data = event.data;
	return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

/**
 * Every grant the log records, in order, with revocations applied.
 *
 * A revocation does not delete the grant: what it covered happened, and a later
 * reader needs to know both that it existed and that it stopped.
 */
export function grants(events: Event[]): (Grant & { id: string; active: boolean })[] {
	const byID = new Map<string, Grant & { id: string }>();
	const revoked = new Set<string>();
	for (const event of events) {
		const data = record(event);
		if (event.operation === "auth.granted") {
			const id = typeof data.grant_id === "string" ? data.grant_id : null;
			const target = typeof data.target === "string" ? data.target : "";
			const actions = Array.isArray(data.actions)
				? (data.actions.filter((entry) => ACTIONS.includes(entry as GrantedAction)) as GrantedAction[])
				: [];
			if (!id || !TARGET.test(target) || !actions.length) continue;
			const days = typeof data.days === "number" ? data.days : 0;
			byID.set(id, {
				id,
				target,
				actions,
				days,
				granted_at: event.at,
				expires_at:
					typeof data.expires_at === "string"
						? data.expires_at
						: days > 0
							? new Date(Date.parse(event.at) + days * 86_400_000).toISOString()
							: null,
				reason: typeof data.reason === "string" ? data.reason : "",
				revoked_at: null,
			});
		} else if (event.operation === "auth.revoked") {
			const id = typeof data.grant_id === "string" ? data.grant_id : null;
			if (id) revoked.add(id);
		}
	}
	const now = Date.now();
	return [...byID.values()].map((grant) => ({
		...grant,
		revoked_at: revoked.has(grant.id) ? (grant.revoked_at ?? "revoked") : grant.revoked_at,
		active: !revoked.has(grant.id) && !(grant.expires_at && Date.parse(grant.expires_at) < now),
	}));
}

/**
 * Whether a person or conversation may be acted on without asking again.
 *
 * The target has to match exactly. A grant for one person does not extend to a
 * group they are in, and a grant for a group does not extend to its members:
 * both of those are different audiences, and treating them as the same is how a
 * message reaches someone who was never approved.
 */
export function covers(events: Event[], target: string, action: GrantedAction, now = Date.now()): Grant | null {
	for (const grant of grants(events)) {
		if (!grant.active) continue;
		if (grant.target !== target) continue;
		if (!grant.actions.includes(action)) continue;
		if (grant.expires_at && Date.parse(grant.expires_at) < now) continue;
		return grant;
	}
	return null;
}

export function parseTarget(raw: string): string {
	const value = raw.trim();
	if (!TARGET.test(value))
		throw new CliError("invalid_argument", "Use a stable target: user:<sec_uid> or conversation:<id>", {
			hint: "A display name is not a target; it can be changed or shared.",
		});
	return value;
}

export function parseActions(raw: string | undefined): GrantedAction[] {
	const list = (raw ?? "")
		.split(",")
		.map((entry) => entry.trim())
		.filter(Boolean);
	if (!list.length) throw new CliError("invalid_argument", `Name what is permitted: ${ACTIONS.join(", ")}`);
	const unknown = list.filter((entry) => !ACTIONS.includes(entry as GrantedAction));
	if (unknown.length)
		throw new CliError("invalid_argument", `Unknown action(s): ${unknown.join(", ")}`, {
			hint: `Accepted: ${ACTIONS.join(", ")}`,
		});
	return [...new Set(list)] as GrantedAction[];
}

export async function grantAccess(
	store: Store,
	input: { target?: string; actions?: string; days?: number; reason?: string },
): Promise<unknown> {
	const target = parseTarget(input.target ?? "");
	const actions = parseActions(input.actions);
	const days = input.days ?? 7;
	if (!Number.isInteger(days) || days < 0 || days > 365)
		throw new CliError("invalid_argument", "--days must be an integer from 0 to 365", {
			hint: "0 means it does not expire; anything else is taken as a decision with a review date.",
		});
	const reason = (input.reason ?? "").trim();
	// A standing permission with no stated reason cannot be reviewed later: the
	// next reader sees an approval and has nothing to weigh it against.
	if (!reason) throw new CliError("invalid_argument", "Say why with --reason");
	const existing = grants(await store.events()).find(
		(grant) => grant.active && grant.target === target && actions.every((action) => grant.actions.includes(action)),
	);
	// Granting the same thing twice is not an error, but reporting the one that
	// already covers it is more useful than adding a second identical record.
	if (existing) return { ...existing, duplicate: true };
	const id = crypto.randomUUID();
	const at = new Date().toISOString();
	const expires_at = days > 0 ? new Date(Date.now() + days * 86_400_000).toISOString() : null;
	await store.append("auth.granted", { grant_id: id, target, actions, days, expires_at, reason });
	return { id, target, actions, days, granted_at: at, expires_at, reason, active: true };
}

export async function revokeAccess(store: Store, id: string): Promise<unknown> {
	const found = grants(await store.events()).find((grant) => grant.id === id);
	if (!found) throw new CliError("not_found", "No standing permission with that ID");
	if (!found.active) return { ...found, already_inactive: true };
	await store.append("auth.revoked", { grant_id: id });
	return { ...found, active: false };
}
