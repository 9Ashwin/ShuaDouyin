import type { Dirent } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

// What is safe to delete, and why each one is safe.
//
// The state directory grows without bound, and the growth is not the bot's data:
// on a machine used for a few days it was 1.5G, of which 1.2G was Chrome's HTTP
// cache and 104M was screenshots. Neither is anything a caller would miss, and
// neither is ever pruned — Chrome keeps a cache until it decides otherwise, and a
// capture is evidence for a decision made once and then never read again.
//
// The split matters more than the numbers. Anything that holds a login, a memory
// or a receipt is never in this list: those are what a reset exists to protect,
// and a cleanup command that could take them would be a reset with a friendlier
// name.

export interface Reclaimable {
	// Path relative to the state directory.
	path: string;
	// What it is, in the words a caller can act on.
	what: string;
	// Why deleting it does not lose anything.
	why: string;
	bytes: number;
	files: number;
}

// Chrome writes its HTTP and code caches under the profile. Removing them costs
// the next page load a little time and nothing else: the login lives in Cookies
// and Login Data, which are separate files.
const CHROME_CACHES = [
	{
		path: join("chrome", "Default", "Cache"),
		what: "Chrome HTTP cache",
		why: "Rebuilt on the next page load; the login is in Cookies, not here.",
	},
	{
		path: join("chrome", "Default", "Code Cache"),
		what: "Chrome code cache",
		why: "Compiled scripts; rebuilt on the next visit.",
	},
	{
		path: join("chrome", "Default", "GPUCache"),
		what: "Chrome GPU cache",
		why: "Shader cache; rebuilt automatically.",
	},
	{ path: join("chrome", "GraphiteDawnCache"), what: "Chrome graphics cache", why: "Rebuilt automatically." },
	{ path: join("chrome", "ShaderCache"), what: "Chrome shader cache", why: "Rebuilt automatically." },
	{
		path: join("chrome", "component_crx_cache"),
		what: "Chrome component cache",
		why: "Downloaded components; fetched again when needed.",
	},
	{
		path: join("chrome", "optimization_guide_model_store"),
		what: "Chrome optimisation models",
		why: "Bundled models; downloaded again when needed.",
	},
	{ path: join("chrome", "WasmTtsEngine"), what: "Chrome speech engine", why: "Optional TTS data; not used by dy." },
];

// Captures are screenshots taken to justify one decision — a frame from a work, an
// image sent as a comment. The decision is already recorded with its source, so the
// picture is a working file rather than a record.
const CAPTURES = {
	path: "captures",
	what: "Screenshots and sampled frames",
	why: "Working files for decisions already recorded; the events keep the source.",
};

async function measure(path: string): Promise<{ bytes: number; files: number }> {
	let bytes = 0;
	let files = 0;
	const walk = async (current: string): Promise<void> => {
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			const full = join(current, entry.name);
			try {
				if (entry.isDirectory()) await walk(full);
				else {
					const info = await stat(full);
					bytes += info.size;
					files++;
				}
			} catch {
				// A file that vanished mid-walk is already gone.
			}
		}
	};
	const info = await stat(path).catch(() => null);
	if (!info) return { bytes: 0, files: 0 };
	if (info.isFile()) return { bytes: info.size, files: 1 };
	await walk(path);
	return { bytes, files };
}

export async function inspect(root: string): Promise<Reclaimable[]> {
	const found: Reclaimable[] = [];
	for (const entry of [...CHROME_CACHES, CAPTURES]) {
		const path = join(root, entry.path);
		const size = await measure(path);
		if (!size.files) continue;
		found.push({ path: entry.path, what: entry.what, why: entry.why, ...size });
	}
	return found.sort((left, right) => right.bytes - left.bytes);
}

export interface Reclaimed {
	path: string;
	// Carried through so a caller reading the result knows what each line is and
	// why removing it was safe, not just how big it was.
	what: string;
	why: string;
	bytes: number;
	files: number;
	removed: boolean;
}

export async function clean(root: string, options: { write: boolean }): Promise<{ items: Reclaimed[]; freed: number }> {
	const targets = await inspect(root);
	const items: Reclaimed[] = [];
	let freed = 0;
	for (const target of targets) {
		let removed = false;
		if (options.write) {
			removed = await rm(join(root, target.path), { recursive: true, force: true }).then(
				() => true,
				() => false,
			);
			if (removed) freed += target.bytes;
		}
		items.push({
			path: target.path,
			what: target.what,
			why: target.why,
			bytes: target.bytes,
			files: target.files,
			removed,
		});
	}
	return { items, freed };
}

// The one thing a caller has to know before running this: what is never touched.
export const CLEAN_LIMITS =
	"Never removed: Cookies, Login Data, Local Storage, IndexedDB, the event log, receipts, memories, the persona and snapshots. Those hold the login and the record of what this bot did, and no cleanup touches them. Run with --dry-run to see the sizes first; nothing is deleted without --apply.";

// Cleaning without being asked.
//
// A cleanup command nobody runs does not solve an unbounded directory. This runs
// from the browser lifecycle instead: before Chrome starts, if the caches and
// captures together exceed a threshold, they are removed. It runs at that moment
// because a running Chrome rewrites the caches it holds open, so cleaning earlier
// frees less and can confuse it.
//
// The threshold is deliberately high. Chrome's cache is meant to be large — that is
// what makes browsing fast — and clearing it on every start would trade a real
// benefit for a number. This is for the case the user reported: a directory that
// reached a gigabyte and a half without anyone noticing.

export const AUTO_CLEAN_BYTES = 512 * 1024 * 1024;

export interface AutoClean {
	ran: boolean;
	freed: number;
	reason: string;
}

export async function cleanIfLarge(root: string): Promise<AutoClean> {
	const targets = await inspect(root);
	const total = targets.reduce((sum, target) => sum + target.bytes, 0);
	if (total < AUTO_CLEAN_BYTES)
		return {
			ran: false,
			freed: 0,
			reason: `${Math.round(total / 1024 / 1024)}MB of reclaimable files is under the ${AUTO_CLEAN_BYTES / 1024 / 1024}MB threshold`,
		};
	const result = await clean(root, { write: true });
	return {
		ran: true,
		freed: result.freed,
		reason: `Reclaimed ${Math.round(result.freed / 1024 / 1024)}MB from caches and captures before Chrome started. The login and the record are untouched.`,
	};
}
