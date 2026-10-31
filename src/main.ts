import { readFile } from "node:fs/promises";
import { Command, CommanderError, InvalidArgumentError, Option } from "commander";
import { App, type AppOptions, type Input } from "./app.ts";
import { COMMANDS, type CommandSpec, GLOBAL_FLAGS, GROUPS, schema } from "./catalog.ts";
import { CliError, errorData, errorExit, normalizeError } from "./errors.ts";
import { progressTo } from "./progress.ts";
import { stateDirectory } from "./store.ts";
import { runTui } from "./tui.ts";
import { updateNotice } from "./version-notice.ts";

export interface Streams {
	stdout: { write: (text: string) => unknown };
	stderr: { write: (text: string) => unknown };
}
interface Globals {
	profile?: string;
	bot?: string;
	stateDir?: string;
	chrome?: string;
	format: string;
	timeout: number;
	requestId?: string;
	dryRun?: boolean;
	progress?: boolean;
}

function number(value: string): number {
	if (!value.trim() || !Number.isFinite(Number(value))) throw new InvalidArgumentError("Expected a finite number");
	return Number(value);
}
function boolean(value: string): boolean {
	if (value !== "true" && value !== "false") throw new InvalidArgumentError("Expected true or false");
	return value === "true";
}
function display(value: string): boolean {
	if (value !== "headed" && value !== "headless") throw new InvalidArgumentError("Expected headed or headless");
	return value === "headless";
}

export function createProgram(io: Streams, parentSignal?: AbortSignal, version = ""): Command {
	const root = new Command("dy");
	root.description("Douyin capabilities for agents, with an optional terminal UI");
	// `--version` is the one command whose whole answer is the version, so it is
	// where a newer release is most likely to be asked about — and where a plain
	// number told the owner nothing. It stays a presentation exception (help,
	// version and the TUI are the documented ones), so the notice is a second line
	// rather than a JSON envelope; scripts that read the first line still get what
	// they got before. `dy update --check` is still the machine-readable form.
	root.version(version, "-v, --version", "Print the version, and say if a newer release exists");
	root.addHelpText(
		"after",
		"\nRun `dy update --check` for install shape, the commit this build came from, and the newest release as JSON.",
	);
	root.exitOverride().showHelpAfterError(false);
	root.configureOutput({
		writeOut: (value) => io.stdout.write(value),
		writeErr: () => undefined,
		outputError: () => undefined,
	});
	for (const flag of GLOBAL_FLAGS) {
		const option = new Option(flag.name, flag.description);
		if ("default" in flag) option.default(flag.default);
		if (flag.name.startsWith("--timeout")) option.argParser(number);
		root.addOption(option);
	}
	const options = (command: Command): { app: AppOptions; globals: Globals } => {
		const globals = command.optsWithGlobals<Globals>();
		if (!["json", "pretty"].includes(globals.format))
			throw new CliError("invalid_argument", "--format must be json or pretty");
		if (!Number.isFinite(globals.timeout) || globals.timeout < 0.1 || globals.timeout > 3600)
			throw new CliError("invalid_argument", "--timeout must be 0.1..3600 seconds");
		return {
			globals,
			app: {
				bot: globals.bot,
				profile: globals.profile,
				state_dir: globals.stateDir,
				chrome: globals.chrome,
				timeout: globals.timeout * 1000,
			},
		};
	};
	const output = (data: unknown, globals: Globals) =>
		io.stdout.write(
			`${JSON.stringify({ ok: true, ...(globals.dryRun ? { dry_run: true } : {}), data }, null, globals.format === "pretty" ? 2 : undefined)}\n`,
		);
	const groups = new Map<string, Command>();
	for (const spec of COMMANDS) {
		const [group, leaf] = spec.id.split(".");
		let owner = root;
		if (leaf) {
			let command = groups.get(group);
			if (!command) {
				command = root.command(group).description(GROUPS[group] ?? `${group} operations`);
				// A bare group name is a request to see what is in it. Without an
				// action Commander treats it as a usage error and exits through
				// `help({error:true})`, whose message is the placeholder
				// `(outputHelp)` — so `dy memory` printed nothing and reported a
				// validation failure naming an internal function.
				command.action((_local: unknown, self: Command) => self.help());
				groups.set(group, command);
			}
			owner = command;
		}
		const command = owner.command(leaf ?? group).description(spec.description);
		if (spec.argument)
			command.argument(
				spec.argument.optional ? `[${spec.argument.name}]` : `<${spec.argument.name}>`,
				spec.argument.description,
			);
		for (const flag of spec.flags ?? []) {
			const option = new Option(flag.name, flag.description);
			if (flag.default !== undefined) option.default(flag.default);
			if (flag.required) option.makeOptionMandatory();
			if (flag.type === "number") option.argParser(number);
			if (flag.type === "boolean-value") option.argParser(flag.key === "headless" ? display : boolean);
			command.addOption(option);
		}
		if (spec.guidance) command.addHelpText("after", `\n${spec.guidance}\n${(spec.examples ?? []).join("\n")}`);
		command.action(async (...values: unknown[]) => {
			const { app: appOptions, globals } = options(command);
			const input: Input = { dry_run: globals.dryRun, request_id: globals.requestId };
			const local = command.opts<Record<string, unknown>>();
			// Which flags the caller actually typed, as opposed to the defaults the
			// catalog fills in. Resuming a round has to tell "the caller wants thirty
			// works" from "commander put thirty here because nothing was said", or a
			// resumed five-minute round quietly becomes a thirty-minute one.
			const stated: string[] = [];
			for (const flag of spec.flags ?? []) {
				const option = new Option(flag.name);
				const value = local[option.attributeName()];
				if (value === undefined) continue;
				Object.assign(input, { [flag.key]: value });
				if (command.getOptionValueSource(option.attributeName()) === "cli") stated.push(flag.key);
			}
			if (stated.length) Object.assign(input, { _stated: stated });
			if (spec.argument) Object.assign(input, { [spec.argument.key]: values[0] });
			const signal = AbortSignal.any([
				...(parentSignal ? [parentSignal] : []),
				AbortSignal.timeout(appOptions.timeout ?? 45000),
			]);
			// Progress goes to stderr so stdout keeps exactly one envelope. It is
			// opt-in: a pipeline that parses stdout should not have to filter lines
			// out of it, and a caller that wants to show "posting…" needs to see the
			// steps while they happen rather than after they finish.
			const app = new App(
				globals.progress ? { ...appOptions, progress: progressTo((line) => io.stderr.write(line)) } : appOptions,
			);
			try {
				output(await app.execute(spec.id, input, signal), globals);
			} catch (error) {
				if (
					signal.aborted &&
					!(
						error instanceof CliError &&
						(["delivery_uncertain", "decision_uncertain", "migration_pending"].includes(error.code) ||
							(spec.id === "video.observe" && ["timeout", "cancelled"].includes(error.code) && !!error.details))
					)
				)
					throw signal.reason;
				throw error;
			}
		});
	}
	root
		.command("schema")
		.description("Describe commands, flags, effects and output contracts as JSON")
		.argument("[command...]", "Command path, e.g. comment post")
		.action((path: string[], _local: unknown, command: Command) => {
			const { globals } = options(command);
			const result = schema(path.length ? path.join(".") : undefined);
			if (!result.commands.length) throw new CliError("invalid_argument", "Unknown schema command");
			output(result, globals);
		});
	root
		.command("tui")
		.description("Open the interactive terminal interface")
		.action(async (_local: unknown, command: Command) => {
			const { app, globals } = options(command);
			if (globals.dryRun) throw new CliError("invalid_argument", "TUI cannot run in dry-run mode");
			if (!process.stdin.isTTY || !process.stdout.isTTY)
				throw new CliError("invalid_argument", "TUI requires an interactive terminal", {
					hint: "Use ordinary commands with JSON output from an agent or pipeline.",
				});
			await runTui(app, parentSignal);
		});
	root.action(() => root.help());
	return root;
}

