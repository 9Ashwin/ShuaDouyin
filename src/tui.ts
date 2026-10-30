import { randomUUID } from "node:crypto";
import {
	Container,
	Editor,
	matchesKey,
	ProcessTerminal,
	type SelectItem,
	SelectList,
	type SelectListTheme,
	stripTerminalSequences,
	type Terminal,
	Text,
	Input as TextInput,
	TuiAltScreen,
} from "@earendil-works/pi-tui";
import { App, type AppOptions, type Input, isWrite } from "./app.ts";
import { COMMANDS, type CommandSpec, type Flag } from "./catalog.ts";
import { CliError, errorData } from "./errors.ts";

const theme: SelectListTheme = {
	selectedPrefix: (text) => `\u001b[36m${text}\u001b[0m`,
	selectedText: (text) => `\u001b[1;36m${text}\u001b[0m`,
	description: (text) => `\u001b[2m${text}\u001b[0m`,
	scrollInfo: (text) => text,
	noMatch: (text) => text,
};

// Never allow site-provided terminal sequences to become active UI controls.
export function terminalText(value: unknown): string {
	return stripTerminalSequences(typeof value === "string" ? value : JSON.stringify(value, null, 2));
}

export class TerminalUI {
	readonly tui: TuiAltScreen;
	readonly root = new Container();
	private options: AppOptions;
	private closing = false;
	private cancelPrompt?: () => void;
	private operation?: AbortController;
	private result = "选择命令后填写参数。Esc 返回，Ctrl+C 退出。";
	private videoID?: string;
	private conversationID?: string;
	private userID?: string;
	private initialSetup: boolean;

	constructor(options: AppOptions, terminal: Terminal = new ProcessTerminal(), initialSetup = false) {
		this.options = options;
		this.initialSetup = initialSetup;
		this.tui = new TuiAltScreen(terminal);
		this.tui.addChild(this.root);
		this.tui.addInputListener((data) => {
			if (matchesKey(data, "ctrl+c")) {
				this.closing = true;
				this.operation?.abort();
				this.cancelPrompt?.();
				return { consume: true };
			}
			if (matchesKey(data, "escape") && this.operation) {
				this.operation.abort();
				return { consume: true };
			}
			return undefined;
		});
	}

	private header(title: string): void {
		this.root.clear();
		const identity = "本机工作区";
		this.root.addChild(new Text(`ShuaDouyin · 刷抖音  ·  ${terminalText(identity)}\n${title}`, 1, 1));
	}

	private choose(title: string, items: SelectItem[], detail = ""): Promise<string | null> {
		if (this.closing) return Promise.resolve(null);
		this.header(title);
		const safeItems = items.map((item) => ({
			...item,
			label: terminalText(item.label),
			...(item.description ? { description: terminalText(item.description) } : {}),
		}));
		const list = new SelectList(safeItems, 12, theme);
		this.root.addChild(list);
		if (detail) this.root.addChild(new Text(terminalText(detail), 1, 1));
		this.root.addChild(new Text("↑↓ 选择  Enter 确认  Esc 返回  Ctrl+C 退出", 1, 1));
		this.tui.setFocus(list);
		this.tui.requestRender();
		return new Promise((resolve) => {
			const finish = (value: string | null) => {
				this.cancelPrompt = undefined;
				resolve(value);
			};
			this.cancelPrompt = () => finish(null);
			list.onSelect = (item) => finish(item.value);
			list.onCancel = () => finish(null);
		});
	}

	private prompt(title: string, value = ""): Promise<string | null> {
		if (this.closing) return Promise.resolve(null);
		this.header(title);
		const input = new TextInput({ prompt: "> " });
		input.setValue(value);
		this.root.addChild(input);
		this.root.addChild(new Text("Enter 保存  Esc 返回", 1, 1));
		this.tui.setFocus(input);
		this.tui.requestRender();
		return new Promise((resolve) => {
			const finish = (result: string | null) => {
				this.cancelPrompt = undefined;
				resolve(result);
			};
			this.cancelPrompt = () => finish(null);
			input.onSubmit = finish;
			input.onEscape = () => finish(null);
		});
	}

