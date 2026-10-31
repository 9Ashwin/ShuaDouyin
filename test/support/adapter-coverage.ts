import { writeFileSync } from "node:fs";
import type { Page } from "playwright-core";

// Precise V8 coverage for the code dy injects into the page.
//
// src/page/ is bundled into dist/page-adapter.js and sent to the browser as a
// string, so from Node it is data. Node's coverage report therefore shows every
// function in it at 0%, which is indistinguishable from code that is never
// called. The only place that knows what ran is the browser itself.
//
// Coverage is collected per operation rather than for the whole run, so a reader
// path that only ever ran one branch shows up as one range with a count and
// several without. That is the signal worth acting on: a range at 0 is a branch
// no test has ever taken.
//
// This is opt-in. Taking coverage changes nothing about what the page does, but
// it does add a CDP session per measured call, so the ordinary test run does not
// pay for it.

const BUNDLE = "dist/page-adapter.js";

interface Range {
	startOffset: number;
	endOffset: number;
	count: number;
}

export interface AdapterFunction {
	name: string;
	start: number;
	end: number;
	/** Lines in the bundle this function occupies. */
	lines: number;
	/** Ranges within it that ran at least once, over how many there are. */
	hit: number;
	total: number;
	/** Fraction of the function's ranges that executed. */
	coverage: number;
}

export class AdapterCoverage {
	private readonly ranges = new Map<string, Range[]>();
	private readonly bundle: string;
	private session: { send: (method: string, params?: object) => Promise<unknown> } | null = null;

	constructor(bundle: string) {
		this.bundle = bundle;
	}

	async start(context: { newCDPSession: (page: Page) => Promise<unknown> }, page: Page): Promise<void> {
		const cdp = await context.newCDPSession(page);
		await (cdp as { send: (method: string, params?: object) => Promise<unknown> }).send("Profiler.enable");
		await (cdp as { send: (method: string, params?: object) => Promise<unknown> }).send(
			"Profiler.startPreciseCoverage",
			{
				callCount: true,
				detailed: true,
			},
		);
		this.session = cdp as { send: (method: string, params?: object) => Promise<unknown> };
	}

	/**
	 * Merge the ranges reported since the last call into the running set. The
	 * browser reports every script it has loaded, so only the adapter bundle's own
	 * url is kept — and the injected script has no url, which is why its source
	 * is matched instead.
	 */
	async collect(): Promise<void> {
		if (!this.session) return;
		const result = (await this.session.send("Profiler.takePreciseCoverage")) as {
			result: { url: string; functions: { functionName: string; ranges: Range[] }[] }[];
		};
		for (const script of result.result) {
			// The injected script carries a sourceURL comment naming it; anything else
			// the page loaded is the page's own code and is not what this measures.
			if (process.env.DY_COVER_DEBUG)
				console.error("script url:", JSON.stringify(script.url), "functions:", script.functions.length);
			if (!script.url.includes("dy-page-adapter.js")) continue;
			for (const fn of script.functions) {
				const existing = this.ranges.get(fn.functionName) ?? [];
				existing.push(...fn.ranges);
				this.ranges.set(fn.functionName, existing);
			}
		}
	}

	/** Functions that never appear in the report at all, alongside their hit rate. */
	functions(): AdapterFunction[] {
		const found: AdapterFunction[] = [];
		// esbuild does not start every declaration at a line boundary — a function
		// can follow another on the same line — so the match is not anchored and the
		// next `function` keyword, wherever it sits, ends this one.
		for (const base of [...this.bundle.matchAll(/\bfunction ([A-Za-z0-9_]+)\s*\(/g)]) {
			const name = base[1] ?? "";
			const start = base.index ?? 0;
			const next = this.bundle.indexOf("function ", start + 1);
			const end = next === -1 ? this.bundle.length : next;
			const collected = this.ranges.get(name) ?? [];
			const inSpan = collected.filter((range) => range.startOffset >= start && range.startOffset < end);
			const hit = inSpan.filter((range) => range.count > 0).length;
			found.push({
				name,
				start,
				end,
				lines: this.bundle.slice(start, end).split("\n").length,
				hit,
				total: inSpan.length,
				coverage: inSpan.length === 0 ? 0 : hit / inSpan.length,
			});
		}
		return found;
	}

	/** A branch inside a function that never ran, as a line in the bundle. */
	uncoveredBranches(name: string): number[] {
		const collected = this.ranges.get(name) ?? [];
		const lines: number[] = [];
		const starts = [0];
		for (let index = 0; index < this.bundle.length; index++) if (this.bundle[index] === "\n") starts.push(index + 1);
		const lineOf = (offset: number) => {
			let low = 0;
			let high = starts.length - 1;
			while (low < high) {
				const middle = Math.ceil((low + high) / 2);
				if ((starts[middle] ?? 0) <= offset) low = middle;
				else high = middle - 1;
			}
			return low + 1;
		};
		for (const range of collected) if (range.count === 0) lines.push(lineOf(range.startOffset));
		return [...new Set(lines)].sort((left, right) => left - right);
	}

	async stop(): Promise<void> {
		if (!this.session) return;
		await this.session.send("Profiler.stopPreciseCoverage").catch(() => undefined);
		await this.session.send("Profiler.disable").catch(() => undefined);
		this.session = null;
	}

	/** Write the report where a person can read it after the run. */
	writeReport(path: string): void {
		const rows = this.functions()
			.filter((entry) => entry.total > 0)
			.sort((left, right) => left.coverage - right.coverage || right.lines - left.lines);
		const payload = rows.map((entry) => ({
			name: entry.name,
			lines: entry.lines,
			hit: entry.hit,
			total: entry.total,
			coverage: Number(entry.coverage.toFixed(3)),
			uncovered_branches: this.uncoveredBranches(entry.name),
		}));
		writeFileSync(path, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
	}
}

export { BUNDLE };
