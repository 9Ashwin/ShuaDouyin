import { readFile } from "node:fs/promises";
import { ChromeManager, type Session } from "./browser.ts";
import { COMMANDS } from "./catalog.ts";
import { CliError, normalizeError } from "./errors.ts";
import { Knowledge, knowledgeOperation, validateKnowledge } from "./knowledge.ts";
import type { Memory } from "./memory/concept.ts";
import { migrateLegacyLayout } from "./migrate.ts";
import { askDouyin } from "./operations/ai-search.ts";
import { audio, capture, noteImage, noteSlide, observe } from "./operations/capture.ts";
import { captureChatImage, listChats, readChat } from "./operations/chat.ts";
import { compareChatWindows } from "./operations/chat-diff.ts";
import { chatHistory } from "./operations/chat-history.ts";
import { sendChatImage } from "./operations/chat-image.ts";
import { CLEAN_LIMITS, clean } from "./operations/clean.ts";
import { deleteComment } from "./operations/comment-delete.ts";
import { sendCommentImage } from "./operations/comment-image.ts";
import {
	closeComments,
	commentVoice,
	knownVoices,
	listComments,
	listReplies,
	phraseReport,
	recordPhraseUse,
	samenessReport,
} from "./operations/comments.ts";
import { inspectCreator } from "./operations/creator.ts";
import { digest } from "./operations/digest.ts";
import { pageFactsRead } from "./operations/facts.ts";
import { readImage } from "./operations/image-file.ts";
import { readInbox } from "./operations/inbox.ts";
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
import { type Phrase, phraseMemories, phraseMemoryText, usePhrase } from "./operations/phrases.ts";
import { readPerson } from "./operations/read-person.ts";
import { recallMessage } from "./operations/recall.ts";
import { userRelations } from "./operations/relations.ts";
import { observeResponse } from "./operations/response-window.ts";
import { skillInstall, skillStatus } from "./operations/skill.ts";
import type { Vocabulary } from "./operations/social.ts";
import { checkGoalQuota, pauseState } from "./operations/social.ts";
import { advise, wouldSetStage } from "./operations/social-advice.ts";
import { sourceCheckout } from "./operations/source.ts";
import { updateReport } from "./operations/update.ts";
import { type Input, isWrite, resourceID, validate } from "./operations/validate.ts";
import { transcribeVoices } from "./operations/voice.ts";
import { type VoiceRecord, voiceMemories, voiceMemoryText } from "./operations/voice-memory.ts";
import { write } from "./operations/write.ts";
import { quiet, type Reproduce } from "./progress.ts";
import { type BrowserConfig, Store } from "./store.ts";
import type { VoiceProfile } from "./voice.ts";
import { Workspaces } from "./workspace.ts";

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
	// Called as a write moves through its steps. Defaults to doing nothing so
	// every caller that does not ask for it stays silent.
	progress?: Reproduce;
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
		// These answer about the installation itself, so they need no workspace:
		// asking how to update a copy must work on a machine that never ran
		// `dy init`, which is exactly the machine that needs the answer.
		if (operation === "update") return updateReport(input.force === true);
		if (operation === "skill.status") return skillStatus();
		if (local) return new Knowledge(this.store.base).execute(operation, input, signal);
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
								? await liveSay(session, input, this.store, active)
								: await liveGiftSend(session, input, this.store, active);
						await this.store.append(operation, { request_id: input.request_id ?? null, ...(result as object) });
						return result;
					} finally {
						await session.close();
					}
				}
				// Deleting runs before the generic write path: the page takes no
				// confirmation, so its own receipt and identity checks are the whole
				// guarantee, and it does not share the composer settlement.
				if (operation === "comment.delete") {
					// Without --confirm this must not fall through to the generic write
					// path: that path fills a composer and presses publish, which is a
					// different operation entirely and failed as "not in reply state".
					if (!input.confirm)
						throw new CliError("invalid_argument", "Deleting cannot be undone; pass --confirm", {
							hint: "The page asks for no confirmation, so this flag is the only one there is.",
						});
					return deleteComment(input, active, {
						store: this.store,
						chrome: this.chrome,
						timeout: this.timeout,
					});
				}
				// Recalling is its own path for the same reason deleting is: it has no
				// composer, no settlement and no confirmation, so the generic write
				// path would fill an input that does not exist.
				if (operation === "chat.recall") {
					const session = await this.chrome.connect(active, this.timeout);
					try {
						return await recallMessage(session, input, this.store, active);
					} finally {
						await session.close();
					}
				}
				if (isWrite(operation)) {
					// A failed send used to leave no trace: only the read path recorded
					// failures, so `diagnostics` and the repeated-failure rule in
					// `learn keep` could never see that sending kept breaking. The
					// receipt already holds the delivery state; this is what makes the
					// failure visible to the parts that look for patterns across rounds.
					const writeStarted = performance.now();
					try {
						const result = await write(operation, input, active, {
							store: this.store,
							chrome: this.chrome,
							timeout: this.timeout,
							progress: this.options.progress ?? quiet,
						});
						// A confirmed comment is the only moment the ledger stops being
						// advisory. Counting the use here rather than asking the caller to
						// run `comment phrases --use` is what makes the count complete:
						// a caller that forgets is the failure mode the ledger exists for.
						// A ledger that cannot be updated must not turn a delivered comment
						// into a failure, so this reports its own trouble instead.
						if (
							(operation === "comment.post" || operation === "comment.reply") &&
							input.text &&
							result &&
							typeof result === "object"
						)
							return {
								...result,
								phrase: await recordPhraseUse(new Knowledge(this.store.base), input.text).catch(() => null),
							};
						return result;
					} catch (error) {
						// Cancellation is the caller's choice and delivery_uncertain is
						// already durable in its receipt; neither is a finding about the
						// command. Anything else is recorded the same way a read failure is.
						const problem = normalizeError(error);
						if (!["cancelled", "timeout", "delivery_uncertain", "decision_uncertain"].includes(problem.code))
							await this.store.appendFailure(operation, problem, performance.now() - writeStarted);
						throw error;
					}
				}
				const started = performance.now();
				// A live command reads a tab on the live site; the works tab reports a
				// different page and would fail every time.
				const live = operation.startsWith("live.");
				const session = await this.chrome.connect(active, this.timeout, live ? "https://live.douyin.com" : undefined);
				try {
					const result = await this.read(session, operation, input, active);
					// Every page answer carries the setup question until it is answered. It
					// is attached here rather than deep inside each operation so no command
					// has to remember, and so a command added later cannot forget.
					const setup = await setupNotice(this.store.base);
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
					return setup && result && typeof result === "object" ? { ...result, setup } : result;
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
			case "browser.clean": {
				const result = await clean(this.store.base, { write: input.apply === true });
				return {
					...result,
					freed_mb: Math.round(result.freed / 1024 / 1024),
					applied: input.apply === true,
					limits: CLEAN_LIMITS,
				};
			}
			case "browser.stop":
				await this.chrome.stop(signal);
				return { stopped: true };
			case "comment.phrases": {
				const known = new Knowledge(this.store.base);
				if (!input.text) {
					const memories = (await known.execute("memory.list", { limit: 1000 })) as Memory[];
					// What was actually written is the check the ledger cannot make:
					// different phrases can still add up to one formula.
					const events = await this.store.events();
					const written = events
						.filter((event) => event.operation === "comment.post" || event.operation === "comment.reply")
						.map((event) => ({
							text:
								typeof (event.data as { text?: unknown })?.text === "string"
									? ((event.data as { text: string }).text ?? "")
									: "",
							at: event.at,
						}))
						.filter((comment) => comment.text)
						.slice(-20);
					return { ...(phraseReport(memories) as object), sameness: samenessReport(written) };
				}
				// Recording a use is a local write: it changes what the ledger will
				// offer next, and saying so is what keeps a phrase from becoming a tic.
				const memories = (await known.execute("memory.list", { limit: 1000 })) as Memory[];
				const found = phraseMemories(memories).find((phrase) => phrase.text === input.text);
				if (!found) throw new CliError("not_found", "No learned phrase matches that text");
				const updated = usePhrase(found, new Date());
				const target = memories.find(
					(memory) => memory.tags?.includes("phrase-ledger") && memory.body.includes(`「${found.text}」`),
				);
				if (!target) throw new CliError("state_corrupt", "The phrase ledger entry is missing");
				await known.execute("memory.update", {
					resource: target.id,
					text: phraseMemoryText(updated),
					source: `phrase:${found.from_video}`,
					if_match: target.revision,
					layer: "experience",
					memory_type: "insight",
					topic: "可用句式",
					tags: "phrase-ledger,comment-style",
				});
				return { recorded: true, phrase: updated };
			}
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
			case "video.seek":
				await closeChatIfOpen(session, signal);
				// The CLI spells the position `position`; the page calls it `at`.
				// Passing the input through unchanged left the page without a
				// number and every seek failed as "non-negative position required".
				return session.call(operation, { ...input, at: input.position });
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
			case "comment.voice": {
				// No browse target means the caller is asking what has been learned,
				// which needs no page at all.
				// Measuring and recalling are different questions, so they are
				// different calls rather than one guessed from an empty flag: with
				// --known the caller asks what past sections looked like, and without
				// it the current work is measured.
				if (input.known) {
					const known = new Knowledge(this.store.base);
					const memories = (await known.execute("memory.list", { limit: 1000 })) as Memory[];
					return knownVoices(memories);
				}
				const measured = (await commentVoice(session, input, signal)) as {
					video_id: string | null;
					sampled: number;
					profile: VoiceProfile;
					engagement?: VoiceRecord["engagement"];
				};
				if (!input.write) return measured;
				const known = new Knowledge(this.store.base);
				// Measuring the same work again should update what is known about it,
				// not add a second section. Two records of one work were counted as two
				// sections by summarise, which then reported a history the account never
				// had.
				const previous = voiceMemories((await known.execute("memory.list", { limit: 1000 })) as Memory[]).find(
					(record) => record.video_id === (measured.video_id ?? ""),
				);
				const previousMemory = previous
					? ((await known.execute("memory.list", { limit: 1000 })) as Memory[]).find(
							(memory) => memory.tags?.includes("voice-profile") && memory.body.includes(`作品 ${previous.video_id}`),
						)
					: undefined;
				const body = voiceMemoryText({
					video_id: measured.video_id ?? "",
					profile: measured.profile,
					sampled: measured.sampled,
					// The measurement already reported how the section's comments were
					// received; dropping it here meant the saved record could never say
					// whether length had anything to do with likes, which is the one
					// question a later comparison would ask.
					...(measured.engagement ? { engagement: measured.engagement } : {}),
					at: new Date().toISOString(),
				});
				if (previousMemory) {
					await known.execute("memory.update", {
						resource: previousMemory.id,
						text: body,
						source: `video:${measured.video_id ?? "unknown"}`,
						if_match: previousMemory.revision,
						layer: "experience",
						memory_type: "insight",
						topic: "评论区风格",
						tags: "voice-profile,comment-style",
					});
				}
				const saved = previousMemory
					? { updated: previousMemory.id }
					: await known.execute("memory.add", {
							text: voiceMemoryText({
								video_id: measured.video_id ?? "",
								profile: measured.profile,
								sampled: measured.sampled,
								// The measurement already reported how the section's comments were
								// received; dropping it here meant the saved record could never say
								// whether length had anything to do with likes, which is the one
								// question a later comparison would ask.
								...(measured.engagement ? { engagement: measured.engagement } : {}),
								at: new Date().toISOString(),
							}),
							source: `video:${measured.video_id ?? "unknown"}`,
							layer: "experience",
							memory_type: "insight",
							topic: "评论区风格",
							tags: "voice-profile,comment-style",
							certainty: "observed",
							confidence: 0.6,
						});
				// The comments that landed become the ledger's first entries. A phrase
				// already in the ledger is not added again: a second entry would look
				// fresh and be offered as if new, which is the repetition this ledger
				// exists to prevent.
				const existing = new Set(
					phraseMemories((await known.execute("memory.list", { limit: 1000 })) as Memory[]).map(
						(phrase) => phrase.text,
					),
				);
				const learned: string[] = [];
				for (const candidate of (measured as { candidates?: Phrase[] }).candidates ?? []) {
					if (existing.has(candidate.text)) continue;
					await known.execute("memory.add", {
						text: phraseMemoryText(candidate),
						source: `video:${candidate.from_video || "unknown"}`,
						layer: "experience",
						memory_type: "insight",
						topic: "可用句式",
						tags: "phrase-ledger,comment-style",
						certainty: "observed",
						confidence: 0.5,
					});
					learned.push(candidate.text);
				}
				return { ...measured, saved, learned };
			}
			case "comment.replies":
				return listReplies(session, input, signal);
			case "comment.close":
				// The panel covers the right edge of the player, which is where the
				// feed arrows live. Leaving it open made the next feed.next fail with
				// "the feed did not move", so reading comments and then paging was
				// impossible without reloading the page.
				return { closed: await closeComments(session, signal) };
			case "chat.list":
				return listChats(session);
			case "chat.inbox":
				return readInbox(session, input, signal);
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
			case "ai.ask":
				return askDouyin(session, input, signal);
			case "person.read":
				input.user_id = resourceID(input.resource ?? "", "user");
				return readPerson(session, input, signal);
			case "social.advise": {
				// Reads the conversation, then the card. Both are needed: the window
				// says whether anything came back, and the card says who this person is
				// to this installation.
				const window = await observeResponse(session, input.conversation_id ?? "", {
					limit: input.limit,
					signal,
				});
				const card = await new Knowledge(this.store.base).execute("social.relation", {
					resource: input.resource ?? "",
				});
				const known = card as { known?: boolean; stage?: string; contact_count?: number } & Record<string, unknown>;
				if (!known.known)
					return {
						person: input.resource ?? null,
						conversation_id: input.conversation_id ?? null,
						window,
						advice: null,
						reason: "No card for this person yet. Discovery and a first look at their profile come before a message.",
					};
				const advice = advise(known as never, window);
				const vocabulary = (known.vocabulary ?? null) as Vocabulary | null;
				return {
					person: input.resource ?? null,
					conversation_id: input.conversation_id ?? null,
					stage: known.stage ?? null,
					window,
					advice,
					...(vocabulary ? { stage_this_would_support: wouldSetStage(known as never, advice, vocabulary) } : {}),
					// Said every time, because the whole point is that this proposes.
					written: false,
				};
			}
			case "social.response":
				return observeResponse(session, input.conversation_id ?? "", {
					limit: input.limit,
					signal,
				});
			case "user.get": {
				await navigate(session, `https://www.douyin.com/user/${input.user_id}`, "profile", signal);
				// The work grid fills in after the header. Reading as soon as the
				// navigation settles returned a profile with zero works while the tab
				// strip beside it said four, so the read waits for a card to exist —
				// and reports the empty list when a profile genuinely has none.
				await waitForProfileWorks(session, signal);
				return session.call(operation, input);
			}
			case "page.scroll":
				return session.call("scroll", input);
			case "video.screenshot":
				return capture(session, this.store, input.output);
			case "note.capture":
				return noteImage(session, this.store, input, signal);
			case "note.next":
			case "note.previous":
				return noteSlide(session, input, operation === "note.next" ? "next" : "previous", signal);
			case "video.digest":
				return digest(session, this.store, input, signal);
			case "video.observe":
				return observe(session, this.store, input, signal);
			case "video.audio":
				return audio(session, this.store, input);
			default:
				throw new CliError("invalid_argument", `Unknown operation: ${operation}`);
		}
	}
}

