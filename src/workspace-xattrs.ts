import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";
import { CliError } from "./errors.ts";

const execute = promisify(execFile);
interface Attribute {
	name: string;
	hash: string;
}

async function command(args: string[], signal?: AbortSignal): Promise<string> {
	try {
		const result = await execute("/usr/bin/xattr", args, { encoding: "utf8", maxBuffer: 1024 * 1024, signal });
		return result.stdout;
	} catch (cause) {
		signal?.throwIfAborted();
		throw new CliError("state_corrupt", "Cannot inspect or preserve extended file attributes", { cause });
	}
}
async function hex(path: string, name: string, signal?: AbortSignal): Promise<string> {
	const value = (await command(["-p", "-x", name, path], signal)).replace(/\s/g, "");
	if (!/^(?:[0-9A-Fa-f]{2})*$/.test(value) || value.length > 120000)
		throw new CliError("state_corrupt", "Unsupported extended file attribute size or encoding");
	return value.toLowerCase();
}
export async function attributes(path: string, signal?: AbortSignal): Promise<Attribute[]> {
	if (process.platform !== "darwin") return [];
	try {
		const { stdout } = await execute("/bin/ls", ["-lde", path], { encoding: "utf8", maxBuffer: 1024 * 1024, signal });
		if (stdout.slice(0, 11).includes("+") || /^\s+\d+:\s/m.test(stdout))
			throw new CliError("state_corrupt", "Workspace contains a macOS ACL which cannot be preserved automatically");
	} catch (cause) {
		signal?.throwIfAborted();
		if (cause instanceof CliError) throw cause;
		throw new CliError("state_corrupt", "Cannot inspect workspace access control", { cause });
	}
	const names = (await command([path], signal)).split("\n").filter(Boolean).sort();
	const result: Attribute[] = [];
	for (const name of names) {
		const value = await hex(path, name, signal);
		result.push({ name, hash: createHash("sha256").update(value).digest("hex") });
	}
	return result;
}
export async function copyAttributes(source: string, target: string, signal?: AbortSignal): Promise<void> {
	if (process.platform !== "darwin") return;
	const expected = await attributes(source, signal);
	const existing = await attributes(target, signal);
	for (const item of existing) {
		if (!expected.some((candidate) => candidate.name === item.name && candidate.hash === item.hash))
			throw new CliError("state_corrupt", "Migration staging has conflicting extended attributes");
	}
	for (const item of expected) {
		if (existing.some((candidate) => candidate.name === item.name)) continue;
		await command(["-w", "-x", item.name, await hex(source, item.name, signal), target], signal);
	}
}
