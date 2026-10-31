import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// CRAP = complexity^2 * (1 - coverage)^3 + complexity
//
// Complexity alone ranks a long dispatcher above a small function with one
// branch, which is backwards: a dispatcher's branches are one line each and are
// tested through the operations they forward to. Coverage is what makes the rank
// actionable — a branchy function nothing exercises is the problem, and a branchy
// function that is fully covered is not a problem at all.
//
// Usage: node scripts/crap.ts [--test <file>...] [--top N]
// With no --test the whole suite runs. The coverage run is real: it executes the
// tests, so a long run is expected rather than a hang.

const ROOT = new URL("..", import.meta.url).pathname;

interface Row {
	file: string;
	name: string;
	line: number;
	lines: number;
	complexity: number;
	coverage: number;
	crap: number;
}

function walk(dir: string): string[] {
	return readdirSync(dir).flatMap((entry) => {
		const full = join(dir, entry);
		return statSync(full).isDirectory() ? walk(full) : [full];
	});
}

// Each decision point is one path. `else` alone is not counted: it is the other
// half of an `if` that already added one.
function complexityOf(body: string): number {
	const decisions = body.match(/\b(if|for|while|catch|case)\b|\?\?|\|\||&&|\?\.|\?\s*[^:\s]/g) ?? [];
	return decisions.length + 1;
}

interface Fn {
	name: string;
	line: number;
	lines: number;
	complexity: number;
	startLine: number;
	endLine: number;
	startOffset: number;
	endOffset: number;
}

function functionsIn(file: string): Fn[] {
	const text = readFileSync(file, "utf8");
	const source = text.split("\n");
	const offsets: number[] = [0];
	for (let index = 0; index < text.length; index++) if (text[index] === "\n") offsets.push(index + 1);
	const found: Fn[] = [];
	let name: string | null = null;
	let start = 0;
	let depth = 0;
	for (let index = 0; index < source.length; index++) {
		const line = source[index] ?? "";
		if (name === null) {
			const match =
				/^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)/.exec(line) ??
				/^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*(?::[^=]+)?=\s*(?:async\s*)?\(/.exec(line);
			if (match && line.trimEnd().endsWith("{")) {
				name = match[1] ?? null;
				start = index;
				depth = 1;
			}
			continue;
		}
		depth += (line.match(/\{/g) ?? []).length - (line.match(/\}/g) ?? []).length;
		if (depth > 0) continue;
		found.push({
			name,
			line: start + 1,
			lines: index - start + 1,
			complexity: complexityOf(source.slice(start + 1, index).join("\n")),
			startLine: start + 1,
			endLine: index + 1,
			startOffset: offsets[start] ?? 0,
			endOffset: offsets[index + 1] ?? text.length,
		});
		name = null;
	}
	return found;
}

interface V8Function {
	functionName: string;
	ranges: { startOffset: number; endOffset: number; count: number }[];
}

// A line is covered when any executing range contains its first character. V8
// reports nested ranges, so the ranges are flattened rather than searched.
function coveredLines(entry: { functions: V8Function[] } | undefined, text: string): Set<number> {
	const covered = new Set<number>();
	if (!entry) return covered;
	// Precompute line starts once per file, then binary-search the offset.
	const starts: number[] = [0];
	for (let index = 0; index < text.length; index++) if (text[index] === "\n") starts.push(index + 1);
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
	for (const fn of entry.functions)
		for (const range of fn.ranges)
			if (range.count > 0) {
				const first = lineOf(range.startOffset);
				const last = lineOf(Math.max(range.startOffset, range.endOffset - 1));
				for (let line = first; line <= last; line++) covered.add(line);
			}
	return covered;
}

function main(): void {
	const args = process.argv.slice(2);
	const topIndex = args.indexOf("--top");
	const top = topIndex === -1 ? 20 : Number(args[topIndex + 1] ?? 20);
	const testIndex = args.indexOf("--test");
	const tests =
		testIndex === -1 ? [] : args.slice(testIndex + 1).filter((value) => value !== "--top" && !/^\d+$/.test(value));
	const coverageDir = join(tmpdir(), `dy-crap-${process.pid}`);
	rmSync(coverageDir, { recursive: true, force: true });
	mkdirSync(coverageDir, { recursive: true });
	const testFiles = tests.length ? tests : walk(join(ROOT, "test")).filter((file) => file.endsWith(".test.ts"));
	console.log(`running ${testFiles.length} test file(s) under coverage...`);
	execFileSync(
		process.execPath,
		["--experimental-strip-types", "--test", ...testFiles.map((file) => relative(ROOT, file))],
		{
			cwd: ROOT,
			env: { ...process.env, NODE_V8_COVERAGE: coverageDir },
			stdio: "ignore",
		},
	);
	const merged = new Map<string, { functions: V8Function[] }>();
	for (const name of readdirSync(coverageDir).filter((file) => file.endsWith(".json"))) {
		const report = JSON.parse(readFileSync(join(coverageDir, name), "utf8")) as {
			result: { url: string; functions: V8Function[] }[];
		};
		for (const entry of report.result) {
			if (!entry.url.startsWith("file://")) continue;
			const existing = merged.get(entry.url);
			if (existing) existing.functions.push(...entry.functions);
			else merged.set(entry.url, { functions: [...entry.functions] });
		}
	}
	const files = walk(join(ROOT, "src")).filter((file) => file.endsWith(".ts"));
	const rows: Row[] = [];
	for (const file of files) {
		const url = `file://${file}`;
		const text = readFileSync(file, "utf8");
		const covered = coveredLines(merged.get(url), text);
		for (const fn of functionsIn(file)) {
			let hit = 0;
			for (let line = fn.startLine; line <= fn.endLine; line++) if (covered.has(line)) hit++;
			const ratio = fn.lines === 0 ? 0 : hit / fn.lines;
			rows.push({
				file: relative(ROOT, file),
				name: fn.name,
				line: fn.line,
				lines: fn.lines,
				complexity: fn.complexity,
				coverage: ratio,
				crap: fn.complexity ** 2 * (1 - ratio) ** 3 + fn.complexity,
			});
		}
	}
	rows.sort((left, right) => right.crap - left.crap);
	console.log(`\n${"CRAP".padStart(8)}  ${"cx".padStart(5)}  ${"cover".padStart(6)}  ${"lines".padStart(5)}  function`);
	for (const row of rows.slice(0, top))
		console.log(
			`${row.crap.toFixed(1).padStart(8)}  ${String(row.complexity).padStart(5)}  ${(row.coverage * 100).toFixed(0).padStart(5)}%  ${String(row.lines).padStart(5)}  ${row.file}::${row.name}`,
		);
	const over = rows.filter((row) => row.crap > 10);
	console.log(`\nover CRAP 10: ${over.length} of ${rows.length} functions`);
	// src/page/ is injected into the running page as a string and executed there,
	// so Node's coverage never sees it. Reporting it at 0% would put a dispatcher
	// and a genuinely dead function in the same column. Its real coverage comes
	// from test/browser.test.ts, run separately with the browser.
	const injected = over.filter((row) => row.file.startsWith("src/page/")).length;
	if (injected) console.log(`  of which ${injected} are in src/page/, which Node coverage cannot measure`);
	rmSync(coverageDir, { recursive: true, force: true });
}

main();
