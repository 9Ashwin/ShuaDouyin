import { spawn } from "node:child_process";
import { once } from "node:events";
import { constants } from "node:fs";
import { access, mkdir, open, readFile, unlink } from "node:fs/promises";
import { delimiter, isAbsolute, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { type Browser, chromium, type Page } from "playwright-core";
import { CliError, isMissing } from "./errors.ts";
import type { Store } from "./store.ts";

export interface BrowserState {
	pid: number;
	port: number;
	websocket: string;
	target_id?: string;
	headless: boolean;
	started_at: string;
}
interface Version {
	webSocketDebuggerUrl: string;
	"User-Agent"?: string;
}
export interface Snapshot {
	url: string | null;
	title: string | null;
	page_kind: string;
	unsupported_page: boolean;
	login_required: boolean;
	verification_required: boolean;
	private_chat_visible: boolean;
	video: {
		id: string | null;
		url: string | null;
		title: string;
		author: string;
		time: number;
		duration: number | null;
		paused: boolean;
		muted: boolean;
		ready_state: number;
		viewport_intersects: boolean;
	} | null;
	note: {
		id: string;
		url: string;
		title: string;
		author: string;
		images: { src: null; source_available: boolean; label: string | null; ready: boolean }[];
		slide: { index: number | null; count: number | null };
	} | null;
	video_selection: { candidates: number; ambiguous: boolean };
	// The slide the feed is showing. A live stop has no work id, so movement is
	// checked against this rather than against a video id alone.
	slide: { kind: string; id: string | null };
	// Set when opening the feed had to step past a live slide to reach a work.
	skipped_live?: string;
	search_results: { id: string; url: string; title: string }[];
	visible_text?: string;
}
export interface Point {
	x?: number;
	y?: number;
	selector?: string;
	already?: boolean;
}

export async function findChrome(explicit?: string): Promise<string> {
	const candidates: string[] = [];
	if (explicit) candidates.push(explicit);
	else {
		if (process.platform === "darwin")
			candidates.push(
				"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
				"/Applications/Chromium.app/Contents/MacOS/Chromium",
			);
		if (process.platform === "win32")
			for (const base of [process.env.PROGRAMFILES, process.env["PROGRAMFILES(X86)"], process.env.LOCALAPPDATA])
				if (base) candidates.push(join(base, "Google", "Chrome", "Application", "chrome.exe"));
		candidates.push("google-chrome", "google-chrome-stable", "chromium", "chromium-browser");
	}
	for (const candidate of candidates) {
		const paths = isAbsolute(candidate)
			? [candidate]
			: (process.env.PATH ?? "").split(delimiter).map((directory) => join(directory, candidate));
		for (const path of paths) {
			try {
				await access(path, process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return path;
			} catch {
				/* Try the next executable. */
			}
		}
	}
	throw new CliError("chrome_not_found", "Google Chrome or Chromium was not found", {
		hint: "Install Chrome or pass --chrome /absolute/path/to/chrome.",
	});
}

async function version(port: number, signal: AbortSignal): Promise<Version> {
	if (!Number.isInteger(port) || port < 1 || port > 65535)
		throw new CliError("state_corrupt", "Invalid Chrome debugging port");
	const response = await fetch(`http://127.0.0.1:${port}/json/version`, {
		signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
		redirect: "error",
	});
	if (!response.ok) throw new CliError("browser_unavailable", `Chrome returned HTTP ${response.status}`);
	return (await response.json()) as Version;
}

export class ChromeManager {
	readonly store: Store;
	readonly chrome?: string;

	constructor(store: Store, chrome?: string) {
		this.store = store;
		this.chrome = chrome;
	}

	async load(signal: AbortSignal): Promise<BrowserState> {
		const state = await this.store.read<BrowserState | null>("browser.json", null);
		if (!state)
			throw new CliError("browser_not_running", "No dedicated Chrome session", {
				hint: "Run dy auth login, or dy browser start after login.",
			});
		if (!Number.isInteger(state.port) || typeof state.websocket !== "string" || typeof state.headless !== "boolean")
			throw new CliError("state_corrupt", "Invalid browser session record");
		try {
			const current = await version(state.port, signal);
			if (
				current.webSocketDebuggerUrl !== state.websocket ||
				!state.websocket.startsWith(`ws://127.0.0.1:${state.port}/devtools/browser/`)
			)
				throw new Error("CDP identity mismatch");
		} catch (cause) {
			signal.throwIfAborted();
			throw new CliError("browser_not_running", "Dedicated Chrome is no longer reachable", {
				hint: "Run browser start. The login profile will be reused.",
				cause,
			});
		}
		return state;
	}

	async start(signal: AbortSignal, headless?: boolean): Promise<BrowserState> {
		const config = await this.store.config();
		const desired = headless ?? config.headless ?? false;
		try {
			const state = await this.load(signal);
			if (state.headless !== desired)
				throw new CliError("invalid_argument", "Chrome is running in a different display mode", {
					hint: "Run browser stop before changing --headless.",
				});
			return state;
		} catch (error) {
			if (!(error instanceof CliError) || error.code !== "browser_not_running") throw error;
		}
		const executable = await findChrome(this.chrome ?? config.chrome ?? process.env.DY_CHROME_PATH);
		const profile = this.store.path("chrome");
		await mkdir(profile, { recursive: true, mode: 0o700 });
		const portFile = join(profile, "DevToolsActivePort");
		try {
			const recovered = await this.fromPortFile(portFile, signal);
			if (recovered.headless !== desired)
				throw new CliError("invalid_argument", "Recovered Chrome is running in a different display mode");
			await this.store.write("browser.json", recovered);
			return recovered;
		} catch (error) {
			if (error instanceof CliError && error.code === "invalid_argument") throw error;
			signal.throwIfAborted();
		}
		try {
			await unlink(portFile);
		} catch (error) {
			if (!isMissing(error)) throw error;
		}
		const args = [
			`--user-data-dir=${profile}`,
			"--remote-debugging-address=127.0.0.1",
			"--remote-debugging-port=0",
			"--no-first-run",
			"--no-default-browser-check",
			"--disable-background-timer-throttling",
			"--disable-renderer-backgrounding",
			"--autoplay-policy=no-user-gesture-required",
			"--window-size=1440,1000",
			...(desired ? ["--headless=new", "--mute-audio"] : []),
			"about:blank",
		];
		const log = await open(this.store.path("chrome.log"), "a", 0o600);
		const child = spawn(executable, args, { detached: true, windowsHide: desired, stdio: ["ignore", log.fd, log.fd] });
		try {
			await once(child, "spawn");
		} catch (cause) {
			throw new CliError("browser_unavailable", "Could not start Chrome", { cause });
		} finally {
			await log.close();
		}
		child.unref();
		const deadline = Date.now() + 20_000;
		while (Date.now() < deadline) {
			signal.throwIfAborted();
			try {
				const state = await this.fromPortFile(portFile, signal);
				state.pid = child.pid ?? 0;
				state.headless = desired;
				await this.store.write("browser.json", state);
				return state;
			} catch {
				signal.throwIfAborted();
			}
			if (child.exitCode !== null) break;
			await delay(150, undefined, { signal });
		}
		throw new CliError("browser_unavailable", "Chrome did not expose a debugging endpoint", {
			hint: `Inspect ${this.store.path("chrome.log")}. Do not delete an active Chrome profile lock.`,
		});
	}

	private async fromPortFile(path: string, signal: AbortSignal): Promise<BrowserState> {
		const [rawPort, endpoint] = (await readFile(path, "utf8")).trim().split(/\s+/);
		const port = Number(rawPort);
		const info = await version(port, signal);
		const websocket = `ws://127.0.0.1:${port}${endpoint}`;
		if (!endpoint?.startsWith("/devtools/browser/") || info.webSocketDebuggerUrl !== websocket)
			throw new CliError("browser_unavailable", "Chrome endpoint identity did not match the dedicated profile");
		return {
			pid: 0,
			port,
			websocket,
			headless: !!info["User-Agent"]?.includes("HeadlessChrome"),
			started_at: new Date().toISOString(),
		};
	}

	async connect(signal: AbortSignal, timeout = 30_000, origin?: string): Promise<Session> {
		const state = await this.load(signal);
		const browser = await chromium.connectOverCDP(state.websocket, { timeout });
		const session = new Session(browser, signal);
		try {
			const context = browser.contexts()[0];
			if (!context) throw new CliError("browser_unavailable", "Chrome has no default browser context");
			const identify = async (page: Page) => {
				const cdp = await context.newCDPSession(page);
				try {
					return (await cdp.send("Target.getTargetInfo")).targetInfo.targetId;
				} finally {
					await cdp.detach();
				}
			};
			// The live site runs on its own origin in a tab of its own. A command that
			// acts on a live room must follow it there; the owned works tab reports a
			// different page and would fail every live command. An explicit origin
			// therefore wins over the pinned tab.
			if (origin) {
				for (const page of context.pages()) {
					try {
						if (new URL(page.url()).origin === origin) {
							session.page = page;
							break;
						}
					} catch {
						// A page on about:blank has no origin to compare.
					}
				}
			}
			if (!session.page)
				for (const page of context.pages())
					if ((await identify(page)) === state.target_id) {
						session.page = page;
						break;
					}
			if (!session.page) {
				const cdp = await browser.newBrowserCDPSession();
				const created = await cdp.send("Target.createTarget", { url: "about:blank" });
				await cdp.detach();
				const deadline = Date.now() + 3000;
				while (!session.page && Date.now() < deadline) {
					signal.throwIfAborted();
					for (const page of context.pages())
						if ((await identify(page)) === created.targetId) {
							session.page = page;
							break;
						}
					if (!session.page) await delay(50, undefined, { signal });
				}
				if (!session.page) throw new CliError("browser_unavailable", "Could not attach to the owned tab");
				state.target_id = created.targetId;
				await this.store.write("browser.json", state);
			}
			session.page.setDefaultTimeout(timeout);
			session.page.setDefaultNavigationTimeout(timeout);
			return session;
		} catch (error) {
			await session.close();
			throw error;
		}
	}

	async stop(signal: AbortSignal): Promise<void> {
		const state = await this.load(signal);
		const browser = await chromium.connectOverCDP(state.websocket, { timeout: 5000 });
		try {
			const cdp = await browser.newBrowserCDPSession();
			await cdp.send("Browser.close");
		} catch {
			/* Closing Chrome may disconnect before its response. */
		} finally {
			await browser.close().catch(() => undefined);
		}
		for (let attempt = 0; attempt < 20; attempt++) {
			try {
				await this.load(signal);
			} catch (error) {
				if (error instanceof CliError && error.code === "browser_not_running") {
					await unlink(this.store.path("browser.json"));
					return;
				}
				throw error;
			}
			await delay(100, undefined, { signal });
		}
		throw new CliError("browser_unavailable", "Chrome is still running after the close request");
	}
}

let adapter: string | undefined;

export class Session {
	readonly browser: Browser;
	readonly signal: AbortSignal;
	page?: Page;
	private readonly aborted: () => void;

	constructor(browser: Browser, signal: AbortSignal) {
		this.browser = browser;
		this.signal = signal;
		this.aborted = () => {
			void browser.close().catch(() => undefined);
		};
		signal.addEventListener("abort", this.aborted, { once: true });
	}

	get tab(): Page {
		this.signal.throwIfAborted();
		if (!this.page) throw new CliError("browser_unavailable", "No owned tab is attached");
		return this.page;
	}

	async call<T = unknown>(operation: string, args: object = {}): Promise<T> {
		this.signal.throwIfAborted();
		adapter ??= await readFile(new URL("../dist/page-adapter.js", import.meta.url), "utf8");
		const wire = await this.tab.evaluate<{ data?: T; error?: { code: string; message: string; hint?: string } }>(
			`(() => {\n${adapter}\nreturn DouyinPage.call(${JSON.stringify(operation)}, ${JSON.stringify(args)});\n})()`,
		);
		if (wire.error) throw new CliError(wire.error.code, wire.error.message, { hint: wire.error.hint });
		return wire.data as T;
	}

	async status(): Promise<Snapshot> {
		return this.call<Snapshot>("status");
	}
	async click(point: Point): Promise<void> {
		if (point.already) return;
		// The page measured this control and marked it, so the press can be aimed
		// at the element rather than at a coordinate measured in an earlier frame.
		// A header that renders or settles between measuring and pressing moves the
		// control out from under the coordinate, and the press then lands on
		// whatever slid into place — a follower count beside the follow button, or
		// nothing at all. Locator clicks re-check the position at press time.
		if (point.selector) {
			await this.tab
				.locator(point.selector)
				.click({ timeout: 5000 })
				.catch(async (error: unknown) => {
					// The element can be covered by an overlay Playwright refuses to click
					// through. Reporting that is better than silently falling back to the
					// coordinate path, which is what the retry is meant to replace.
					throw new CliError("selector_changed", "The marked control could not be clicked", { cause: error });
				});
			return;
		}
		if (point.x === undefined || point.y === undefined)
			throw new CliError("selector_changed", "No verified click point");
		await this.tab.mouse.click(point.x, point.y);
	}
	async close(): Promise<void> {
		this.signal.removeEventListener("abort", this.aborted);
		await this.browser.close().catch(() => undefined);
	}
}
