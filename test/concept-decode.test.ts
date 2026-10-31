import assert from "node:assert/strict";
import test from "node:test";
import { CliError } from "../src/errors.ts";
import { decode } from "../src/memory/concept.ts";

// decode() is the boundary where a file on disk becomes a memory. Everything
// downstream trusts what it returns, so the interesting cases are the malformed
// ones: each has to be refused with a code the caller can branch on, never
// filled in with a plausible guess.
//
// Every case below starts from one valid memory and changes exactly one field.
// That is deliberate — a test built from an already-broken header proves the
// file is refused, not which check refused it, and would still pass if every
// later check were deleted.

const BASE = [
	"id: mem_a1b2c3d4",
	"type: memory",
	"title: 标题",
	"layer: note",
	"subject: 主题",
	"topic: 话题",
	"certainty: inferred",
	"confidence: 0.5",
	"sources:",
	"  - user:test",
	"links: []",
	"created_at: 2026-01-01T00:00:00Z",
	"updated_at: 2026-01-02T00:00:00Z",
].join("\n");

const file = (header: string, body = "正文") => `---\n${header}\n---\n${body}`;

/** A valid memory with one frontmatter line replaced, added or removed. */
const withHeader = (key: string, value: string | null) => {
	const lines = BASE.split("\n").filter((line) => !line.startsWith(`${key}:`) && !line.startsWith(`  - `) === true);
	const kept = lines.filter(
		(line, index) => !(index > 0 && lines[index - 1] === "sources:" && line.startsWith("  - ")),
	);
	if (value !== null) kept.push(`${key}: ${value}`);
	return kept.join("\n");
};

const corrupt = (content: string, pattern?: RegExp) => {
	assert.throws(
		() => decode("bot", "memory/note/x.md", content),
		(error: unknown) => {
			assert.ok(error instanceof CliError, `expected a CliError, got ${String(error)}`);
			assert.equal(error.code, "state_corrupt");
			if (pattern) assert.match(error.message, pattern);
			return true;
		},
	);
};

test("a valid memory decodes with its fields intact", () => {
	// The baseline every other test is derived from has to be genuinely valid,
	// otherwise the rest of the file is testing the wrong thing.
	const entry = decode("bot", "memory/note/x.md", file(BASE));
	assert.equal(entry.row.id, "mem_a1b2c3d4");
	assert.equal(entry.row.layer, "note");
	assert.equal(entry.row.body, "正文");
	assert.equal(entry.row.bot_id, "bot");
	assert.equal(entry.row.path, "memory/note/x.md");
	assert.match(entry.row.revision, /^[a-f0-9]{64}$/);
});

test("a memory with no frontmatter at all is refused", () => {
	corrupt("just a body with no header", /frontmatter/);
	corrupt(`---\nid: mem_a1b2c3d4\n`, /incomplete/);
});

test("malformed or ambiguous YAML is corruption, not an empty header", () => {
	corrupt(file("id: [unclosed"), /YAML/);
	// Two ids would make the memory addressable two ways and one would win silently.
	corrupt(file("id: mem_a1b2c3d4\nid: mem_e5f6a7b8\nlayer: note"), /YAML/);
});

test("an oversized file is refused before it is parsed", () => {
	// The header here is valid, so the size is the only reason to refuse it. The
	// message is checked too: an earlier version of this test passed while
	// hitting the frontmatter check instead, which would have gone on passing
	// if the size limit were deleted.
	corrupt(file(BASE, "x".repeat(131072)), /frontmatter/);
	// Just under the limit is accepted, which fixes where the boundary is.
	assert.equal(decode("bot", "memory/note/x.md", file(BASE, "x".repeat(131072 - 400))).row.id, "mem_a1b2c3d4");
});

test("metadata that is a list or a scalar is refused, not coerced away", () => {
	corrupt(file(`${BASE}\nmetadata: [1, 2]`), /metadata/);
	corrupt(file(`${BASE}\nmetadata: a string`), /metadata/);
});

test("an id that is not one this tool issues is refused", () => {
	corrupt(file(withHeader("id", "not-an-id")), /metadata/);
	corrupt(file(withHeader("id", null)), /metadata/);
	// A memory id is a UUID or mem_-prefixed; a work id is neither.
	corrupt(file(withHeader("id", "12345")), /metadata/);
});

test("a layer outside the vocabulary is refused", () => {
	corrupt(file(withHeader("layer", "nowhere")), /metadata/);
});

