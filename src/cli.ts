#!/usr/bin/env node
import { run } from "./main.ts";

// A reader that stops early — `dy --version | head -1`, or any pipeline whose
// consumer exits — closes the pipe, and the next write raises EPIPE. Node's
// default is to rethrow it as an unhandled error event, which turns a perfectly
// normal `head` into a crash with a stack trace and a nonzero exit. Written output
// that nobody is left to read is not a failure of the command.
process.stdout.on("error", (error: NodeJS.ErrnoException) => {
	if (error.code === "EPIPE") process.exit(0);
	throw error;
});

const controller = new AbortController();
const cancel = () => controller.abort(new DOMException("Operation cancelled", "AbortError"));
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);
try {
	process.exitCode = await run(process.argv.slice(2), undefined, controller.signal);
} finally {
	process.removeListener("SIGINT", cancel);
	process.removeListener("SIGTERM", cancel);
}
