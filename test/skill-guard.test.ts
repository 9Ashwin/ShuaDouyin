import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// The skill is the only thing an agent reads before acting on a real account,
// so what it says about sending permissions is a safety property rather than
// documentation. These checks are deliberately about the text, because that is
// where the failure happened: an agent wrote "以后评论不用问" into a workspace
// file, turning one round's permission into a standing one.

const read = (path: string) => readFile(new URL(`../skills/dy/${path}`, import.meta.url), "utf8");

test("the skill grants no standing permission to send anything", async () => {
	const files = [
		"SKILL.md",
		"references/commands.md",
		"references/browse-and-grow.md",
		"references/memory-and-persona.md",
		"references/platform-facts.md",
		"references/self-improvement.md",
		"references/social.md",
	];
	// A permanent grant looks like this: telling the caller comments need no
	// approval, stated without the round it applies to.
	const standing = [/评论(永远|以后|一直)不用问/, /永久授权/, /长期授权/, /以后不用(再)?确认/, /no need to ask ever/i];
	for (const file of files) {
		const text = await read(file);
		for (const pattern of standing) {
			assert.ok(!pattern.test(text), `${file} must not grant standing permission: ${pattern}`);
		}
	}
});

test("the skill says authorisation is per round and cannot be written down", async () => {
	// The positive half: an agent has to be told that the permission expires,
	// or it will do the reasonable-looking thing and save it.
	const text = await read("SKILL.md");
	assert.match(text, /授权是按当轮的/);
	assert.match(text, /不要把它写成常驻设置/);
});

test("the punctuation rule says commas are normal, not spaces", async () => {
	// The rule was once "use spaces instead of punctuation", and an agent followed
	// it into prose that read worse than the thing it was avoiding.
	const text = await read("SKILL.md");
	assert.match(text, /逗号照常用/);
	assert.match(text, /不能全换成空格/);
	// And the old over-correction must not come back anywhere in the skill.
	const commands = await read("references/commands.md");
	const skill = await read("SKILL.md");
	for (const text_ of [text, commands, skill]) {
		assert.ok(!/用空格断句|空格就是停顿|短句之间空一格/.test(text_));
	}
});

test("a delivery-uncertain retry says to check the gate first", async () => {
	// A read taken under a verification mask returns a stale list, which made a
	// comment that had posted look absent. The skill must name that, because the
	// next agent will otherwise repeat exactly that check.
	const text = await read("SKILL.md");
	assert.match(text, /delivery_uncertain/);
	assert.match(text, /dy auth status/);
});
