import { CliError } from "../errors.ts";
import type { Event } from "../store.ts";

// A DOM window may shift or load history. Differences are observations, not
// proof that a message was newly sent, deleted or read by its recipient.
export function compareChatWindows(events: Event[], conversationID: string) {
	const snapshots = events.filter((event) => {
		const data = event.data;
		return (
			event.operation === "chat.read" &&
			!!data &&
			typeof data === "object" &&
			"id" in data &&
			data.id === conversationID &&
			"messages" in data &&
			Array.isArray(data.messages)
		);
	});
	if (snapshots.length < 2)
		throw new CliError("not_found", "Two saved chat reads are required for comparison", {
			hint: "Run chat read for this conversation twice, then compare the loaded windows.",
		});
	const before = snapshots[snapshots.length - 2];
	const after = snapshots[snapshots.length - 1];
	function index(event: Event) {
		const data = event.data as { messages: unknown[] };
		const rows = new Map<string, string>();
		const duplicates = new Set<string>();
		let missing = 0;
		for (const value of data.messages) {
			if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !value.id) {
				missing++;
				continue;
			}
			if (rows.has(value.id)) duplicates.add(value.id);
			rows.set(value.id, JSON.stringify(value));
		}
		for (const id of duplicates) rows.delete(id);
		return { rows, missing, duplicates: duplicates.size };
	}
	const left = index(before);
	const right = index(after);
	const uncertain = left.duplicates > 0 || right.duplicates > 0;
	const onlyAfter = [...right.rows.keys()].filter((id) => !left.rows.has(id));
	const onlyBefore = [...left.rows.keys()].filter((id) => !right.rows.has(id));
	return {
		conversation_id: conversationID,
		before: { event_id: before.id, at: before.at, missing_ids: left.missing, duplicate_ids: left.duplicates },
		after: { event_id: after.id, at: after.at, missing_ids: right.missing, duplicate_ids: right.duplicates },
		only_after: uncertain ? [] : onlyAfter,
		only_before: uncertain ? [] : onlyBefore,
		changed: [...right.rows]
			.filter(([id, value]) => left.rows.has(id) && left.rows.get(id) !== value)
			.map(([id]) => id),
		scope: "loaded_dom",
		complete: false,
		limitations: ["Differences between loaded windows do not establish message delivery, deletion, or read status."],
	};
}
