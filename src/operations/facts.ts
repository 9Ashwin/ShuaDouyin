import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../errors.ts";

// Fixture coverage is measured, not assumed. A selector this project uses but
// the fixture does not contain cannot be caught by any test that passes — which
// is how six defects reached the real page with the suite green.

export interface PageFacts {
	page_kind: string;
	url: string;
	collected_at: string;
	markers: { selector: string; count: number; visible: number }[];
}

export function factsComparison(
	facts: { markers: string[] },
	used: string[],
): { matched: string[]; absent_here: string[]; unused_by_code: string[] } {
	const page = new Set(facts.markers);
	const code = new Set(used);
	return {
		matched: used.filter((selector) => page.has(selector)).sort(),
		// Selectors the code uses that this page does not have. Most of these are
		// simply other pages — the comment markers do not exist on the feed. The
		// list is a lead, not a verdict: what matters is a selector that should be
		// here and is not.
		absent_here: used.filter((selector) => !page.has(selector)).sort(),
		// Selectors the page offers that nothing here uses: a capability the page
		// has and this adapter does not read.
		unused_by_code: facts.markers.filter((selector) => !code.has(selector)).sort(),
	};
}

// The selectors the page adapter actually references. Read from source rather
// than maintained by hand: a list kept separately drifts from the code it
// describes, and then the measurement is of the list.
export async function selectorsInSource(source: string): Promise<string[]> {
	// The built adapter is the honest source: it is the exact text that runs
	// inside the page. Reading the TypeScript would measure what was written,
	// not what shipped.
	const built = await readFile(join(source, "dist/page-adapter.js"), "utf8").catch(() => null);
	if (!built) throw new CliError("not_found", "No built page adapter to read", { hint: "Run pnpm build first." });
	const found = new Set<string>();
	for (const match of built.matchAll(/data-e2e=\\?"([^"\\]+)/g)) found.add(match[1]);
	return [...found].sort();
}

export async function pageFactsRead(session: { call: <T>(op: string, args?: object) => Promise<T> }, source: string) {
	const facts = await session.call<{
		url: string;
		title: string;
		markers: { selector: string; count: number; visible: number }[];
	}>("page.facts", {});
	const used = await selectorsInSource(source);
	const comparison = factsComparison({ markers: facts.markers.map((marker) => marker.selector) }, used);
	return {
		url: facts.url,
		title: facts.title,
		collected_at: new Date().toISOString(),
		markers: facts.markers,
		code_selectors: used.length,
		page_markers: facts.markers.length,
		...comparison,
		limitations: [
			"Only markers present in this page are reported; a selector missing here may exist on another page.",
			"Page structure changes between builds, so a snapshot describes one moment.",
			"Reading is local and changes nothing.",
		],
	};
}
