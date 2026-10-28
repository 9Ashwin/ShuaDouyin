import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { type ProgramStatus, type Terminal, visibleWidth } from "@earendil-works/pi-tui";
import { App } from "../src/app.ts";
import { Store } from "../src/store.ts";
import { summarizeResult, TerminalUI, terminalText } from "../src/tui.ts";

class MemoryTerminal implements Terminal {
	columns = 80;
	rows = 24;
	kittyProtocolActive = false;
	output = "";
	stopped = false;
	input?: (text: string) => void;
	resize?: () => void;
	start(input: (text: string) => void, resize: () => void): void {
		this.input = input;
		this.resize = resize;
	}
	stop(): void {
		this.stopped = true;
	}
	async drainInput(): Promise<void> {}
	write(text: string): void {
		this.output += text;
	}
	moveBy(lines: number): void {
		this.output += `move:${lines}`;
	}
	hideCursor(): void {}
	showCursor(): void {}
	clearLine(): void {}
	clearFromCursor(): void {}
	clearScreen(): void {}
	setTitle(_title: string): void {}
	setProgress(_active: boolean): void {}
	setProgramStatus(_status: ProgramStatus): void {}
	send(text: string): void {
		this.input?.(text);
	}
}

async function waitForScreen(ui: TerminalUI, expected: RegExp): Promise<void> {
	for (let attempt = 0; attempt < 500; attempt++) {
		if (expected.test(terminalText(ui.root.render(80).join("\n")))) return;
		await delay(10);
	}
	assert.match(terminalText(ui.root.render(80).join("\n")), expected);
}

test("TUI navigation edits the shared browser config and restores the terminal", async (t) => {
	const directory = await mkdtemp(join(tmpdir(), "dy-tui-"));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const terminal = new MemoryTerminal();
	const ui = new TerminalUI({ state_dir: directory }, terminal);
	const done = ui.run();
	await delay(20);
	assert.match(terminalText(ui.root.render(80).join("\n")), /终端工作台/);
	terminal.send("\r");
	await delay(5);
	for (let index = 0; index < 4; index++) terminal.send("\u001b[B");
	terminal.send("\r");
	await delay(5);
	assert.match(terminalText(ui.root.render(80).join("\n")), /browser configure/);
	terminal.send("\u001b[B");
	terminal.send("\u001b[B");
	terminal.send("\r");
	await delay(5);
	terminal.send("/example/chrome");
	terminal.send("\r");
	await delay(5);
	terminal.send("\r");
	for (let i = 0; i < 100 && (await new Store(directory).config()).chrome !== "/example/chrome"; i++) await delay(10);
	assert.equal((await new Store(directory).config()).chrome, "/example/chrome");
	terminal.columns = 40;
	terminal.resize?.();
	for (const line of ui.root.render(40)) assert.ok(visibleWidth(line) <= 40);
	terminal.send("\u0003");
	await done;
	assert.equal(terminal.stopped, true);
});

test("first-run TUI can defer owner onboarding", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-tui-welcome-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init");
	const terminal = new MemoryTerminal();
	const ui = new TerminalUI({ state_dir: base, bot: "default" }, terminal, true);
	const done = ui.run();
	await waitForScreen(ui, /先为你的 Bot 设定人格/);
	await delay(30);
	terminal.send("\u001b[B");
	await delay(20);
	terminal.send("\r");
	await waitForScreen(ui, /终端工作台/);
	assert.equal(((await app.execute("onboarding.show")) as { status: string }).status, "skipped");
	terminal.send("\u0003");
	await done;
	assert.equal(terminal.stopped, true);
});

test("first-run TUI walks through the owner's persona and profile", async (t) => {
	const base = await mkdtemp(join(tmpdir(), "dy-tui-setup-"));
	t.after(() => rm(base, { recursive: true, force: true }));
	const app = new App({ state_dir: base });
	await app.execute("init");
	const terminal = new MemoryTerminal();
	const ui = new TerminalUI({ state_dir: base }, terminal, true);
	const done = ui.run();
	await waitForScreen(ui, /先为你的 Bot 设定人格/);
	terminal.send("\r");
	// There is one persona, so setup opens it for editing rather than renaming a
	// workspace first: the heading inside AGENTS.md is the name.
	await waitForScreen(ui, /编辑人格、语气与边界/);
	terminal.send("\r");
	await waitForScreen(ui, /编辑用户事实与待核对印象/);
	terminal.send("\r");
	await waitForScreen(ui, /终端工作台/);
	assert.equal(((await app.execute("onboarding.show")) as { status: string }).status, "complete");
	terminal.send("\u0003");
	await done;
});

test("terminal content is sanitized and human summaries retain useful context", () => {
	assert.equal(terminalText("\u001b[2Jhello\u001b]52;c;secret\u0007"), "hello");
	assert.match(summarizeResult({ video: { id: "123", title: "标题", author: "作者", paused: true } }), /标题/);
	assert.match(summarizeResult({ items: [{ id: "1" }] }), /1 条/);
});
