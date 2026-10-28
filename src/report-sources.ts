import { createHash } from "node:crypto";
import { CliError } from "./errors.ts";
import { type Event, type Receipt, Store } from "./store.ts";
import { reportDate, type Workspaces } from "./workspace.ts";

function object(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string | null {
	return typeof value === "string" && value.length <= 1000 ? value : null;
}
function activity(event: Event, account: string) {
	const data = object(event.data);
	const work = object(data.video ?? data.note);
	const titleChars = typeof work.title === "string" ? Array.from(work.title.trim()) : [];
	const publicWork = [
		"video.info",
		"video.open",
		"video.observe",
		"note.capture",
		"note.next",
		"note.previous",
	].includes(event.operation);
	const writeWork = [
		"comment.post",
		"comment.reply",
		"comment.image",
		"chat.share",
		"chat.forward",
		"video.like",
		"video.favorite",
	].includes(event.operation);
	const workID = text(
		publicWork
			? (work.id ?? data.video_id)
			: writeWork
				? data.video_id
				: event.operation === "comment.list" || event.operation === "comment.replies"
					? (data.video_id ?? object(Array.isArray(data.items) ? data.items[0] : null).video_id)
					: null,
	);
	return {
		kind: "activity" as const,
		source: `event:${account}:${event.id}`,
		at: event.at,
		operation: event.operation,
		...(writeWork && text(data.request_id) ? { request_id: text(data.request_id) } : {}),
		work_id: workID,
		...(publicWork
			? {
					title: titleChars.length ? titleChars.slice(0, 160).join("") : null,
					title_truncated: titleChars.length > 160,
					author: text(work.author),
				}
			: {}),
		...(Array.isArray(data.items) ? { item_count: data.items.length } : {}),
		...(typeof data.scope === "string" ? { scope: data.scope } : {}),
		...(typeof data.complete === "boolean" ? { complete: data.complete } : {}),
	};
}
function receiptRecord(receipt: Receipt, account: string, date: string, day: (timestamp: string) => string) {
	const rawTarget = object(receipt.target);
	const rawMedia = object(receipt.media);
	const rawObservation = object(receipt.media_observation);
	const rawCommentObservation = object(receipt.comment_observation);
	const media =
		typeof rawMedia.sha256 === "string" &&
		/^[a-f0-9]{64}$/.test(rawMedia.sha256) &&
		typeof rawMedia.bytes === "number" &&
		Number.isSafeInteger(rawMedia.bytes) &&
		rawMedia.bytes >= 0 &&
		rawMedia.bytes <= 10_000_000 &&
		typeof rawMedia.mime === "string" &&
		["image/png", "image/jpeg", "image/gif"].includes(rawMedia.mime)
			? { sha256: rawMedia.sha256, bytes: rawMedia.bytes, mime: rawMedia.mime }
			: null;
	const observation =
		typeof rawObservation.preview_verified === "boolean" &&
		typeof rawObservation.confirm_dispatched === "boolean" &&
		typeof rawObservation.dialog_closed === "boolean" &&
		rawObservation.delivery_verified === false
			? {
					preview_verified: rawObservation.preview_verified,
					confirm_dispatched: rawObservation.confirm_dispatched,
					dialog_closed: rawObservation.dialog_closed,
					delivery_verified: false,
				}
			: null;
	const commentObservation =
		typeof rawCommentObservation.preview_verified === "boolean" &&
		typeof rawCommentObservation.publish_dispatched === "boolean" &&
		rawCommentObservation.delivery_verified === false
			? {
					preview_verified: rawCommentObservation.preview_verified,
					publish_dispatched: rawCommentObservation.publish_dispatched,
					delivery_verified: false,
				}
			: null;
	const target = Object.fromEntries(
		["video_id", "comment_id", "user_id", "recipient_id", "conversation_id"].flatMap((key) => {
			const value = text(rawTarget[key]);
			return value ? [[key, value]] : [];
		}),
	);
	return {
		kind: "receipt" as const,
		source: `receipt:${account}:${receipt.request_id}`,
		at: day(receipt.created_at) === date ? receipt.created_at : receipt.updated_at,
		created_at: receipt.created_at,
		updated_at: receipt.updated_at,
		date_basis:
			day(receipt.created_at) === date
				? day(receipt.updated_at) === date
					? "created_and_updated"
					: "created"
				: "updated",
		operation: receipt.operation,
		request_id: receipt.request_id,
		status: receipt.status,
		target: Object.keys(target).length ? target : null,
		uncertainty_reason: receipt.uncertainty_reason ?? null,
		...(["chat.image", "comment.image"].includes(receipt.operation)
			? {
					media,
					media_stage: [
						"selection_attempted",
						"selection_dispatched",
						"confirmation_ready",
						"send_attempted",
						"send_dispatched",
					].includes(receipt.media_stage ?? "")
						? receipt.media_stage
						: null,
					media_observation: observation,
					comment_observation: commentObservation,
				}
			: {}),
		delivery_verified: [
			"comment.post",
			"comment.reply",
			"comment.image",
			"chat.send",
			"chat.image",
			"chat.share",
			"chat.forward",
		].includes(receipt.operation)
			? receipt.status === "confirmed"
			: null,
	};
}

export async function prepareReport(
	workspaces: Workspaces,
	botID: string,
	date: string,
	timezone: string,
	offset: number,
	limit: number,
	expected?: string,
) {
	reportDate(date);
	let formatter: Intl.DateTimeFormat;
	try {
		formatter = new Intl.DateTimeFormat("en-CA", {
			timeZone: timezone,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
		});
	} catch {
		throw new CliError("invalid_argument", "Use a valid IANA time zone", {
			hint: "Try Asia/Shanghai or UTC, or use the owner's time zone.",
		});
	}
	const day = (timestamp: string) => {
		const time = new Date(timestamp);
		if (Number.isNaN(time.valueOf())) throw new CliError("state_corrupt", "Activity or receipt timestamp is invalid");
		const parts = formatter.formatToParts(time);
		const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
		return `${part("year")}-${part("month")}-${part("day")}`;
	};
	const store = new Store(workspaces.base);
	const account = store.profile;
	// The caller already holds the workspace lease, which is the same lock this
	// store would take; taking it again here would report the workspace as busy.
	const events = (await store.events()).filter((event) => event.bot_id === store.bot_id && day(event.at) === date);
	const receipts = Object.values(await store.receipts()).filter(
		(receipt) =>
			receipt.bot_id === store.bot_id && (day(receipt.created_at) === date || day(receipt.updated_at) === date),
	);
	const items = [
		...events.map((event) => activity(event, account)),
		...receipts.map((receipt) => receiptRecord(receipt, account, date, day)),
	].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.source.localeCompare(b.source));
	const works = new Map<
		string,
		{
			work_id: string;
			title: string | null;
			title_truncated: boolean;
			author: string | null;
			source_count: number;
			sources: string[];
		}
	>();
	const receiptStatuses: Record<string, number> = { prepared: 0, dispatching: 0, confirmed: 0, not_sent: 0 };
	for (const item of items) {
		if (item.kind === "receipt") receiptStatuses[item.status]++;
		const target = item.kind === "receipt" ? object(item.target) : {};
		const id = item.kind === "activity" ? item.work_id : text(target.video_id);
		if (!id) continue;
		const current = works.get(id) ?? {
			work_id: id,
			title: null,
			title_truncated: false,
			author: null,
			source_count: 0,
			sources: [],
		};
		if (item.kind === "activity" && "title" in item && item.title) {
			current.title = item.title;
			current.title_truncated = item.title_truncated ?? false;
		}
		if (item.kind === "activity" && "author" in item) current.author = item.author ?? current.author;
		current.source_count++;
		if (current.sources.length < 5) current.sources.push(item.source);
		works.set(id, current);
	}
	const revision = createHash("sha256").update(JSON.stringify({ account, botID, date, timezone, items })).digest("hex");
	if (expected && expected !== revision)
		throw new CliError("revision_conflict", "Report sources changed between pages", {
			hint: "Run report prepare again without --offset or --if-match, then continue with its new revision.",
			details: { revision },
		});
	const page = items.slice(offset, offset + limit);
	return {
		bot: botID,
		account,
		date,
		timezone,
		revision,
		offset,
		limit,
		total: items.length,
		summary: {
			activity_records: events.length,
			receipt_records: receipts.length,
			receipt_statuses: receiptStatuses,
			work_count: works.size,
			works: [...works.values()]
				.slice(0, 20)
				.map((work) => ({ ...work, sources_truncated: work.source_count > work.sources.length })),
			works_truncated: works.size > 20,
		},
		next_offset: offset + page.length < items.length ? offset + page.length : null,
		items: page,
		limitations: [
			"Local activity and receipts are not complete platform history.",
			"Dispatching does not prove delivery or read status.",
			"Private message text and persona documents are omitted; inspect an authorized source when needed.",
			"An activity and a receipt with the same request ID describe one operation; do not count them twice.",
			"Receipt status is the current snapshot, not necessarily its status at the end of the requested day; date_basis identifies creation or update.",
		],
		workflow: [
			"Review sources and missing evidence before interpreting them.",
			"Present the report in conversation, distinguishing observation, inference and uncertain actions.",
			"Save the agent-authored report when requested, then acknowledge processed growth events in order.",
		],
	};
}
