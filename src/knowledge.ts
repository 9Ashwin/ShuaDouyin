import { readdir, readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Input } from "./app.ts";

// One installation, one workspace: every recorded event and receipt carries
// this value, so records written before the change stay readable.
const BOT_ID = "default";

import { CliError } from "./errors.ts";
import { Growth } from "./growth.ts";
import { packMemories } from "./memory/context.ts";
import { Formation } from "./memory/formation.ts";
import { MemoryStore, validateMemoryInput } from "./memory.ts";
import {
	browsingContext,
	endRound,
	noteSkipped,
	noteWatched,
	roundSummary,
	rounds,
	startRound,
} from "./operations/browsing.ts";
import { chatHistory } from "./operations/chat-history.ts";
import { acknowledged, diagnostics, splitByFix } from "./operations/diagnostics.ts";
import { addGoal, discover, pauseGoal } from "./operations/discover.ts";
import { keepFindings } from "./operations/learn.ts";
import { evolvePersona, migratePersonaDocument, personaSection, presetOf } from "./operations/persona-evolve.ts";
import { personaSurface } from "./operations/persona-surface.ts";
import { parsePlan } from "./operations/plan.ts";
import { resetApply, resetPlan } from "./operations/reset.ts";
import { parseSources, signals } from "./operations/signals.ts";
import {
	closeFollowup,
	forgetPerson,
	goalUsage,
	outcomeSummary,
	pauseState,
	recordFollowup,
	recordOutcome,
	recordStage,
	setPaused,
	socialLog,
	socialView,
} from "./operations/social.ts";
import { checkVoice } from "./operations/voice-check.ts";
import { prepareReport } from "./report-sources.ts";
import { Store } from "./store.ts";
import { DOCUMENTS, PRESETS, reportDate, Workspaces } from "./workspace.ts";

export function knowledgeOperation(operation: string): boolean {
	return (
		operation === "init" ||
		operation === "guide" ||
		operation === "chat.history" ||
		operation.startsWith("browse.") ||
		operation === "diagnostics" ||
		operation === "diagnostics-ack" ||
		// The whole persona group is local: every command in it reads and writes
		// this workspace and nothing else. Listing one leaf at a time is what left
		// persona.migrate falling through to the browser dispatcher, where the only
		// possible answer was "Unknown operation".
		operation.startsWith("persona.") ||
		operation.startsWith("learn.") ||
		// social.response reads the page, so it must not be claimed as local: the
		// prefix rule would have made it fall through here and report "unknown
		// workspace operation" instead of reaching the browser.
		// social.response and social.advise read the page, so neither can be claimed
		// as local: the prefix rule would drop them into the workspace dispatcher and
		// answer "unknown workspace operation".
		(operation.startsWith("social.") && !["social.response", "social.advise"].includes(operation)) ||
		operation === "voice.check" ||
		/^(bot|workspace|memory|context|report|onboarding|growth)\./.test(operation)
	);
}
export function validateKnowledge(operation: string, input: Input): void {
	if (input.preset !== undefined && !Object.hasOwn(PRESETS, input.preset))
		throw new CliError("invalid_argument", "Unknown preset");
	if (input.name !== undefined && (!input.name.trim() || input.name.length > 200))
		throw new CliError("invalid_argument", "Invalid bot display name");
	if (
		["growth.ack", "growth.event"].includes(operation) &&
		!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(input.event_id ?? "")
	)
		throw new CliError("invalid_argument", "Use an event ID from growth review");
	if (operation.startsWith("memory.") || operation === "context.show") validateMemoryInput(operation, input);
	if (
		operation === "context.show" &&
		input.budget !== undefined &&
		(!Number.isInteger(input.budget) || input.budget < 100 || input.budget > 20000)
	)
		throw new CliError("invalid_argument", "--budget must be 100..20000 characters");
	if (["memory.candidates", "memory.decide"].includes(operation) && !input.text?.trim())
		throw new CliError("invalid_argument", "Supply JSON using --text or --text-file");
	if (operation === "memory.decision-status" && !input.request_id)
		throw new CliError("invalid_argument", "--request-id is required");
	if (operation === "workspace.set" && input.resource === "MEMORY.md")
		throw new CliError("invalid_argument", "MEMORY.md is generated; update individual memories instead");
	// One list, shared with the workspace itself. Three separate copies of it grew
	// out of sync: lessons.md was added to the workspace and this check still
	// refused to read it back.
	if (operation.startsWith("workspace.") && !DOCUMENTS.includes(input.resource ?? ""))
		throw new CliError("invalid_argument", `Document must be one of ${DOCUMENTS.join(", ")}`);
	if (["workspace.history", "workspace.restore"].includes(operation) && input.resource === "MEMORY.md")
		throw new CliError("invalid_argument", "MEMORY.md is generated and has no workspace revisions");
	if (operation === "workspace.restore" && !/^[a-f0-9]{64}$/.test(input.revision ?? ""))
		throw new CliError("invalid_argument", "Use a revision returned by workspace history");
	if (["workspace.set", "report.save"].includes(operation) && (!input.text?.trim() || input.text.length > 65536))
		throw new CliError("invalid_argument", "Supply nonempty --text or --text-file, up to 65536 characters");
	if (["report.save", "report.get", "report.prepare"].includes(operation)) reportDate(input.resource ?? "");
	if (operation === "report.prepare" && input.offset && !input.if_match)
		throw new CliError("revision_required", "Use --if-match with the revision from the first report page", {
			hint: "Read the first page, then pass its revision and next_offset.",
		});
}