export async function run(
	args: string[],
	io: Streams = { stdout: process.stdout, stderr: process.stderr },
	signal?: AbortSignal,
): Promise<number> {
	try {
		// `--version` is answered here rather than by commander so the answer can
		// include a newer release. Commander's own handler is synchronous and writes
		// the string it was given, so the check could not run inside it.
		//
		// The first line is the version and nothing else, which is what every caller
		// that parses this already reads. The notice is a second line, and it only
		// appears when there is something to say.
		if (args.length === 1 && (args[0] === "--version" || args[0] === "-V")) {
			const version = await packageVersion();
			io.stdout.write(`${version}\n`);
			const update = await updateNotice(stateDirectory(), { timeoutMs: 2000 }).catch(() => null);
			if (update && typeof update === "object" && "message" in update)
				io.stdout.write(`${String((update as { message: unknown }).message)}\n`);
			return 0;
		}
		await createProgram(io, signal, await packageVersion()).parseAsync(args, { from: "user" });
		return 0;
	} catch (error) {
		if (error instanceof CommanderError && error.exitCode === 0) return 0;
		const problem =
			error instanceof CommanderError ? new CliError("invalid_argument", error.message) : normalizeError(error);
		io.stderr.write(`${JSON.stringify({ ok: false, error: errorData(problem) })}\n`);
		return errorExit(problem);
	}
}

// Kept separate from argument parsing so packaging tests can verify the published bin.
export async function packageVersion(): Promise<string> {
	const data: unknown = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
	return typeof data === "object" && data !== null && "version" in data ? String(data.version) : "";
}

export function commandByID(id: string): CommandSpec | undefined {
	return COMMANDS.find((command) => command.id === id);
}
