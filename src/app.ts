import { readFile } from "node:fs/promises";
import { ChromeManager, type Session } from "./browser.ts";
import { COMMANDS } from "./catalog.ts";
import { CliError, normalizeError } from "./errors.ts";
import { Knowledge, knowledgeOperation, validateKnowledge } from "./knowledge.ts";
import { migrateLegacyLayout } from "./migrate.ts";
import { audio, capture, noteImage, noteSlide, observe } from "./operations/capture.ts";
import { captureChatImage, listChats, readChat } from "./operations/chat.ts";
import { compareChatWindows } from "./operations/chat-diff.ts";
import { chatHistory } from "./operations/chat-history.ts";
import { sendChatImage } from "./operations/chat-image.ts";
import { sendCommentImage } from "./operations/comment-image.ts";
import { listComments, listReplies } from "./operations/comments.ts";
import { inspectCreator } from "./operations/creator.ts";
import { pageFactsRead } from "./operations/facts.ts";
import { readImage } from "./operations/image-file.ts";
import { resolveLink } from "./operations/links.ts";
import { liveChatRead, liveGiftSend, liveGifts, liveInfo, liveSay } from "./operations/live.ts";
import {
	applySearchFilters,
	closeChatIfOpen,
	control,
	listForwardRecipients,
	listResults,
	moveFeed,
	navigate,
	openRecommendFeed,
	searchUsers,
	settleOnWork,
	sweepFeed,
	verifySearchFilters,
	waitSearchResults,
	waitSnapshot,
} from "./operations/navigation.ts";
import { userRelations } from "./operations/relations.ts";
import { skillInstall, skillStatus } from "./operations/skill.ts";
import { checkGoalQuota, pauseState } from "./operations/social.ts";
import { sourceCheckout } from "./operations/source.ts";
import { type Input, isWrite, validate } from "./operations/validate.ts";
import { transcribeVoices } from "./operations/voice.ts";
import { write } from "./operations/write.ts";
import { type BrowserConfig, Store } from "./store.ts";

export type { Input } from "./operations/validate.ts";
export { isWrite, resourceID, validate } from "./operations/validate.ts";

// Commands that need the work itself in view, and are therefore blocked by the
// chat overlay. Reads only: a write states its own target and already fails
// closed on a mismatch.
const WORK_READS = new Set([
	"video.info",
	"video.play",
	"video.pause",
	"video.observe",
	"video.screenshot",
	"video.audio",
	"comment.list",
	"comment.replies",
	"note.capture",
	"note.next",
	"note.previous",
	"feed.next",
	"feed.previous",
]);

export interface AppOptions {
	bot?: string;
	state_dir?: string;
	profile?: string;
	chrome?: string;
	timeout?: number;
}

// The App owns bot/account resolution and locking. Every operation body lives
// in src/operations/ so this class stays a dispatcher.
export class App {
	store: Store;
	chrome: ChromeManager;
	readonly timeout: number;
	readonly options: AppOptions;
	migration?: { moved: string[]; skipped: string[]; from: string | null };

	constructor(options: AppOptions = {}) {
		this.options = options;
		this.store = new Store(options.state_dir);
		this.chrome = new ChromeManager(this.store, options.chrome);
		this.timeout = options.timeout ?? 45000;
	}

