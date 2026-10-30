import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { readChat } from "./chat.ts";

// Whether anything came back.
//
// The social loop had every step and no feedback: candidates were found, messages
// were sent, and whether anyone answered was left to the caller to notice. This is
// the one part of that loop that is a fact rather than a judgement — either an
// incoming message follows an outgoing one or it does not — so it is the part the
// tool can answer on its own.
//
// It stops at the observation. Whether an answer means the relationship moved is
// not something message timing can decide, and the stage command already refuses
// to assume it.

export interface Message {
	id?: string;
	direction?: string;
	kind?: string;
	text?: string;
	timestamp?: string;
	pending?: boolean;
	failed?: boolean;
}

export interface ResponseWindow {
	// How many of this account's messages are followed by an incoming one.
	answered: number;
	// Messages with nothing incoming after them, newest first.
	unanswered: { id: string | null; kind: string; at: string; hours_waiting: number | null }[];
	// The median hours between an outgoing message and the next incoming one, over
	// the pairs that have one. Null when no pair exists.
	median_reply_hours: number | null;
	// When the conversation last had anything from the other side.
	last_incoming_at: string | null;
	// When this account last sent anything.
	last_outgoing_at: string | null;
	// True when every loaded message went out and none came in. This is the state
	// that matters for "should I keep trying", and it is not the same as a
	// conversation that is merely quiet today.
	only_outgoing: boolean;
	// What this does not say, in the words a caller can act on.
	limits: string;
}

const HOUR = 3_600_000;

function hoursBetween(later: string, earlier: string): number | null {
	const a = Date.parse(earlier);
	const b = Date.parse(later);
	if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return null;
	return Math.round(((b - a) / HOUR) * 10) / 10;
}

// Messages arrive newest first from the page reader. Working in time order is what
// makes "the next incoming after this outgoing" answerable at all.
export function responseWindow(messages: Message[], now = Date.now()): ResponseWindow {
	const usable = messages
		.filter((message) => !message.pending && !message.failed && typeof message.timestamp === "string")
		.sort((left, right) => Date.parse(left.timestamp ?? "") - Date.parse(right.timestamp ?? ""));
	if (!usable.length)
		return {
			answered: 0,
			unanswered: [],
			median_reply_hours: null,
			last_incoming_at: null,
			last_outgoing_at: null,
			only_outgoing: false,
			limits: "No messages are loaded, so nothing can be said about whether anything came back.",
		};
	const incoming = usable.filter((message) => message.direction === "incoming");
	const outgoing = usable.filter((message) => message.direction === "outgoing");
	const replies: number[] = [];
	const unanswered: ResponseWindow["unanswered"] = [];
	// Each outgoing message is answered when some incoming message follows it and
	// comes before the next outgoing one. Anything later is a reply to that later
	// message, and counting it as an answer to both would overstate the exchange.
	for (let index = 0; index < usable.length; index++) {
		const message = usable[index];
		if (!message || message.direction !== "outgoing") continue;
		const next = usable.slice(index + 1).find((candidate) => candidate.direction === "outgoing");
		const after = usable
			.slice(index + 1, next ? usable.indexOf(next) : undefined)
			.filter((candidate) => candidate.direction === "incoming");
		const stamp = message.timestamp ?? "";
		if (after.length) {
			const gap = hoursBetween(after[0]?.timestamp ?? "", stamp);
			if (gap !== null) replies.push(gap);
			continue;
		}
		const sent = Date.parse(stamp);
		unanswered.push({
			id: typeof message.id === "string" ? message.id : null,
			kind: typeof message.kind === "string" ? message.kind : "unknown",
			at: stamp,
			hours_waiting: Number.isFinite(sent) ? Math.round(((now - sent) / HOUR) * 10) / 10 : null,
		});
	}
	replies.sort((left, right) => left - right);
	const median = replies.length ? (replies[Math.floor((replies.length - 1) / 2)] ?? null) : null;
	const newest = outgoing.at(-1)?.timestamp ?? null;
	return {
		answered: replies.length,
		// Newest first reads better than send order for "what is still hanging".
		unanswered: unanswered.reverse(),
		median_reply_hours: median,
		last_incoming_at: incoming.at(-1)?.timestamp ?? null,
		last_outgoing_at: newest,
		only_outgoing: outgoing.length > 0 && incoming.length === 0,
		limits: [
			"This counts direction and time in the loaded window, nothing more.",
			"A message that arrived while the window was not open is not here, so 'unanswered' means 'nothing loaded after it', not 'nobody ever replied'.",
			"It does not read what the reply said, and it does not decide whether the relationship moved.",
		].join(" "),
	};
}

// Read one conversation and say what came back. Separate from the pure function so
// the arithmetic can be tested without a page.
export async function observeResponse(
	session: Session,
	conversationID: string,
	options: { limit?: number; signal?: AbortSignal } = {},
): Promise<ResponseWindow & { conversation_id: string }> {
	if (!conversationID) throw new CliError("invalid_argument", "--conversation-id is required");
	// The conversation is selected first. Calling the page's chat.read directly
	// skipped that step and read whichever conversation happened to be open, then
	// failed as an identity mismatch — which looked like a wrong id rather than a
	// missing click.
	const read = (await readChat(
		session,
		{ conversation_id: conversationID, limit: Math.min(Math.max(options.limit ?? 30, 1), 50) },
		options.signal ?? AbortSignal.timeout(45_000),
	)) as {
		messages?: Message[];
	};
	const window = responseWindow(read.messages ?? []);
	options.signal?.throwIfAborted();
	return { conversation_id: conversationID, ...window };
}
