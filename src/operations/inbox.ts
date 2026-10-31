import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { Session } from "../browser.ts";
import { control } from "./navigation.ts";
import type { Input } from "./validate.ts";

// What arrived while nobody was looking.
//
// `dy` does not schedule and does not decide what to say, so this command does
// the two things it can do honestly: report which conversations have unread
// messages, and read those conversations so a caller has the content in hand.
// The decision to reply, and the words, stay with the caller.
//
// Two constraints shape the implementation. The conversation list is read
// without opening any conversation, because opening one marks it read and the
// next call would then report nothing — losing the signal being watched for.
// And a message that shares a work is marked as such with its id, because a
// reply to "look at this" that never looked is the failure this is meant to
// prevent.

interface Contact {
	id: string | null;
	name: string;
	type: string;
	unread: boolean;
	unread_count: number | null;
}

interface Message {
	id: string;
	direction: string;
	text: string;
	kind: string;
	timestamp: string | null;
	share?: { video_id?: string | null; title?: string | null };
}

export interface UnreadConversation {
	conversation_id: string;
	name: string;
	type: string;
	unread_count: number | null;
	// Whether the other side spoke last. This survives the badge being cleared,
	// so it is the signal to act on when unread_count is zero or null.
	awaiting_reply: boolean;
	// The messages read from this conversation, oldest first. Only the ones the
	// caller has not been shown before, when a previous inbox run is available.
	messages: {
		id: string;
		direction: string;
		text: string;
		kind: string;
		at: string | null;
		shares_work: string | null;
	}[];
	// Work ids shared in this conversation that have not been read yet. A caller
	// that replies to one of these should read it first.
	shared_works: string[];
	last_message_at: string | null;
}

export async function readInbox(session: Session, input: Input, signal: AbortSignal): Promise<unknown> {
	// The panel has to be open before anything can be listed or selected. A closed
	// panel is a normal state to start from: the previous caller may have closed
	// it, and opening is idempotent.
	await control(session, "chat.open").catch(() => undefined);
	const contacts = (await session.call<Contact[]>("chat.list", { limit: 100 })) ?? [];
	// Unread is one signal, not the only one. The panel clears the badge as soon
	// as a conversation is opened, so a message read by a person — or by an
	// earlier run of this very command — leaves no badge behind while still being
	// unanswered. Those are exactly the ones a caller most needs to see, so every
	// loaded conversation is checked for "the last word was theirs".
	const candidates = contacts.filter((contact) => contact.id);
	const unread = candidates.filter((contact) => contact.unread || (contact.unread_count ?? 0) > 0);
	const other = candidates.filter((contact) => !unread.includes(contact));
	// A conversation with no stable id cannot be opened or replied to, so it is
	// reported separately rather than dropped: silently skipping one is how a
	// message goes unanswered with nothing to show for it.
	const unidentified = contacts.filter((contact) => !contact.id && contact.unread).map((contact) => contact.name);
	const limit = input.limit ?? 10;
	const conversations: UnreadConversation[] = [];
	const awaiting = candidates.length > limit ? [...unread, ...other].slice(0, limit) : [...unread, ...other];
	for (const contact of awaiting) {
		signal.throwIfAborted();
		if (!contact.id) continue;
		// Selecting the conversation is what makes its rows readable. The detail
		// view from the previous iteration covers the list, so each round starts by
		// returning to the list — via the close button, which exists on both views,
		// rather than the back control, which exists only on the detail view and
		// made this fail on the first iteration.
		const onDetail = await session.call<boolean>("chat.detail.open", {});
		if (onDetail) {
			await control(session, "chat.back").catch(() => undefined);
			await delay(200, undefined, { signal });
		}
		// The list slides back in over about a third of a second, and point() probes
		// for a hit-testable row in a synchronous loop — inside one evaluate call it
		// cannot see the animation finish, so it reports the row as covered. Waiting
		// here is what makes the measurement land after the motion.
		await delay(350, undefined, { signal });
		const point = await session.call<{ x: number; y: number; selector?: string }>("chat.select", {
			conversation_id: contact.id,
			// A fresh token per attempt. A fixed one collided with the guard left by the
			// previous run: the attribute no longer matched the re-rendered row and the
			// guard cancelled the press, which surfaced as "something is covering it".
			token: randomUUID(),
		});
		await session.click(point);
		await delay(300, undefined, { signal });
		const conversation = await session.call<{ messages: Message[] }>("chat.read", {
			conversation_id: contact.id,
			limit: 20,
		});
		const messages = (conversation.messages ?? []).map((message) => ({
			id: message.id,
			direction: message.direction,
			text: message.text,
			kind: message.kind,
			at: message.timestamp,
			shares_work: message.share?.video_id ?? null,
		}));
		// Only works that came in from the other side: a work this account shared
		// is not something to go read before replying.
		const shared = messages
			.filter((message) => message.direction === "incoming" && message.shares_work)
			.map((message) => message.shares_work as string);
		// Whose turn it is, read from the newest message rather than from the badge
		// and not from array position: the page keeps a window, so a message that
		// arrived but is not in that window would sit behind older ones in the
		// array. Sorting by timestamp is what makes "they spoke last" true.
		const last = [...messages].sort((left, right) => (left.at ?? "").localeCompare(right.at ?? "")).at(-1);
		const awaitingReply = !!last && last.direction === "incoming";
		if (!awaitingReply && !contact.unread && (contact.unread_count ?? 0) === 0) continue;
		conversations.push({
			conversation_id: contact.id,
			name: contact.name,
			type: contact.type,
			unread_count: contact.unread_count,
			awaiting_reply: awaitingReply,
			// The tail is what a reply answers. The head is context that was already
			// in the window the first time it was read.
			messages: messages.slice(-10),
			shared_works: [...new Set(shared)],
			last_message_at: last?.at ?? null,
		});
	}
	// Opening a conversation to read it marks it read on the platform. Saying so
	// is the difference between "the inbox is empty" and "this command cleared it".
	//
	// Leave the panel on the conversation list, not on the last detail view and
	// not closed.
	//
	// Both of the obvious choices are wrong, and each was tried. Leaving it on a
	// detail view covers the list, so the next command to click a row fails with
	// "not clickable because something is covering it". Closing it entirely makes
	// `chat send` fail with "expected one conversation with the requested ID,
	// found 0" — it does not open the panel itself. Going back to the list is the
	// one state where a following command works without the caller knowing what
	// this one did.
	// Only a open conversation has a back control; on the list there is nothing to
	// go back from, and asking for it fails. The page states which view it is on
	// by whether a chat container is rendered.
	const onDetail = await session.call<boolean>("chat.detail.open", {});
	if (onDetail) await control(session, "chat.back").catch(() => undefined);
	return {
		observed_at: new Date().toISOString(),
		conversations,
		unidentified_unread: unidentified,
		has_unread: conversations.length > 0 || unidentified.length > 0,
		limits: [
			"Reading a conversation marks it read on the platform, so a second run may report less than the first. This is an observation, not a subscription.",
			"A null unread_count means the row showed an unread state without a number, not zero.",
			"Only conversations loaded in the sidebar are listed; scroll the panel for older ones.",
			"This reports what arrived. It does not decide what to reply, and `dy` never writes a reply on its own.",
		],
	};
}
