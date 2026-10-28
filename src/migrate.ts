import { existsSync } from "node:fs";
import { mkdir, readdir, rename, rmdir, stat } from "node:fs/promises";
import { join } from "node:path";

// Earlier builds kept two levels of nesting: an account directory holding the
// browser session and the operation log, and inside it a bot directory holding
// the persona and the memories. One installation is now exactly one workspace,
// so both levels flatten into the state root. Anything already at the root wins:
// a half-migrated tree must never be silently overwritten.
const BOT_ENTRIES = [
	"AGENTS.md",
	"PROFILES.md",
	"MEMORY.md",
	"memory",
	"reports",
	"onboarding.json",
	"growth.json",
	"decisions",
	"observations",
];
const ACCOUNT_ENTRIES = ["history.jsonl", "receipts.json", "browser.json", "chrome", "captures", "config.json"];

export interface Migration {
	moved: string[];
	skipped: string[];
	from: string | null;
}

async function present(path: string): Promise<boolean> {
	try {
		await stat(path);
		return true;
	} catch {
		return false;
	}
}

// A directory that still holds anything is not ours to remove; an empty one is.
async function pruneEmpty(path: string): Promise<void> {
	try {
		const entries = await readdir(path);
		if (entries.length) return;
		await rmdir(path);
	} catch {
		return;
	}
}

export async function migrateLegacyLayout(base: string): Promise<Migration> {
	const account = join(base, "profiles", "default");
	const bot = join(account, "bots", "default");
	if (!existsSync(account) && !existsSync(bot)) return { moved: [], skipped: [], from: null };
	if (!existsSync(account)) return { moved: [], skipped: [], from: null };
	await mkdir(base, { recursive: true, mode: 0o700 });
	const moved: string[] = [];
	const skipped: string[] = [];
	const carry = async (source: string, name: string) => {
		const target = join(base, name);
		if (!(await present(source))) return;
		if (await present(target)) {
			skipped.push(name);
			return;
		}
		await rename(source, target);
		moved.push(name);
	};
	// The bot directory is the workspace itself; the account directory holds the
	// session and the log that belong to the same workspace.
	for (const name of ACCOUNT_ENTRIES) await carry(join(account, name), name);
	for (const name of BOT_ENTRIES) await carry(join(bot, name), name);
	await pruneEmpty(join(account, "bots"));
	await pruneEmpty(account);
	await pruneEmpty(join(base, "profiles"));
	// A name present in both places is left alone rather than replaced: the root
	// copy is the one the running build already reads. It is reported so the
	// caller can look at it instead of discovering the difference later.
	return { moved, skipped, from: account };
}