	async execute(operation: string, raw: Input = {}, signal = AbortSignal.timeout(this.timeout)): Promise<unknown> {
		const resolved = await this.readText(raw);
		const input = validate(operation, resolved);
		const image = ["chat.image", "comment.image"].includes(operation) ? await readImage(input.image ?? "") : undefined;
		if (operation === "comment.image" && image?.mime === "image/gif")
			throw new CliError("invalid_argument", "Image comments support PNG or JPEG files");
		const local = knowledgeOperation(operation);
		if (local) validateKnowledge(operation, input);
		// A tree written by an earlier build is flattened once, before anything
		// reads it. The move is a rename within one directory, so a crash leaves
		// either the old tree or the new one, never a mixture that reads as empty.
		if (local && !input.dry_run) this.migration = await migrateLegacyLayout(this.store.base);
		signal.throwIfAborted();
		// Local maintenance commands still need their own plan; they never touch
		// Chrome, so their dry run runs the command rather than rejecting it.
		if (
			input.dry_run &&
			!["memory.compact", "memory.candidates", "memory.decide", "memory.decision-status"].includes(operation)
		) {
			return {
				...this.plan(operation, input),
				...(image ? { media: { mime: image.mime, bytes: image.bytes.length, sha256: image.sha256 } } : {}),
			};
		}
		if (local) return new Knowledge(this.store.base).execute(operation, input, signal);
		// Reading the installed skills compares files in the repository, not the
		// workspace, so it must not queue behind a browser command holding the lock.
		if (operation === "skill.status") return skillStatus();
		if (operation === "skill.install") return skillInstall(undefined, { force: input.force });
		const run = async (botSignal?: AbortSignal) => {
			return this.store.withLock(async (leaseSignal) => {
				const active = AbortSignal.any([signal, leaseSignal, ...(botSignal ? [botSignal] : [])]);
				const handled = await this.local(operation, input, active);
				if (handled !== undefined) return handled;
				if (operation === "chat.image" && image)
					return sendChatImage(input, image, active, { store: this.store, chrome: this.chrome, timeout: this.timeout });
				if (operation === "comment.image" && image)
					return sendCommentImage(input, image, active, {
						store: this.store,
						chrome: this.chrome,
						timeout: this.timeout,
					});
				// Pausing is the owner saying "stop acting, keep looking". It gates every
				// outward action at the one point they all pass through, so no command
				// has to remember to check it.
				if (isWrite(operation) && pauseState(await this.store.events()).paused)
					throw new CliError("state", "The agent is paused", {
						hint: "Resume with dy social resume, or inspect what it did with dy social log.",
					});
				// A goal's daily limit is checked here, at the same one point the
				// pause is, and it refuses rather than queues. Queuing would turn
				// "not today" into "later, automatically", which is exactly the
				// behaviour this project refuses to build.
				if (isWrite(operation) && input.goal) checkGoalQuota(await this.store.events(), input.goal);
				// The live room has its own write path: a danmaku goes through a Slate
				// editor and a gift spends money, so neither fits the comment/send
				// settlement those receipts were built around.
				if (operation === "live.say" || operation === "live.gift") {
					const session = await this.chrome.connect(active, this.timeout, "https://live.douyin.com");
					try {
						const result =
							operation === "live.say"
								? await liveSay(session, input, active)
								: await liveGiftSend(session, input, this.store, active);
						await this.store.append(operation, { request_id: input.request_id ?? null, ...(result as object) });
						return result;
					} finally {
						await session.close();
					}
				}
				if (isWrite(operation))
					return write(operation, input, active, {
						store: this.store,
						chrome: this.chrome,
						timeout: this.timeout,
					});
				const started = performance.now();
				// A live command reads a tab on the live site; the works tab reports a
				// different page and would fail every time.
				const live = operation.startsWith("live.");
				const session = await this.chrome.connect(active, this.timeout, live ? "https://live.douyin.com" : undefined);
				try {
					const result = await this.read(session, operation, input, active);
					if (operation === "chat.read" && this.store.bot_id) {
						if (!result || typeof result !== "object")
							throw new CliError("state_corrupt", "Chat read did not return a conversation window");
						const previous = chatHistory(
							await this.store.events(),
							this.store.profile,
							this.store.bot_id,
							input.conversation_id ?? "",
							input.limit ?? 20,
							input.budget ?? 6000,
						);
						const event = await this.store.append(operation, result);
						return {
							...result,
							observation_source: `event:${this.store.profile}:${event.id}`,
							previous_context: previous,
						};
					}
					if (!["status", "auth.status"].includes(operation)) await this.store.append(operation, result);
					return result;
				} catch (error) {
					// Cancellation is the caller's choice and its outcome is not a
					// finding about the command, so only a reached failure is recorded.
					const problem = normalizeError(error);
					if (!["cancelled", "timeout"].includes(problem.code))
						await this.store.appendFailure(operation, problem, performance.now() - started);
					throw error;
				} finally {
					await session.close();
				}
			});
		};
		return new Knowledge(this.store.base).workspaces.lock(run);
	}

	// --text-file / --text-file - is resolved before validation so handlers
	// never read process input themselves.
	private async readText(raw: Input): Promise<Input> {
		if (raw.text_file === undefined) return raw;
		if (raw.text !== undefined) throw new CliError("invalid_argument", "Use either --text or --text-file");
		let text: string;
		if (raw.text_file === "-") {
			const chunks: Buffer[] = [];
			let bytes = 0;
			for await (const chunk of process.stdin) {
				const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
				bytes += buffer.length;
				if (bytes > 100000) throw new CliError("invalid_argument", "Text input is too large");
				chunks.push(buffer);
			}
			text = Buffer.concat(chunks).toString("utf8");
		} else text = await readFile(raw.text_file, "utf8");
		const resolved = { ...raw, text };
		delete resolved.text_file;
		return resolved;
	}

