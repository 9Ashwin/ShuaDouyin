#!/usr/bin/env node
import { run } from "./main.ts";

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