	private editText(title: string, value = ""): Promise<string | null> {
		if (this.closing) return Promise.resolve(null);
		this.header(title);
		const editor = new Editor(this.tui, { borderColor: theme.description, selectList: theme });
		editor.setText(value);
		this.root.addChild(editor);
		this.root.addChild(new Text("Enter 保存 · Shift+Enter 换行 · Esc 返回", 1, 1));
		this.tui.setFocus(editor);
		this.tui.requestRender();
		return new Promise((resolve) => {
			const remove = this.tui.addInputListener((data) => {
				if (matchesKey(data, "escape")) {
					finish(null);
					return { consume: true };
				}
				return undefined;
			});
			const finish = (text: string | null) => {
				remove();
				this.cancelPrompt = undefined;
				resolve(text);
			};
			this.cancelPrompt = () => finish(null);
			editor.onSubmit = finish;
		});
	}

	async run(signal?: AbortSignal): Promise<void> {
		const cancel = () => {
			this.closing = true;
			this.operation?.abort();
			this.cancelPrompt?.();
		};
		if (signal?.aborted) return;
		signal?.addEventListener("abort", cancel, { once: true });
		this.tui.start();
		try {
			if (this.initialSetup) await this.offerSetup();
			while (!this.closing) {
				const selected = await this.choose(
					"终端工作台",
					[
						{ value: "browser", label: "浏览器与登录", description: "配置 Chrome、登录、启动和停止" },
						{ value: "search", label: "搜索视频" },
						{ value: "feed", label: "推荐流", description: "打开、上一条、下一条" },
						{ value: "video", label: "当前视频", description: "播放、观察、点赞、收藏" },
						{ value: "comment", label: "公开评论", description: "查看、评论、回复" },
						{ value: "chat", label: "私信", description: "会话、消息和分享链接" },
						{ value: "user", label: "用户主页" },
						{ value: "history", label: "操作记录与收据" },
						{ value: "knowledge", label: "人格、记忆与日报", description: "工作区文档、记忆检索和产物管理" },
						{ value: "persona", label: "人格进化", description: "按写过的评论长出一节、存版本、回滚" },
						{ value: "learn", label: "学到的东西", description: "把这轮的经验记下来，读已经记下的" },
						{ value: "voice", label: "文风自查", description: "看一段文字哪里像机器写的" },
						{ value: "live", label: "直播", description: "读直播间、发弹幕、送礼" },
						{ value: "social", label: "关系", description: "目标、候选、卡片和结果" },
						{ value: "person", label: "看一个人", description: "对方发过什么、写过什么" },
						{ value: "ai", label: "问抖音 AI", description: "让平台自己回答，当线索用" },
						{ value: "browse", label: "浏览轮次", description: "开一轮、记看过和划过的、收尾" },
						{ value: "note", label: "图文作品", description: "读图文帖的每一页" },
						{ value: "link", label: "解析链接", description: "把分享文案或链接解析成作品 ID" },
						{ value: "share-work", label: "分享当前作品", description: "选收件人、看分享结果" },
						{ value: "setup-owner", label: "设定人格与用户档案" },
						{ value: "quit", label: "退出" },
					],
					this.result,
				);
				if (!selected || selected === "quit") break;
				if (selected === "setup-owner") {
					await this.setupOwner();
					continue;
				}
				let commands = COMMANDS.filter((command) => command.id === selected || command.id.startsWith(`${selected}.`));
				if (selected === "browser") commands = COMMANDS.filter((command) => /^(browser|auth)\./.test(command.id));
				if (selected === "history") commands = COMMANDS.filter((command) => /^(history|receipt)\./.test(command.id));
				if (selected === "knowledge")
					commands = COMMANDS.filter((command) =>
						/^(workspace|memory|context|report|onboarding|growth)\./.test(command.id),
					);
				// These three groups were reachable only from the command line. The menu
				// is built by matching prefixes, so a group nobody added a prefix for is
				// invisible here however well it works from a shell — and a test that
				// walks COMMANDS is what keeps the next one from being missed too.
				if (selected === "persona") commands = COMMANDS.filter((command) => /^persona\./.test(command.id));
				if (selected === "learn") commands = COMMANDS.filter((command) => /^learn\./.test(command.id));
				if (selected === "voice") commands = COMMANDS.filter((command) => /^voice\./.test(command.id));
				if (selected === "live") commands = COMMANDS.filter((command) => /^live\./.test(command.id));
				if (selected === "social") commands = COMMANDS.filter((command) => /^social\./.test(command.id));
				if (selected === "person") commands = COMMANDS.filter((command) => /^person\./.test(command.id));
				if (selected === "ai") commands = COMMANDS.filter((command) => /^ai\./.test(command.id));
				if (selected === "browse") commands = COMMANDS.filter((command) => /^browse\./.test(command.id));
				if (selected === "note") commands = COMMANDS.filter((command) => /^note\./.test(command.id));
				if (selected === "link") commands = COMMANDS.filter((command) => /^link\./.test(command.id));
				// forward and share are two halves of one job — sending the current work
				// to someone — so they share a submenu.
				if (selected === "share-work") commands = COMMANDS.filter((command) => /^(forward|share)\./.test(command.id));
				const id =
					commands.length === 1
						? commands[0].id
						: await this.choose(
								"选择操作",
								commands.map((command) => ({
									value: command.id,
									label: command.id.replaceAll(".", " "),
									description: command.description,
								})),
							);
				const command = commands.find((value) => value.id === id);
				if (command) await this.form(command);
			}
		} finally {
			signal?.removeEventListener("abort", cancel);
			this.tui.stop();
		}
	}