	private plan(operation: string, input: Input) {
		return {
			operation,
			input,
			effect: isWrite(operation)
				? "account_write"
				: operation.startsWith("browser.") || operation === "auth.login"
					? "browser_lifecycle"
					: COMMANDS.find((command) => command.id === operation)?.effect === "local"
						? "local"
						: "read_or_navigation",
			executed: false,
		};
	}

	// Operations that do not need a page session. Returning undefined means
	// the command continues to the page.
	private async local(operation: string, input: Input, signal: AbortSignal): Promise<unknown> {
		switch (operation) {
			case "browser.configure": {
				const config: BrowserConfig = {
					...(await this.store.config()),
					...(input.chrome === undefined ? {} : { chrome: input.chrome }),
					...(input.headless === undefined ? {} : { headless: input.headless }),
				};
				await this.store.write("config.json", config);
				return config;
			}
			case "source":
				return sourceCheckout();
			case "link.resolve":
				return resolveLink(input.resource ?? "", signal);
			case "browser.config":
				return this.store.config();
			case "browser.start":
				return publicBrowser(await this.chrome.start(signal, input.headless));
			case "browser.status":
				try {
					return publicBrowser(await this.chrome.load(signal));
				} catch (error) {
					if (error instanceof CliError && error.code === "browser_not_running") return { running: false };
					throw error;
				}
			case "browser.stop":
				await this.chrome.stop(signal);
				return { stopped: true };
			case "history.list": {
				const events = (await this.store.events()).filter(
					(event) =>
						(!this.store.bot_id || event.bot_id === this.store.bot_id) &&
						(!input.since || event.at >= new Date(input.since).toISOString()),
				);
				return events.slice(-(input.limit ?? 20));
			}
			case "share.history": {
				const receipts = Object.values(await this.store.receipts()).filter(
					(receipt) =>
						["chat.forward", "chat.share"].includes(receipt.operation) &&
						(!this.store.bot_id || receipt.bot_id === this.store.bot_id) &&
						(!input.since || receipt.created_at >= new Date(input.since).toISOString()),
				);
				const filtered = !!(input.video_id || input.recipient_id || input.conversation_id);
				const unknown = receipts.filter(
					(receipt) =>
						(input.video_id && !receipt.target?.video_id) ||
						(input.recipient_id && !receipt.target?.recipient_id) ||
						(input.conversation_id && !receipt.target?.conversation_id),
				).length;
				const items = receipts
					.filter(
						(receipt) =>
							(!input.video_id || receipt.target?.video_id === input.video_id) &&
							(!input.recipient_id || receipt.target?.recipient_id === input.recipient_id) &&
							(!input.conversation_id || receipt.target?.conversation_id === input.conversation_id),
					)
					.sort((a, b) => b.created_at.localeCompare(a.created_at));
				return {
					account: this.store.profile,
					bot_id: this.store.bot_id ?? null,
					items: items.slice(0, input.limit ?? 20),
					total_matched: items.length,
					unknown_target_excluded: filtered ? unknown : 0,
					scope: "local_receipts",
					complete: false,
				};
			}
			case "chat.changes": {
				const events = (await this.store.events()).filter(
					(event) => !this.store.bot_id || event.bot_id === this.store.bot_id,
				);
				return compareChatWindows(events, input.conversation_id ?? "");
			}
			case "receipt.get": {
				const receipts = await this.store.receipts();
				const receipt =
					input.request_id && Object.hasOwn(receipts, input.request_id) ? receipts[input.request_id] : undefined;
				if (!receipt || (this.store.bot_id && receipt.bot_id !== this.store.bot_id))
					throw new CliError("not_found", "Receipt not found for this bot and account");
				return receipt;
			}
			case "auth.login":
				await this.chrome.start(signal, false);
				return undefined;
			default:
				return undefined;
		}
	}

