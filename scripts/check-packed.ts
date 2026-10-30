#!/usr/bin/env node
// What will actually be inside the published tarball.
//
// `files` in package.json decides this, and getting it wrong is only visible after
// a user has installed something broken: a missing dist/cli.js makes the bin point
// at nothing, a missing migrations/ breaks every command that opens the database,
// and a missing skills/ leaves the agent with no instructions. None of those fail
// the publish itself.
//
// This runs before publish and checks the packed file list rather than the working
// tree, because the working tree has everything and the tarball is what ships.

import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REQUIRED = [
	// Every published command needs these three to start at all.
	"package/dist/cli.js",
	"package/dist/app.js",
	"package/dist/page-adapter.js",
	// The schema is applied on first use; a package without it cannot create a
	// workspace.
	"package/migrations/0001_workspace.sql",
	// The agent reads these to know what the tool can do.
	"package/skills/dy/SKILL.md",
	"package/LICENSE",
	"package/README.md",
];

function packed(): string[] {
	const directory = mkdtempSync(join(tmpdir(), "dy-pack-"));
	try {
		// --dry-run prints the file list without writing the tarball.
		const output = execFileSync("npm", ["pack", "--dry-run", "--json"], {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		const parsed = JSON.parse(output) as { files?: { path: string }[] }[];
		return (parsed[0]?.files ?? []).map((entry) => `package/${entry.path}`);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}

// Written before packing: a marker created afterwards is not in the tarball, and
// the check below would pass on a list that does not describe what ships.
writeFileSync(".dy-build-origin", "npm\n", "utf8");

const files = new Set(packed());
const missing = REQUIRED.filter((path) => !files.has(path));
// A package that carries the sources ships something it does not need, and one
// that carries the built commit without a build is describing a source tree it no
// longer has.
const unwanted = [...files].filter(
	(path) => /^package\/(src|test|node_modules|\.git|\.dy)\//.test(path) || path.startsWith("package/.dy-chrome"),
);

const version = (JSON.parse(readFileSync("package.json", "utf8")) as { version: string; name: string }).version;
const name = (JSON.parse(readFileSync("package.json", "utf8")) as { name: string }).name;

if (missing.length || unwanted.length) {
	process.stderr.write(
		`${JSON.stringify({
			ok: false,
			error: {
				message: "The tarball is not what dy needs to run",
				missing,
				unexpected: unwanted.slice(0, 20),
				hint: "Adjust `files` in package.json and run this again.",
			},
		})}\n`,
	);
	process.exit(1);
}

process.stdout.write(
	`${JSON.stringify({
		ok: true,
		data: { name, version, files: files.size, checked: REQUIRED.length },
	})}\n`,
);
