import { randomUUID } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Event, Store } from "../store.ts";

// Outward social actions split into proposing and doing. A proposal costs
// nothing and is visible; doing it reaches a real person. Keeping those apart is
// what lets an owner grant a range once and still be able to answer, later, what
// was done under it and what was held back.

// Risk is a property of the action, not something the caller declares: a caller
// that could label a public post "low" could grant itself the right to post.
const RISK = {
	"video.like": "low",
	"video.favorite": "low",
	"user.follow": "medium",
	"comment.post": "high",
	"comment.reply": "high",
	"chat.send": "high",
	"chat.reply": "high",
	"chat.share": "high",
	"chat.forward": "high",
	"chat.image": "high",
} as const;

export type ActionKind = keyof typeof RISK;

export interface Proposal {
	id: string;
	kind: ActionKind;
	target: string;
	draft: string;
	reason: string;
	risk: string;
	status: "proposed" | "approved" | "rejected" | "executed" | "failed" | "expired" | "canceled";
	created_at: string;
	expires_at: string;
	grant_id?: string;
	receipt_id?: string;
	error?: string;
}

export interface Grant {
	id: string;
	kinds: ActionKind[];
	per_day: number;
	expires_at: string;
	revoked_at?: string;
	created_at: string;
}

function record(event: Event): Record<string, unknown> {
	const data = event.data;
	return data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
}

// Every state is derived from the log rather than stored separately: the log is
// already the project's single source of truth for what happened, and a second
// copy of a queue could disagree with it.
export function derive(events: Event[]) {
	const proposals = new Map<string, Proposal>();
	const grants = new Map<string, Grant>();
	for (const event of events) {
		const data = record(event);
		if (event.operation === "action.proposed") {
			const id = typeof data.id === "string" ? data.id : null;
			const kind = typeof data.kind === "string" && data.kind in RISK ? (data.kind as ActionKind) : null;
			if (!id || !kind) continue;
			proposals.set(id, {
				id,
				kind,
				target: typeof data.target === "string" ? data.target : "",
				draft: typeof data.draft === "string" ? data.draft : "",
				reason: typeof data.reason === "string" ? data.reason : "",
				risk: RISK[kind],
				status: "proposed",
				created_at: event.at,
				expires_at: typeof data.expires_at === "string" ? data.expires_at : event.at,
			});
			continue;
		}
		if (event.operation === "action.granted") {
			const id = typeof data.id === "string" ? data.id : null;
			if (!id) continue;
			grants.set(id, {
				id,
				kinds: Array.isArray(data.kinds)
					? (data.kinds.filter((kind) => typeof kind === "string" && kind in RISK) as ActionKind[])
					: [],
				per_day: typeof data.per_day === "number" ? data.per_day : 0,
				expires_at: typeof data.expires_at === "string" ? data.expires_at : event.at,
				created_at: event.at,
			});
			continue;
		}
		const id = typeof data.proposal_id === "string" ? data.proposal_id : null;
		if (!id) continue;
		const proposal = proposals.get(id);
		if (!proposal) continue;
		if (event.operation === "action.grant.revoked") {
			const grant = grants.get(typeof data.grant_id === "string" ? data.grant_id : "");
			if (grant) grant.revoked_at = event.at;
			continue;
		}
		if (event.operation === "action.approved") {
			proposal.status = "approved";
			if (typeof data.grant_id === "string") proposal.grant_id = data.grant_id;
		} else if (event.operation === "action.rejected") proposal.status = "rejected";
		else if (event.operation === "action.canceled") proposal.status = "canceled";
		else if (event.operation === "action.executed") {
			proposal.status = "executed";
			if (typeof data.receipt_id === "string") proposal.receipt_id = data.receipt_id;
		} else if (event.operation === "action.failed") {
			proposal.status = "failed";
			if (typeof data.error === "string") proposal.error = data.error;
		}
	}
	const now = Date.now();
	for (const proposal of proposals.values())
		if (proposal.status === "proposed" && Date.parse(proposal.expires_at) < now) proposal.status = "expired";
	return { proposals: [...proposals.values()], grants: [...grants.values()] };
}