// A profile's work grid fills in a moment after its header. Waiting for it is
// what makes "this account has four works" different from "this account's works
// have not rendered yet" — the read cannot tell them apart on its own.
async function waitForProfileWorks(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const state = await session.call<{ works: number }>("profile.works").catch(() => ({ works: 0 }));
		if (state.works > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
		signal.throwIfAborted();
	}
}

// The setup question, carried with the first answer instead of blocking it.
//
// A block was tried first and is wrong: someone who wants to look at a few videos
// before naming the bot would be stopped by an error, which is a worse experience
// than a nudge they can act on or ignore. A gate also has to decide which commands
// count, and every list like that is wrong at the edges.
//
// A notice rides along with whatever was asked for. The result the caller wanted is
// still there; the missing setup is stated once, in the same envelope, with the two
// questions to ask. It appears on every answer until the owner answers, because a
// notice that appears once is one a caller can miss.
export async function setupNotice(base: string): Promise<object | null> {
	const state = await new Workspaces(base).onboarding().catch(() => null);
	// `unknown` means the file is missing: a workspace that never ran init.
	if (!state || state.status === "complete" || state.status === "skipped") return null;
	return {
		status: state.status,
		ask: ["What should this bot be called, and how should it sound?", "What must it never do?"],
		next: "Save the persona with `dy workspace get AGENTS.md` for the revision, `dy workspace set AGENTS.md --text-file <file> --if-match <revision>`, then `dy onboarding complete`. If the owner would rather decide later, run `dy onboarding skip`.",
		why: "Until this is answered the bot browses and comments as a generic assistant. Nothing in the output would say the owner was never asked.",
	};
}

function publicBrowser(state: { headless: boolean; pid: number; started_at: string }) {
	return { running: true, headless: state.headless, pid: state.pid, started_at: state.started_at };
}
