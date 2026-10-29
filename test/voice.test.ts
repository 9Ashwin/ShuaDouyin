import assert from "node:assert/strict";
import test from "node:test";
import { measureEngagement, measureWit, profileVoice, voiceGuidance } from "../src/voice.ts";

test("a section that writes in paragraphs is not described as short", () => {
	// The same code reported a median of 11 characters on one work and 46 on
	// another, minutes apart. A profile is per work, and the advice has to follow
	// the measurement rather than a house style.
	const long = profileVoice([
		{ text: "感觉龟龟去的那个地点都有一种电影里的画面的感觉！！！！好唯美！！" },
		{ text: "龟龟！你去内蒙古啦！是不是超级好玩！内蒙古的秋天好美呀！好喜欢北方的秋天～" },
		{ text: "美的不可方物呀，这就是我想象中秋天的样子，刚开头的bgm也是超级的戳我" },
	]);
	assert.ok(long.length.median > 20, `median was ${long.length.median}`);
	assert.ok(voiceGuidance(long).some((line) => /run long/.test(line)));

	const short = profileVoice([{ text: "可惜南方没有秋天" }, { text: "嘻嘻嘻" }, { text: "好听" }]);
	assert.ok(short.length.median < 12);
	assert.ok(voiceGuidance(short).some((line) => /are short/.test(line)));
});

test("a repeated opener is only reported when it repeats", () => {
	const once = profileVoice([{ text: "龟龟！你去内蒙古啦" }, { text: "好美" }]);
	assert.deepEqual(once.openers, []);
	const twice = profileVoice([{ text: "龟龟！你去内蒙古啦" }, { text: "龟龟！我也想去" }, { text: "好美" }]);
	assert.deepEqual(twice.openers, [{ text: "龟龟", count: 2 }]);
});

test("a line of poetry is not mistaken for a greeting", () => {
	// Running on a real section, "人闲桂花落，夜静春山空" appeared twice and was
	// reported as a name people open their comments with. A greeting ends in an
	// exclamation mark; a poem ends its clause at a comma.
	const poetry = profileVoice([{ text: "人闲桂花落，夜静春山空" }, { text: "人闲桂花落，月出惊山鸟" }]);
	assert.deepEqual(poetry.openers, []);
});

test("every guidance line names the measurement behind it", () => {
	const profile = profileVoice([
		{ text: "姐姐好美！！！" },
		{ text: "宝贝这是哪里呀！！！" },
		{ text: "我也想去" },
		{ text: "姐姐下次去哪" },
	]);
	const lines = voiceGuidance(profile).join(" ");
	// A caller deciding whether to imitate needs the number, not an adjective.
	assert.match(lines, /\d+%/);
	assert.match(lines, /exclamation|address|first person|question|characters/i);
});

test("nothing read is said rather than guessed", () => {
	const empty = profileVoice([]);
	assert.equal(empty.samples, 0);
	assert.deepEqual(voiceGuidance(empty), ["No comments were read, so there is nothing to imitate."]);
});

test("engagement is measured, not assumed to follow length", () => {
	// On a real section the top comment was four characters ("下次一起唱",
	// acknowledged by the author) and the longest, most carefully written one had
	// none. The measurement exists so a caller cannot quietly assume the
	// opposite.
	const engagement = measureEngagement([
		{ text: "下次一起唱", likes: 247, liked_by_author: true },
		{ text: "欧克", likes: 120 },
		{ text: "这首歌有一点像王朝1982的《我本将心向明月》", likes: 63 },
		{ text: "八千里路明照，回首功名笑孤鸿冥冥向霄，一路任啸十年寒窗无人晓，儿郎志气高", likes: 0 },
	]);
	assert.equal(engagement.rated, 4);
	assert.equal(engagement.top[0].text, "下次一起唱");
	assert.equal(engagement.top[0].liked_by_author, true);
	assert.equal(engagement.acknowledged, 1);
	// Longer did worse here, so the correlation is negative rather than zero or
	// politely absent.
	assert.ok(engagement.length_likes_correlation < 0, `was ${engagement.length_likes_correlation}`);
});

test("a section where nothing has likes reports no relationship", () => {
	const quiet = measureEngagement([
		{ text: "a", likes: 0 },
		{ text: "b", likes: 0 },
		{ text: "c", likes: 0 },
	]);
	assert.equal(quiet.length_likes_correlation, 0);
	assert.equal(quiet.median_likes, 0);
});

test("what made a comment work is named, not scored", () => {
	// Measured on one real section: the four-character "下次一起唱" was
	// acknowledged by the author while a 150-character comment of craft
	// adjectives got two likes. The difference is legible in text.
	const echo = measureWit("下次一起唱");
	assert.equal(echo.verdict, "has-wit");
	assert.ok(echo.echoes.length);

	const specific = measureWit("这首歌有一点像王朝1982的《我本将心向明月》");
	assert.equal(specific.verdict, "has-wit");
	assert.ok(specific.specific.some((phrase) => phrase.includes("王朝1982")));

	const praise = measureWit(
		"唱腔开阔大气，强弱层次把控精妙，没有嘶吼式爆发，却藏着少年凌云傲骨。若是带戏腔段落，转音圆润婉转，古韵扑面而来，把执着与豪迈诠释到位。",
	);
	assert.equal(praise.verdict, "generic-praise");
	assert.ok(praise.generic_praise.length > 0);
});

test("a common character inside an ordinary sentence is not an echo", () => {
	// "行" and "可以" appear inside polite requests; counting them marked every
	// question as picking up the stream's last line.
	assert.equal(measureWit("我妹妹结婚的时候，可以请您来唱这首歌吗").verdict, "flat");
	assert.equal(measureWit("我就晚来几分钟。").verdict, "flat");
});