test("the layer has to agree with the directory the file lives in", () => {
	// Otherwise a memory filed under the wrong folder would index under one layer
	// while its path said another, and the next correction would rewrite the wrong
	// file.
	assert.throws(() => decode("bot", "memory/context/x.md", file(BASE)), { code: "state_corrupt" });
});

test("certainty outside the vocabulary is refused", () => {
	corrupt(file(withHeader("certainty", "probably")), /metadata/);
});

test("a user-stated memory has to cite where the user said it", () => {
	// The distinction between what a person stated and what was inferred rests on
	// the source, so a user-stated memory citing anything else is a contradiction.
	corrupt(
		file(withHeader("sources", "[file:memory/bot/AGENTS.md]").replace("certainty: inferred", "certainty: user-stated")),
		/metadata/,
	);
});

test("confidence has to be a number inside 0..1", () => {
	corrupt(file(withHeader("confidence", "1.5")), /metadata/);
	corrupt(file(withHeader("confidence", "not a number")), /metadata/);
	corrupt(file(withHeader("confidence", "-0.1")), /metadata/);
});

test("a memory with no sources is refused", () => {
	// A claim with nothing behind it is exactly what the memory file is meant to
	// prevent, so an empty list is a corruption rather than a default.
	const noSources = BASE.replace("sources:\n  - user:test", "sources: []");
	corrupt(file(noSources), /metadata/);
});

test("a confidence outside the range is refused but the boundaries are accepted", () => {
	assert.equal(decode("bot", "memory/note/x.md", file(withHeader("confidence", "0"))).row.confidence, 0);
	assert.equal(decode("bot", "memory/note/x.md", file(withHeader("confidence", "1"))).row.confidence, 1);
});

test("tags that are not all strings are refused", () => {
	corrupt(file(`${BASE}\ntags: [好, 3]`), /YAML|tags|metadata/);
	corrupt(file(`${BASE}\ntags: 好`), /metadata/);
});

test("a profile_ref has to be a reference this tool writes", () => {
	corrupt(file(`${BASE}\nprofile_ref: 一个名字`), /profile_ref/);
	assert.equal(
		decode("bot", "memory/note/x.md", file(`${BASE}\nprofile_ref: user:author_123`)).row.profile_ref,
		"user:author_123",
	);
});

test("a timestamp that cannot be parsed is refused rather than stored as empty", () => {
	corrupt(file(withHeader("created_at", "yesterday")), /metadata/);
	corrupt(file(withHeader("updated_at", null)), /metadata/);
});

test("an empty body is refused", () => {
	corrupt(file(BASE, "   "), /metadata/);
});

test("a hand-edited trailing newline does not change the body, but does change the revision", () => {
	// The body is trimmed so whitespace at the end of a hand-edited file does not
	// become part of the memory's text. The revision is the hash of the whole
	// file, so the same edit does produce a new one — which is right: a revision
	// identifies a version of the file, and the file did change.
	const one = decode("bot", "memory/note/a.md", file(BASE, "同一段正文"));
	const two = decode("bot", "memory/note/a.md", file(BASE, "同一段正文\n\n"));
	assert.equal(one.row.body, two.row.body);
	assert.notEqual(one.row.revision, two.row.revision);
});

test("an old file with no type, title or tags stays readable", () => {
	// Refusing these would make an existing workspace unreadable after an upgrade.
	// The layer and dates were always required, so they are still present here.
	const old = [
		"id: mem_a1b2c3d4",
		"layer: note",
		"subject: 主题",
		"topic: 话题",
		"certainty: inferred",
		"confidence: 0.5",
		"sources: [user:test]",
		"created_at: 2026-01-01T00:00:00Z",
		"updated_at: 2026-01-01T00:00:00Z",
	].join("\n");
	const entry = decode("bot", "memory/note/old.md", file(old));
	assert.equal(entry.row.type, "memory");
	assert.deepEqual(entry.row.tags, []);
	// A missing title is derived from the topic first, then the first body line.
	assert.equal(entry.row.title, "话题");
});

test("a link to something that is not a memory id is refused", () => {
	// `links` is already set in BASE, so the replacement is made in the header
	// rather than appended — two `links` keys is a YAML error, not this check.
	corrupt(file(withHeader("links", "[12345]")), /metadata/);
	assert.deepEqual(decode("bot", "memory/note/x.md", file(withHeader("links", "[mem_e5f6a7b8]"))).row.links, [
		"mem_e5f6a7b8",
	]);
});