	private async read(session: Session, operation: string, input: Input, signal: AbortSignal): Promise<unknown> {
		// Every command that reads a work is blocked by the chat overlay, and one
		// place has to clear it rather than each reader remembering. Listing them
		// instead would have meant the next work-reading command forgetting again.
		if (WORK_READS.has(operation)) await closeChatIfOpen(session, signal);
		// A press on the feed starts a slide transition, and a command issued right
		// after one lands while the page is between works — which reads as a live
		// slide and fails a command that would have succeeded a moment later.
		if (WORK_READS.has(operation)) await settleOnWork(session, signal);
		switch (operation) {
			case "auth.login":
				await session.tab.goto("https://www.douyin.com/", { waitUntil: "domcontentloaded" });
				return { status: "login_window_open", next: "Complete login in Chrome, then run dy auth status." };
			case "creator.status":
				return inspectCreator(session, signal);
			case "status":
			case "auth.status":
				return session.call(operation, input);
			case "feed.open":
				return openRecommendFeed(session, signal);
			case "video.open":
				return navigate(session, `https://www.douyin.com/video/${input.video_id}`, "video", signal);
			case "search": {
				await navigate(
					session,
					`https://www.douyin.com/search/${encodeURIComponent(input.query ?? "")}`,
					"search",
					signal,
				);
				await waitSearchResults(session, input.query ?? "", signal);
				const filters = await applySearchFilters(session, input, signal);
				if (filters) await waitSearchResults(session, input.query ?? "", signal);
				const result = await listResults(session, "search.results", input, signal, "id", filters);
				if (filters) await verifySearchFilters(session, input, signal, filters.baseline, filters.marker);
				return filters
					? {
							...(result as object),
							filters: { selected: filters.selected, results_verified: filters.results_verified },
						}
					: result;
			}
			case "user.search":
				return searchUsers(session, input.query ?? "", input, signal);
			case "forward.list": {
				// The panel is hover-revealed, so listing means opening it first.
				const state = await session.call<{ video?: { id: string | null } | null; note?: { id: string } | null }>(
					"video.info",
					{},
				);
				const current = state.video?.id ?? state.note?.id ?? null;
				if (!current || current !== input.video_id)
					throw new CliError("identity_mismatch", "Current work does not match the requested video ID");
				return listForwardRecipients(session, signal);
			}
			case "page.facts":
				return pageFactsRead(session, sourceCheckout().path ?? process.cwd());
			case "live.info":
				return liveInfo(session);
			case "live.chat":
				return liveChatRead(session, input);
			case "live.gifts":
				return liveGifts(session);
			case "video.info":
			case "video.play":
			case "video.pause":
				// The chat panel is a side overlay: it covers part of the work and
				// the page reports it as blocking, but the work behind it is intact.
				// A read does not need the panel, so it is closed once rather than
				// failing a command the caller cannot otherwise complete. closeChat
				// refuses when the composer holds a draft, and that refusal is kept.
				await closeChatIfOpen(session, signal);
				return session.call(operation, input);
			case "feed.next":
			case "feed.previous":
				// The feed can sit on a live slide, which has no work identity, so the
				// move is verified against the whole slide rather than a video id.
				return moveFeed(session, operation, signal);
			case "feed.sweep":
				return sweepFeed(session, {
					count: Math.min(Math.max(1, input.count ?? 10), 100),
					maxSteps: input.steps,
					signal,
				});
			case "comment.list":
				return listComments(session, input, signal);
			case "comment.replies":
				return listReplies(session, input, signal);
			case "chat.list":
				return listChats(session);
			case "chat.close":
				// Closing is a navigation step: the draft check lives on the page so
				// an unsent message is never discarded by a caller that did not see it.
				await control(session, "chat.close");
				return waitSnapshot(session, (state) => !state.private_chat_visible, signal, 5000);
			case "chat.read":
				return readChat(session, input, signal);
			case "chat.voice":
				return transcribeVoices(session, input, signal);
			case "chat.capture":
				return captureChatImage(session, this.store, input, signal);
			case "user.followers":
			case "user.following":
				return userRelations(
					session,
					{ ...input, relation: operation === "user.following" ? "following" : "followers" },
					signal,
				);
			case "user.get":
				await navigate(session, `https://www.douyin.com/user/${input.user_id}`, "profile", signal);
				return session.call(operation, input);
			case "page.scroll":
				return session.call("scroll", input);
			case "video.screenshot":
				return capture(session, this.store, input.output);
			case "note.capture":
				return noteImage(session, this.store, input, signal);
			case "note.next":
			case "note.previous":
				return noteSlide(session, input, operation === "note.next" ? "next" : "previous", signal);
			case "video.observe":
				return observe(session, this.store, input, signal);
			case "video.audio":
				return audio(session, this.store, input);
			default:
				throw new CliError("invalid_argument", `Unknown operation: ${operation}`);
		}
	}
}

function publicBrowser(state: { headless: boolean; pid: number; started_at: string }) {
	return { running: true, headless: state.headless, pid: state.pid, started_at: state.started_at };
}