	private async offerSetup(): Promise<void> {
		const choice = await this.choose("欢迎！先为你的 Bot 设定人格吗？", [
			{ value: "setup", label: "现在设定" },
			{ value: "later", label: "稍后再说" },
		]);
		if (choice === "setup") await this.setupOwner();
		else if (choice === "later") await new App(this.options).execute("onboarding.skip");
	}

	private async setupOwner(): Promise<void> {
		try {
			const app = new App(this.options);
			// There is one persona, so setup edits it where it lives rather than
			// renaming a workspace first: the heading in AGENTS.md is the name.
			for (const [file, title] of [
				["AGENTS.md", "编辑人格、语气与边界"],
				["PROFILES.md", "编辑用户事实与待核对印象"],
			] as const) {
				const current = (await app.execute("workspace.get", { resource: file })) as {
					content: string;
					revision: string;
				};
				const content = await this.editText(title, current.content);
				if (content === null) return;
				if (content !== current.content)
					await app.execute("workspace.set", { resource: file, text: content, if_match: current.revision });
			}
			await app.execute("onboarding.complete");
			this.result = "人格和用户档案已保存。浏览后可使用 growth review 整理记忆。";
		} catch (error) {
			this.result = terminalText(errorData(error));
		}
	}

	private async setField(input: Input, flag: Flag): Promise<boolean> {
		if (flag.key === "text") {
			const text = await this.editText("内容", input.text ?? "");
			if (text === null) return false;
			input.text = text;
			return true;
		}
		if (flag.type === "boolean" || flag.type === "boolean-value") {
			const selected = await this.choose(flag.description, [
				{ value: "true", label: flag.key === "headless" ? "无窗口 Chrome" : "是 / 开启" },
				{ value: "false", label: flag.key === "headless" ? "可见 Chrome" : "否 / 关闭" },
			]);
			if (selected === null) return false;
			Object.assign(input, { [flag.key]: selected === "true" });
			return true;
		}
		const result = await this.prompt(
			`${flag.name}  ·  ${flag.description}`,
			input[flag.key] === undefined ? "" : String(input[flag.key]),
		);
		if (result === null) return false;
		Object.assign(input, { [flag.key]: flag.type === "number" ? Number(result) : result });
		return true;
	}