// The grant a proposal may run under, or null when nothing covers it. Being
// inside a grant means the owner already said yes to this class of action in
// this window; it is not a licence to exceed the budget or the expiry.
export function coveringGrant(
	grants: Grant[],
	proposals: Proposal[],
	proposal: Proposal,
	now = Date.now(),
): Grant | null {
	for (const grant of grants) {
		if (grant.revoked_at) continue;
		if (Date.parse(grant.expires_at) < now) continue;
		if (!grant.kinds.includes(proposal.kind)) continue;
		const used = proposals.filter(
			(entry) =>
				entry.status === "executed" && entry.grant_id === grant.id && Date.parse(entry.created_at) >= startOfDay(now),
		).length;
		if (used >= grant.per_day) continue;
		return grant;
	}
	return null;
}

function startOfDay(now: number): number {
	const date = new Date(now);
	date.setHours(0, 0, 0, 0);
	return date.getTime();
}

export async function propose(
	store: Store,
	input: { kind?: string; target?: string; draft?: string; reason?: string; ttl_hours?: number },
) {
	const kind = input.kind ?? "";
	if (!(kind in RISK))
		throw new CliError("invalid_argument", "Unknown action kind", { details: { accepted: Object.keys(RISK) } });
	if (!input.target?.trim()) throw new CliError("invalid_argument", "A proposal needs a stable target ID");
	const hours = input.ttl_hours ?? 24;
	if (!Number.isFinite(hours) || hours < 1 || hours > 168)
		throw new CliError("invalid_argument", "--ttl-hours must be 1..168");
	const { proposals } = derive(await store.events());
	// The same intent proposed twice is one proposal. The draft is part of the
	// identity: the same post with different words is a different thing to review.
	const duplicate = proposals.find(
		(entry) =>
			entry.status === "proposed" &&
			entry.kind === kind &&
			entry.target === input.target &&
			entry.draft === (input.draft ?? ""),
	);
	if (duplicate) return { ...duplicate, duplicate: true };
	const id = randomUUID();
	const expires_at = new Date(Date.now() + hours * 3600_000).toISOString();
	await store.append("action.proposed", {
		id,
		kind,
		target: input.target,
		draft: input.draft ?? "",
		reason: input.reason ?? "",
		expires_at,
		risk: RISK[kind as ActionKind],
	});
	return {
		id,
		kind,
		target: input.target,
		draft: input.draft ?? "",
		reason: input.reason ?? "",
		risk: RISK[kind as ActionKind],
		status: "proposed",
		expires_at,
	};
}

export async function grant(store: Store, input: { kinds?: string; per_day?: number; ttl_hours?: number }) {
	const kinds = (input.kinds ?? "")
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	if (!kinds.length) throw new CliError("invalid_argument", "List the action kinds this grant covers");
	for (const kind of kinds) if (!(kind in RISK)) throw new CliError("invalid_argument", `Unknown action kind: ${kind}`);
	const per_day = input.per_day ?? 5;
	if (!Number.isInteger(per_day) || per_day < 1 || per_day > 200)
		throw new CliError("invalid_argument", "--per-day must be 1..200");
	const hours = input.ttl_hours ?? 24;
	if (!Number.isFinite(hours) || hours < 1 || hours > 720)
		throw new CliError("invalid_argument", "--ttl-hours must be 1..720");
	const id = randomUUID();
	const expires_at = new Date(Date.now() + hours * 3600_000).toISOString();
	await store.append("action.granted", { id, kinds, per_day, expires_at });
	return { id, kinds, per_day, expires_at, revoked_at: null };
}

export async function revokeGrant(store: Store, grantId: string) {
	const { grants } = derive(await store.events());
	const existing = grants.find((entry) => entry.id === grantId);
	if (!existing) throw new CliError("not_found", "Grant not found");
	if (existing.revoked_at) return { ...existing, already_revoked: true };
	await store.append("action.grant.revoked", { grant_id: grantId });
	return { ...existing, revoked_at: new Date().toISOString() };
}