export class Knowledge {
	readonly workspaces: Workspaces;
	constructor(base: string) {
		this.workspaces = new Workspaces(base);
	}
	async execute(operation: string, input: Input, signal?: AbortSignal): Promise<unknown> {
		const memory = new MemoryStore(this.workspaces);
		switch (operation) {
			case "guide":
				// The guidance is split across a short entry file and one reference per
				// topic. Returning only the entry would tell a caller the quickstart and
				// hide the rules that live in the references, so both are assembled here
				// in the order the entry file lists them.
				return { name: "dy", markdown: await skillMarkdown() };
			case "init": {
				const result = await this.workspaces.init(input.preset, input.name);
				return { ...result, onboarding: await this.workspaces.onboarding() };
			}
			case "onboarding.show":
				return this.workspaces.lock(() => this.workspaces.onboarding());
			case "onboarding.complete":
				return this.workspaces.lock(() => this.workspaces.setOnboarding("complete"));
			case "onboarding.skip":
				return this.workspaces.lock(() => this.workspaces.setOnboarding("skipped"));
			case "growth.review": {
				return this.workspaces.lock(() => new Growth(this.workspaces).review(input.since, input.limit ?? 20));
			}
			case "diagnostics":
				return this.workspaces.lock(async () => {
					const store = new Store(this.workspaces.base);
					const account = store.profile;
					return store.withLock(async () => {
						const events = await store.events();
						const result = diagnostics(events, account, BOT_ID, input.since);
						// Failures that predate the most recent fix for the same command
						// are history, not a current lead. They are counted separately
						// rather than dropped: the log is evidence and is never edited.
						const split = splitByFix(result.candidates, acknowledged(events));
						const open = split.open.length + result.slowdowns.length;
						return {
							...result,
							candidates: split.open.slice(0, input.limit ?? 20),
							resolved: split.resolved,
							candidate_count: open,
							// The advisory has to count what is still open. Leaving it on the
							// pre-split total made it keep recommending a review for trouble
							// that had already been fixed.
							review:
								open < 2
									? {
											suggested: false,
											reason:
												open === 0
													? "No repeated trouble is open; every recorded candidate has been fixed."
													: "One candidate is this round's work, not yet a pattern.",
										}
									: {
											suggested: true,
											reason: `${open} candidates are open; a review round will do more than another single fix.`,
										},
						};
					});
				});
			case "diagnostics-ack":
				return this.workspaces.lock(async () => {
					const store = new Store(this.workspaces.base);
					const operation = input.resource ?? "";
					if (!operation.trim()) throw new CliError("invalid_argument", "Name the command that was fixed");
					await store.append("diagnostics-ack", {
						operation,
						error_code: input.error_code ?? null,
						note: input.note ?? "",
					});
					return { operation, acknowledged_at: new Date().toISOString() };
				});
			case "browse.start":
				return this.workspaces.lock(async () => {
					// The plan is validated whole before anything is stored, so a bad
					// field cannot leave half a round behind.
					const raw = input.text?.trim() || (input.text_file ? await readFile(input.text_file, "utf8") : "");
					const plan = raw ? parsePlan(JSON.parse(raw) as unknown) : undefined;
					const stated = new Set(input._stated ?? []);
					return startRound(new Store(this.workspaces.base), {
						works: input.budget,
						minutes: input.minutes,
						idle: input.idle,
						goal: input.goal,
						...(plan ? { plan } : {}),
						explicit: {
							works: stated.has("budget"),
							minutes: stated.has("minutes"),
							idle: stated.has("idle"),
						},
					});
				});
			case "browse.end":
				return this.workspaces.lock(() =>
					endRound(new Store(this.workspaces.base), input.resource ?? "", input.reason ?? ""),
				);
			case "browse.watch":
				return this.workspaces.lock(() =>
					noteWatched(new Store(this.workspaces.base), input.round ?? "", input.video_id ?? ""),
				);
			case "browse.skip":
				return this.workspaces.lock(() =>
					noteSkipped(new Store(this.workspaces.base), input.round ?? "", input.video_id ?? "", input.reason ?? ""),
				);
			case "browse.round":
				return this.workspaces.lock(async () => {
					const store = new Store(this.workspaces.base);
					const events = await store.events();
					return input.resource
						? (roundSummary(events, input.resource) ?? { round_id: input.resource, known: false })
						: { rounds: rounds(events).slice(-(input.limit ?? 10)) };
				});
			case "context.browsing":
				return this.workspaces.lock(async () =>
					browsingContext(await new Store(this.workspaces.base).events(), { limit: input.limit }),
				);
			case "social.goal": {
				// No text means the caller wants the question, not a record. The owner may
				// never answer it, and discovery works without one, so this is a prompt
				// rather than a required field.
				if (!input.text?.trim())
					return {
						question: "想认识什么样的人？比如：同领域的人、兴趣同好、想维系的老朋友。",
						optional: true,
						fallback: "No answer is fine: discovery uses what this account already keeps talking about.",
					};
				return this.workspaces.lock(() =>
					addGoal(new Store(this.workspaces.base), input.text ?? "", input.topic ?? "", {
						preset: input.goal_preset,
						stages: input.stages,
						dailyLimit: input.daily_limit,
					}),
				);
			}
			case "social.goalpause":
				return this.workspaces.lock(() => pauseGoal(new Store(this.workspaces.base), input.resource ?? ""));
			case "social.discover": {
				const file = input.sources;
				if (!file) throw new CliError("invalid_argument", "Provide --sources with the people that were read");
				const raw: unknown = JSON.parse(await readFile(file, "utf8"));
				if (!Array.isArray(raw)) throw new CliError("invalid_argument", "--sources must be a JSON array");
				const sources = raw.flatMap((entry: unknown) => {
					if (!entry || typeof entry !== "object") return [];
					const item = entry as Record<string, unknown>;
					const text = (key: string) => (typeof item[key] === "string" ? (item[key] as string) : "");
					if (!text("person")) return [];
					return [
						{
							person: text("person"),
							name: text("name"),
							where: text("where"),
							source: text("source"),
							context: text("context"),
						},
					];
				});
				return this.workspaces.lock(() =>
					discover(new Store(this.workspaces.base), { sources: file, goal: input.goal, limit: input.limit }, sources),
				);
			}
			case "social.signal": {
				const file = input.sources;
				if (!file) throw new CliError("invalid_argument", "Provide --sources with the text that was read");
				const raw: unknown = JSON.parse(await readFile(file, "utf8"));
				return { ...signals({ sources: parseSources(raw), limit: input.limit }), sources: file };
			}
			case "social.stage":
				return this.workspaces.lock(() =>
					recordStage(new Store(this.workspaces.base), input.resource ?? "", input.stage ?? "", input.note ?? ""),
				);
			case "social.followup":
				return this.workspaces.lock(() =>
					recordFollowup(new Store(this.workspaces.base), input.resource ?? "", input.topic ?? "", input.due ?? ""),
				);
			case "social.outcome":
				return this.workspaces.lock(() =>
					recordOutcome(new Store(this.workspaces.base), input.resource ?? "", input.outcome ?? "", {
						goal: input.goal,
						note: input.note,
						signal: input.signal_source,
					}),
				);
			case "social.outcomes":
				return this.workspaces.lock(async () => outcomeSummary(await new Store(this.workspaces.base).events()));
			case "social.forget":
				return this.workspaces.lock(() =>
					forgetPerson(new Store(this.workspaces.base), input.resource ?? "", input.reason ?? ""),
				);
			case "social.done":
				return this.workspaces.lock(() =>
					closeFollowup(new Store(this.workspaces.base), input.resource ?? "", input.at ?? ""),
				);
			case "social.list":
			case "social.relation":
			case "social.due":
				return this.workspaces.lock(() =>
					socialView(new Store(this.workspaces.base), operation, {
						person: input.resource,
						limit: input.limit,
					}),
				);
			case "social.log":
				return this.workspaces.lock(async () => {
					const store = new Store(this.workspaces.base);
					const events = await store.events();
					return {
						...socialLog(events, { since: input.since, limit: input.limit }),
						...pauseState(events),
						goals: goalUsage(events),
					};
				});
			case "social.pause":
			case "social.resume":
				return this.workspaces.lock(() =>
					setPaused(new Store(this.workspaces.base), operation === "social.pause", input.reason ?? ""),
				);
			case "chat.history":
				return this.workspaces.lock(async () => {
					const store = new Store(this.workspaces.base);
					const account = store.profile;
					return store.withLock(async () =>
						chatHistory(
							await store.events(),
							account,
							BOT_ID,
							input.conversation_id ?? "",
							input.limit ?? 20,
							input.budget ?? 6000,
							input.offset ?? 0,
							input.if_match,
						),
					);
				});
			case "voice.check":
				// An empty text is not a text that reads well. Returning "reads-human"
				// for nothing gives the caller a passing verdict on something it never
				// supplied.
				if (!input.text?.trim()) throw new CliError("invalid_argument", "voice check needs --text to read something");
				return checkVoice(input.text);
			case "learn.keep": {
				const store = new Store(this.workspaces.base);
				return keepFindings(this.workspaces, await store.events(), {
					note: input.note,
					since: input.since,
					write: !input.dry_run,
				});
			}
			case "learn.findings":
				return this.workspaces.document("lessons.md");
			case "persona.show": {
				// Read-only and uncached: the revision returned has to be the one the
				// text came from, or a caller has no way to tell an edit happened
				// between reading the persona and using it.
				const document = await this.workspaces.document("AGENTS.md");
				return personaSurface(BOT_ID, "AGENTS.md", document.revision, document.content, input.budget ?? 6000);
			}
			case "persona.snapshot": {
				const document = await this.workspaces.document("AGENTS.md");
				const version = await this.workspaces.snapshot("AGENTS.md", document.content);
				return { file: "AGENTS.md", version, revision: document.revision };
			}
			case "persona.history":
				return { file: "AGENTS.md", snapshots: this.workspaces.snapshots("AGENTS.md") };
			case "persona.rollback": {
				const raw = input.resource ?? "";
				if (!/^\d{1,9}$/.test(raw)) throw new CliError("invalid_argument", "Use a version number from persona history");
				return this.workspaces.rollback("AGENTS.md", Number(raw));
			}
			case "persona.migrate":
				return migratePersonaDocument(this.workspaces, { write: !input.dry_run });
			case "persona.evolve": {
				// A dry run must not take the write path: it reports what the section
				// would become, and the same measurement is what the write uses.
				if (input.dry_run) {
					const current = await personaSection(this.workspaces);
					const store = new Store(this.workspaces.base);
					const preview = await evolvePersona(this.workspaces, store, { write: false });
					return { ...preview, current, preset: presetOf(current) };
				}
				const store = new Store(this.workspaces.base);
				return evolvePersona(this.workspaces, store);
			}
			case "growth.ack":
				return new Growth(this.workspaces).acknowledge(input.event_id ?? "");
			case "growth.event":
				return this.workspaces.lock(() => new Growth(this.workspaces).event(input.event_id ?? ""));
			case "bot.show":
				return this.workspaces.lock(async () => ({
					id: BOT_ID,
					workspace: this.workspaces.root(),
					documents: (await this.workspaces.reports()).length,
				}));
			case "bot.reset": {
				// A reset is a move, not a delete: everything accumulated is copied
				// aside first, and the Chrome login is kept so starting over does not
				// force another scan. --write is required because this is destructive.
				const root = this.workspaces.root();
				const stamp = new Date().toISOString().replace(/[:.]/g, "-");
				const backup = join(dirname(root), `${basename(root)}-backup-${stamp}`);
				const plan = await resetPlan(root, backup);
				if (!input.write) return { ...plan, applied: false, hint: "Add --write to copy the state aside and clear it." };
				const applied = await resetApply(plan);
				return { ...applied, applied: true, kept: plan.keep, next: "Run dy init to create a fresh bot." };
			}
			case "bot.init":
				return this.workspaces.init(input.preset);
			case "workspace.get":
				return this.workspaces.lock(() => this.workspaces.document(input.resource ?? ""));
			case "workspace.set":
				return this.workspaces.lock(() =>
					this.workspaces.setDocument(input.resource ?? "", input.text ?? "", input.if_match),
				);
			case "workspace.history":
				return this.workspaces.history(input.resource ?? "");
			case "workspace.restore":
				return this.workspaces.lock(() => this.workspaces.restore(input.resource ?? "", input.revision ?? ""));
			case "memory.add":
				return memory.put(input);
			case "memory.update":
				return memory.put(input, true);
			case "memory.get":
				return memory.read(input.resource ?? "");
			case "memory.candidates":
				return new Formation(this.workspaces).candidates(input.text ?? "", input.limit ?? 20, input.budget ?? 3000);
			case "memory.decide":
				return new Formation(this.workspaces).decide(
					input.text ?? "",
					input.apply === true && !input.dry_run,
					input.request_id,
					signal,
				);
			case "memory.decision-status":
				return new Formation(this.workspaces).decisionStatus(input.request_id ?? "");
			case "memory.delete":
				return memory.remove(input.resource ?? "", input.if_match);
			case "memory.history":
				return memory.history(input.resource ?? "");
			case "memory.list":
			case "memory.search":
				return memory.search(input);
			case "memory.reindex":
				return this.workspaces.lock(async () => ({ indexed: (await memory.reconcile()).length }));
			case "memory.graph":
				return memory.graph();
			case "memory.status":
				return memory.status();
			case "memory.usage":
				return memory.usage();
			case "memory.compact":
				return memory.compact(input);
			case "memory.ingest":
				return memory.ingest();
			case "context.show":
				return this.workspaces.lock(async () => {
					// A profile-scoped context request retrieves that person's memories
					// even without a keyword query.
					const scope = input.query?.trim() || input.profile_ref ? input : {};
					const recalled = await memory.recall({ ...scope, query: input.query, profile_ref: input.profile_ref });
					// Profiles are user-edited Markdown without a guaranteed parseable schema.
					// A full profile document or overview can contain other people's details.
					//
					// lessons.md belongs here for the same reason AGENTS.md does: it is what
					// earlier rounds learned, and a context export that leaves it out hands
					// the next round an agent that has to relearn everything. It is missing
					// rather than empty on a fresh workspace, so its absence is tolerated.
					const files = input.profile_ref ? ["AGENTS.md"] : ["AGENTS.md", "PROFILES.md", "MEMORY.md", "lessons.md"];
					const documents = (
						await Promise.all(
							files.map(async (file) => {
								try {
									return await this.workspaces.document(file);
								} catch (error) {
									// A workspace that has not learned anything yet has no file, and
									// that is a normal state rather than a failure.
									if (file === "lessons.md" && error instanceof CliError && error.code === "not_found") return null;
									throw error;
								}
							}),
						)
					).filter((document): document is NonNullable<typeof document> => document !== null);
					const budget = input.budget ?? 12000;
					const memoryBudget = recalled.hits.length ? Math.min(1800, Math.floor(budget / 2)) : 0;
					const packed = packMemories(recalled.hits, memoryBudget, input.limit ?? 20);
					let remaining = budget - packed.used;
					const excerpt = (value: string, maximum: number) => {
						const chars = Array.from(value);
						const kept = chars.slice(0, Math.min(maximum, remaining));
						remaining -= kept.length;
						return { content: kept.join(""), truncated: kept.length < chars.length };
					};
					const documentViews = documents.map((document) => ({ ...document, ...excerpt(document.content, 8000) }));
					const memoryViews = packed.items.map(({ hit, body, truncated }) => {
						const row = hit.entry.row;
						const short = (value: string, max: number) => Array.from(value).slice(0, max).join("");
						const title = short(row.title, 200);
						const subject = short(row.subject, 200);
						const topic = short(row.topic, 200);
						const type = short(row.type, 200);
						const created = short(row.created_at, 100);
						const updated = short(row.updated_at, 100);
						const tags = row.tags.filter((tag) => Array.from(tag).length <= 60).slice(0, 20);
						const sources = row.sources.filter((source) => Array.from(source).length <= 256).slice(0, 8);
						return {
							...row,
							title,
							subject,
							topic,
							type,
							created_at: created,
							updated_at: updated,
							tags,
							sources,
							links: row.links.slice(0, 20),
							metadata_truncated:
								title !== row.title ||
								subject !== row.subject ||
								topic !== row.topic ||
								type !== row.type ||
								created !== row.created_at ||
								updated !== row.updated_at ||
								tags.length !== row.tags.length,
							sources_truncated: sources.length !== row.sources.length,
							links_truncated: row.links.length > 20,
							file: join(this.workspaces.root(), row.path),
							body,
							truncated,
							score: hit.score,
							reasons: hit.reasons,
							relation_depth: hit.depth,
							relation_path: hit.path,
						};
					});
					return {
						bot: { id: BOT_ID, workspace: this.workspaces.root() },
						onboarding: await this.workspaces.onboarding(),
						documents: documentViews,
						...(input.profile_ref ? { profile_ref: input.profile_ref } : {}),
						...(input.profile_ref ? { omitted_documents: ["PROFILES.md", "MEMORY.md"] } : {}),
						memories: memoryViews,
						body_budget: budget,
						body_characters: budget - remaining,
						recall: {
							mode: "lexical_graph",
							graph_truncated: recalled.graphTruncated,
							seeds_truncated: recalled.seedsTruncated,
							more_matches: recalled.more || packed.items.length < recalled.hits.length,
							limitation: "Lexical and graph connections are not proof of semantic similarity.",
						},
						workflow: [
							"If onboarding is pending or unknown, ask the owner about the bot's name, personality and boundaries before marking setup complete.",
							"Read persona and relevant memories",
							"Inspect actual video or conversation evidence",
							"Perform only task-authorized operations",
							"Update durable facts in place with sources; keep impressions distinct",
							"After browsing, use growth review, update grounded memories and profiles, then growth ack after processing.",
							"Use report prepare for dated local sources, present a grounded summary in conversation, and save the agent-authored report when requested.",
						],
					};
				});
			case "report.prepare":
				return this.workspaces.lock(() =>
					prepareReport(
						this.workspaces,
						BOT_ID,
						input.resource ?? "",
						input.timezone ?? "Asia/Shanghai",
						input.offset ?? 0,
						input.limit ?? 20,
						input.if_match,
					),
				);
			case "report.save":
				return this.workspaces.lock(() =>
					this.workspaces.setDocument(
						`reports/${reportDate(input.resource ?? "")}.md`,
						input.text ?? "",
						input.if_match,
					),
				);
			case "report.get":
				return this.workspaces.lock(() => this.workspaces.document(`reports/${reportDate(input.resource ?? "")}.md`));
			case "report.list":
				return this.workspaces.reports();
			default:
				throw new CliError("invalid_argument", `Unknown workspace operation: ${operation}`);
		}
	}
}

// The shipped skill is one entry file plus its references. `guide` reports what
// an agent would actually read, so the references are appended rather than left
// for the caller to discover by browsing the repository.
async function skillMarkdown(): Promise<string> {
	const raw = await readFile(new URL("../skills/dy/SKILL.md", import.meta.url), "utf8");
	// The frontmatter is for a skill loader: name, description and allowed-tools
	// tell the agent platform what this is. An agent reading the assembled guide
	// does not need it, and `allowed-tools` in particular is not prose.
	const entry = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "");
	const directory = new URL("../skills/dy/references/", import.meta.url);
	let names: string[];
	try {
		names = (await readdir(directory)).filter((name) => name.endsWith(".md")).sort();
	} catch {
		return entry;
	}
	const parts = await Promise.all(
		names.map(async (name) => {
			const body = await readFile(new URL(name, directory), "utf8");
			return `\n\n<!-- ${name} -->\n${body}`;
		}),
	);
	return entry + parts.join("");
}