	private async form(command: CommandSpec, initial: Input = {}): Promise<void> {
		const input: Input = { ...initial };
		const fields = (command.flags ?? []).filter((flag) => flag.key !== "text_file");
		for (const flag of fields)
			if (flag.default !== undefined && input[flag.key] === undefined)
				Object.assign(input, { [flag.key]: flag.default });
		if (fields.some((flag) => flag.key === "video_id") && this.videoID && !input.video_id)
			input.video_id = this.videoID;
		if (fields.some((flag) => flag.key === "conversation_id") && this.conversationID && !input.conversation_id)
			input.conversation_id = this.conversationID;
		if (fields.some((flag) => flag.key === "user_id") && this.userID && !input.user_id) input.user_id = this.userID;
		if (command.argument && input[command.argument.key] === undefined) {
			const value = await this.prompt(command.argument.description);
			if (value === null) return;
			Object.assign(input, { [command.argument.key]: value });
		}
		const currentCommand =
			command.id === "workspace.set"
				? "workspace.get"
				: command.id === "report.save"
					? "report.get"
					: ["memory.update", "memory.delete"].includes(command.id)
						? "memory.get"
						: undefined;
		if (currentCommand) {
			try {
				const current = (await new App(this.options).execute(currentCommand, { resource: input.resource })) as {
					revision: string;
					content?: string;
					body?: string;
				};
				input.if_match = current.revision;
				if (command.id !== "memory.delete") input.text = current.content ?? current.body ?? "";
			} catch (error) {
				const details = errorData(error);
				if (details.code !== "not_found") {
					this.result = terminalText(details);
					return;
				}
			}
		}
		for (const flag of fields)
			if (
				(flag.required || flag.key === "text") &&
				input[flag.key] === undefined &&
				!(await this.setField(input, flag))
			)
				return;
		if (isWrite(command.id)) input.request_id = randomUUID();
		while (!this.closing) {
			const selected = await this.choose(
				command.id.replaceAll(".", " "),
				[
					{ value: "run", label: isWrite(command.id) ? "确认执行账号操作" : "执行" },
					{ value: "preview", label: "预览 dry-run" },
					...fields.map((flag) => ({
						value: flag.key,
						label: `${flag.name.split(" ")[0]} = ${input[flag.key] ?? "未设置"}`,
						description: flag.description,
					})),
					{ value: "back", label: "返回" },
				],
				`${command.guidance ?? command.description}\n\n${terminalText(input)}`,
			);
			if (!selected || selected === "back") return;
			if (selected !== "run" && selected !== "preview") {
				const flag = fields.find((value) => value.key === selected);
				if (flag) await this.setField(input, flag);
				continue;
			}
			this.header(`正在执行 ${command.id.replaceAll(".", " ")}… Esc 取消`);
			this.tui.setFocus(null);
			this.tui.requestRender();
			this.operation = new AbortController();
			const signal = AbortSignal.any([this.operation.signal, AbortSignal.timeout(this.options.timeout ?? 45000)]);
			let data: unknown;
			let succeeded = false;
			try {
				const result = await new App(this.options).execute(
					command.id,
					{ ...input, dry_run: selected === "preview" },
					signal,
				);
				data = result;
				succeeded = selected === "run";
				const value = object(result);
				const video = object(value?.video) ?? object(object(value?.state)?.video);
				if (typeof video?.id === "string") this.videoID = video.id;
				if (typeof value?.id === "string" && command.id === "chat.read") this.conversationID = value.id;
				if (typeof value?.id === "string" && command.id === "user.get") this.userID = value.id;
				this.result = summarizeResult(result);
			} catch (error) {
				this.result = terminalText(errorData(error));
			} finally {
				this.operation = undefined;
			}
			if (!this.closing) await this.showResult(command, data, succeeded);
			return;
		}
	}

