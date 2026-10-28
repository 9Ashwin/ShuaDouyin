import { lstatSync } from "node:fs";
import { join } from "node:path";
import { CliError, isMissing } from "./errors.ts";

// One installation, one profile. The state root holds the browser session, the
// operation log and the receipts directly, and the single bot workspace sits
// beside them, so there is no account or bot nesting to resolve.
function info(path: string) {
	try {
		return lstatSync(path);
	} catch (error) {
		if (isMissing(error)) return undefined;
		throw error;
	}
}

export function botRoot(base: string): string {
	return base;
}

export function botLock(base: string): string {
	return join(base, ".operation");
}

// Ancestors must be directories rather than aliases outside the state root.
export function checkStateRoot(base: string): void {
	const item = info(base);
	if (item && (!item.isDirectory() || item.isSymbolicLink()))
		throw new CliError("state_corrupt", "State root must be a regular directory");
}

export function workspacePath(base: string): string {
	checkStateRoot(base);
	const current = info(base);
	if (!current || !current.isDirectory() || current.isSymbolicLink())
		throw new CliError("state_corrupt", "Workspace must be a regular directory");
	return base;
}
