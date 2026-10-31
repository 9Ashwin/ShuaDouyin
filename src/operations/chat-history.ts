import { createHash } from "node:crypto";
import { CliError } from "../errors.ts";
import type { Event } from "../store.ts";

type Row = {
	id: string | null;
	direction: string;
	kind: string;
	text: string;
	timestamp: string | null;
	pending: boolean;
	failed: boolean;
	voice_transcript: string | null;
	share_video_id: string | null;
};
function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function row(value: unknown): Row {
	const item = object(value);
	const voice = object(item.voice);
	const share = object(item.share);
	return {
		id: typeof item.id === "string" && item.id.length > 0 && item.id.length <= 256 ? item.id : null,
		direction: ["incoming", "outgoing"].includes(String(item.direction)) ? String(item.direction) : "unknown",
		kind: ["text", "image", "emoji", "voice", "share"].includes(String(item.kind)) ? String(item.kind) : "unknown",
		text: typeof item.text === "string" ? item.text : "",
		timestamp: typeof item.timestamp === "string" && item.timestamp.length <= 200 ? item.timestamp : null,
		pending: item.pending === true,
		failed: item.failed === true,
		voice_transcript: typeof voice.transcript === "string" ? voice.transcript : null,
		share_video_id: typeof share.video_id === "string" && /^\d{1,64}$/.test(share.video_id) ? share.video_id : null,
	};
}

// Local observations are evidence of windows, not an authoritative message history.
export function chatHistory(
	events: Event[],
	account: string,
	bot: string,
	conversationID: string,
	limit: number,
	budget: number,
	offset = 0,
	expected?: string,
) {
	const all: { event: Event; rows: Row[] }[] = [];
	for (const event of events) {
		if (event.bot_id !== bot || event.operation !== "chat.read") continue;
		const data = object(event.data);
		if (data.id !== conversationID) continue;
		if (!Array.isArray(data.messages))
			throw new CliError("state_corrupt", "Stored chat observation has no message array");
		all.push({ event, rows: data.messages.map(row) });
	}
	const revision = createHash("sha256")
		.update(
			JSON.stringify({
				account,
				bot,
				conversationID,
				observations: all.map(({ event, rows }) => ({ id: event.id, at: event.at, rows })),
			}),
		)
		.digest("hex");
	if (expected && expected !== revision)
		throw new CliError("revision_conflict", "Conversation history changed between pages", {
			hint: "Read the first page again and use its new revision.",
			details: { revision },
		});
	const end = Math.max(0, all.length - offset);
	const observations = all.slice(Math.max(0, end - limit), end);
	const ambiguous = new Set<string>();
	for (const observation of observations) {
		const seen = new Set<string>();
		for (const item of observation.rows) {
			if (!item.id) continue;
			if (seen.has(item.id)) ambiguous.add(item.id);
			seen.add(item.id);
		}
	}
	const known = new Map<
		string,
		{ row: Row; first_seen: string; last_seen: string; sources: string[]; observations: number; versions: Set<string> }
	>();
	const windows = new Map<
		string,
		{ rows: Row[]; first_seen: string; last_seen: string; sources: string[]; observations: number }
	>();
	for (const observation of observations) {
		const source = `event:${account}:${observation.event.id}`;
		for (const item of observation.rows) {
			if (!item.id || ambiguous.has(item.id)) continue;
			const key = item.id;
			const existing = known.get(key) ?? {
				row: item,
				first_seen: observation.event.at,
				last_seen: observation.event.at,
				sources: [],
				observations: 0,
				versions: new Set<string>(),
			};
			existing.row = item;
			existing.last_seen = observation.event.at;
			existing.observations++;
			existing.versions.add(JSON.stringify(item));
			existing.sources.push(source);
			if (existing.sources.length > 5) existing.sources.shift();
			known.delete(key);
			known.set(key, existing);
		}
		if (!observation.rows.some((item) => !item.id || ambiguous.has(item.id))) continue;
		// A mixed or non-text window with no message IDs cannot be identified by
		// a sanitized representation, so do not collapse its separate observations.
		const safelyComparable = observation.rows.every(
			(item) => (item.id && !ambiguous.has(item.id)) || item.kind === "text",
		);
		const digest = safelyComparable
			? createHash("sha256").update(JSON.stringify(observation.rows)).digest("hex")
			: observation.event.id;
		const existing = windows.get(digest) ?? {
			rows: observation.rows,
			first_seen: observation.event.at,
			last_seen: observation.event.at,
			sources: [],
			observations: 0,
		};
		existing.last_seen = observation.event.at;
		existing.observations++;
		existing.sources.push(source);
		if (existing.sources.length > 5) existing.sources.shift();
		windows.delete(digest);
		windows.set(digest, existing);
	}
	let remaining = budget;
	function bounded(item: Row) {
		const chars = Array.from(item.text);
		const text = chars.slice(0, Math.min(1200, remaining)).join("");
		remaining -= Array.from(text).length;
		const transcriptChars = Array.from(item.voice_transcript ?? "");
		const transcript = transcriptChars.slice(0, Math.min(1200, remaining)).join("");
		remaining -= Array.from(transcript).length;
		return {
			...item,
			text,
			text_truncated: Array.from(text).length < chars.length,
			voice_transcript: item.voice_transcript === null ? null : transcript,
			transcript_truncated: Array.from(transcript).length < transcriptChars.length,
		};
	}
	const selectedWindows = [...windows.values()].reverse().map((window) => ({
		first_seen: window.first_seen,
		last_seen: window.last_seen,
		observations: window.observations,
		sources: window.sources,
		sources_truncated: window.observations > window.sources.length,
		messages: window.rows.slice(-50).map(bounded),
		messages_truncated: window.rows.length > 50,
	}));
	const selectedKnown = [...known.values()]
		.slice(-Math.min(limit * 10, 100))
		.reverse()
		// A previously seen message is reported by identity, not by content: the
		// content was already returned the first time this message was read, and
		// repeating it here made `chat read` four times larger than the messages it
		// was answering with. What a caller needs from this list is which ids it has
		// seen before and how often each changed — the text is the same text.
		.map((item) => ({
			id: item.row.id,
			direction: item.row.direction,
			first_seen: item.first_seen,
			last_seen: item.last_seen,
			observations: item.observations,
			observed_fields_changed: item.versions.size > 1,
			// Which events saw this message is not repeated here. `observations` and
			// the first/last seen span answer the question a reader actually has —
			// how often, over what window — and the event ids cost more than
			// everything else in this list combined. `dy history` still has them.
		}));
	return {
		conversation_id: conversationID,
		account,
		bot_id: bot,
		scope: "local_observed_windows",
		complete: false,
		revision,
		offset,
		total_observations: all.length,
		page_observations: observations.length,
		next_offset: end > observations.length ? offset + observations.length : null,
		known_message_count_in_page: known.size,
		unidentified_window_count_in_page: windows.size,
		ambiguous_id_count_in_page: ambiguous.size,
		known_messages: selectedKnown,
		unidentified_windows: selectedWindows,
		windows_truncated: windows.size > selectedWindows.length,
		known_truncated: known.size > selectedKnown.length,
		text_budget: budget,
		text_characters: budget - remaining,
		limitations: [
			"Only previously read page windows are included; the platform history may be incomplete.",
			"No-ID rows are not merged into message identities; identical windows may contain distinct messages.",
			"Observation order is not proof of message chronology, delivery, or read status.",
			"Media URLs are omitted; inspect the original source when needed.",
		],
	};
}