	private async showResult(command: CommandSpec, data: unknown, succeeded: boolean): Promise<void> {
		const value = object(data);
		const rows = Array.isArray(data) ? data : Array.isArray(value?.items) ? value.items : [];
		const resources = rows
			.map(object)
			.filter((row): row is Record<string, unknown> => !!row && typeof row.id === "string");
		const canChoose =
			succeeded && ["search", "comment.list", "chat.list", "memory.list", "memory.search"].includes(command.id);
		const actions: SelectItem[] = [
			...(canChoose
				? resources.map((row, index) => ({
						value: `item:${index}`,
						label: String(row.title ?? row.name ?? row.topic ?? row.text ?? row.body ?? row.id).slice(0, 120),
						description: String(row.id),
					}))
				: []),
			...(succeeded && command.id === "chat.read" ? [{ value: "reply", label: "给当前会话发消息" }] : []),
			...(succeeded && command.id === "memory.get" ? [{ value: "edit-memory", label: "修订这条记忆" }] : []),
			...(succeeded && command.id === "workspace.get" && value?.file !== "MEMORY.md"
				? [{ value: "edit-document", label: "编辑这份文档" }]
				: []),
			{ value: "json", label: "查看完整 JSON" },
			{ value: "back", label: "返回工作台" },
		];
		while (!this.closing) {
			const selected = await this.choose("执行结果", actions, this.result);
			if (!selected || selected === "back") return;
			if (selected === "json") {
				await this.choose("完整结果", [{ value: "back", label: "返回" }], terminalText(data ?? this.result));
				continue;
			}
			let next: CommandSpec | undefined;
			let initial: Input = {};
			if (selected === "reply") {
				next = COMMANDS.find((item) => item.id === "chat.send");
				initial = { conversation_id: this.conversationID };
			} else if (selected === "edit-memory") {
				next = COMMANDS.find((item) => item.id === "memory.update");
				initial = { resource: String(value?.id) };
			} else if (selected === "edit-document") {
				next = COMMANDS.find((item) => item.id === "workspace.set");
				initial = { resource: String(value?.file) };
			} else {
				const row = resources[Number(selected.slice(5))];
				if (!row) continue;
				if (command.id === "search") {
					next = COMMANDS.find((item) => item.id === "video.open");
					initial = { resource: String(row.id) };
				}
				if (command.id === "comment.list") {
					next = COMMANDS.find((item) => item.id === "comment.reply");
					initial = { video_id: String(row.video_id), comment_id: String(row.id) };
				}
				if (command.id === "chat.list") {
					next = COMMANDS.find((item) => item.id === "chat.read");
					initial = { conversation_id: String(row.id) };
				}
				if (["memory.list", "memory.search"].includes(command.id)) {
					next = COMMANDS.find((item) => item.id === "memory.get");
					initial = { resource: String(row.id) };
				}
			}
			if (next) await this.form(next, initial);
		}
	}
}

function object(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

export function summarizeResult(data: unknown): string {
	const value = object(data);
	if (Array.isArray(data)) return `已读取 ${data.length} 条记录。`;
	if (Array.isArray(value?.items)) return `已读取 ${value.items.length} 条已加载记录。选择条目可继续操作。`;
	if (Array.isArray(value?.messages))
		return `会话：${value.name ?? value.id}\n已读取 ${value.messages.length} 条消息。`;
	const video = object(value?.video);
	if (video?.id)
		return `作品 ${video.id}\n${video.title ?? ""}\n作者：${video.author ?? ""}  ${video.paused ? "已暂停" : "播放中"}`;
	if (value?.path) return `已保存：${value.path}`;
	if (value?.confirmed) return `操作已核对。${value.request_id ? `\n收据：${value.request_id}` : ""}`;
	return terminalText(data);
}

export async function runTui(options: AppOptions, signal?: AbortSignal): Promise<void> {
	// One installation is one workspace, so there is nothing to choose before the
	// interface opens. What it does need to know is whether the owner has been
	// through setup yet, which is what decides the first screen.
	const app = new App(options);
	let initialSetup = false;
	try {
		const onboarding = (await app.execute("onboarding.show")) as { status: string };
		initialSetup = onboarding.status === "pending" || onboarding.status === "unknown";
	} catch (error) {
		// A workspace that does not exist yet is exactly the first-run case: the
		// interface opens in setup rather than failing before it can draw.
		if (!(error instanceof CliError && error.code === "not_found")) throw error;
		initialSetup = true;
	}
	await new TerminalUI(options, new ProcessTerminal(), initialSetup).run(signal);
}
