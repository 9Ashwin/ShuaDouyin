// How the people here actually write.
//
// A comment section is a style corpus written by the audience the comment has
// to land with, so the useful question is not "is this good writing" but "what
// does a sentence in this section look like". Measured on a real feed:
//
//   "找机会一定要去！！！"
//   "宝贝你可以不要火起来吗 让我一直默默地看默默地喜欢好么"
//   "龟龟！你去内蒙古啦！是不是超级好玩！内蒙古的秋天好美呀！"
//
// Three exclamation marks, the author's nickname as an opener, and a 74-word
// paragraph that reads like a message to a friend. A neutral, well-formed
// sentence is the one thing that stands out as not being from here.
//
// This module only measures. Deciding whether to imitate is the caller's, and
// the numbers are returned with their evidence so a reader can disagree.

export interface VoiceSample {
	text: string;
	stance?: string;
}

export interface VoiceProfile {
	samples: number;
	// Sentence shape.
	length: { mean: number; median: number; p90: number };
	// Punctuation habit, counted per sample rather than per character.
	exclamation: { samples: number; repeated: number };
	// Openers: the nickname or greeting a comment starts with.
	openers: { text: string; count: number }[];
	// How often a comment addresses the author by name or a kinship word.
	addresses_author: number;
	// Emoji and emoticon usage. The platform renders them as images, so a
	// commenter who uses them shows up as a shorter text than they wrote.
	uses_emoji: number;
	// Markers that identify the speaker as part of this audience rather than a
	// visitor describing it.
	first_person: number;
	questions: number;
}

const EXCLAIM = /[!！]/g;
const ADDRESS = /(姐姐|哥哥|弟弟|妹妹|宝贝|宝宝|老师|大大|博主|作者|主包|龟龟|各位)/;
// A repeated opener is only a greeting when it is followed by an exclamation
// mark. That is how an address reads: "龟龟！你去内蒙古啦". A line of poetry also
// opens short and ends at a comma, and calling it a name is worse than missing
// it.
const CLOSES_WITH_ADDRESS = /[!！~～]$/;
const FIRST_PERSON = /(我|咱|俺)/;
const QUESTION = /[?？]|吗|呢|吧/;

export function profileVoice(samples: VoiceSample[]): VoiceProfile {
	const texts = samples.map((sample) => sample.text.replace(/\s+/g, " ").trim()).filter(Boolean);
	const lengths = texts.map((text) => Array.from(text).length).sort((a, b) => a - b);
	const at = (fraction: number) =>
		lengths.length ? lengths[Math.min(lengths.length - 1, Math.floor(lengths.length * fraction))] : 0;

	const openers = new Map<string, number>();
	let exclaimSamples = 0;
	let repeated = 0;
	let addresses = 0;
	let emoji = 0;
	let firstPerson = 0;
	let questions = 0;

	for (const text of texts) {
		// An opener is the first clause followed by punctuation or a space:
		// "龟龟！你去内蒙古啦" opens with 龟龟. Taking the first six characters
		// instead produced "龟龟晚上好啊" — a fragment of the sentence, not the
		// name — so only a clause that ends where the greeting ends counts.
		// It also has to look like an address. Running on a real section,
		// "人闲桂花落，夜静春山空" was counted twice and reported as a name people
		// greet each other with, which is a poem.
		const opener = /^([\p{L}\p{N}]{1,6})(?:[!！,，。、~～\s]|$)/u.exec(text)?.[1];
		if (opener && CLOSES_WITH_ADDRESS.test(`${opener}${text.slice(opener.length, opener.length + 1)}`))
			openers.set(opener, (openers.get(opener) ?? 0) + 1);
		const marks = text.match(EXCLAIM)?.length ?? 0;
		if (marks) exclaimSamples++;
		if (marks >= 2) repeated++;
		if (ADDRESS.test(text)) addresses++;
		// The adapter replaces an emoji image with its alt character, but a
		// comment written only of emoji has no letters at all. Both read as a
		// shortened text, so the count is stated rather than inferred.
		if (/[\p{Extended_Pictographic}]/u.test(text)) emoji++;
		if (FIRST_PERSON.test(text)) firstPerson++;
		if (QUESTION.test(text)) questions++;
	}

	const total = texts.length || 1;
	return {
		samples: texts.length,
		length: {
			mean: Math.round(lengths.reduce((sum, value) => sum + value, 0) / total),
			median: at(0.5),
			p90: at(0.9),
		},
		exclamation: { samples: exclaimSamples, repeated },
		openers: [...openers.entries()]
			.filter(([, count]) => count > 1)
			.sort((left, right) => right[1] - left[1])
			.slice(0, 8)
			.map(([text, count]) => ({ text, count })),
		addresses_author: addresses,
		uses_emoji: emoji,
		first_person: firstPerson,
		questions,
	};
}

// What the profile implies about writing one comment here. Each line names the
// measurement behind it, so a caller can check the advice rather than trust it.
export function voiceGuidance(profile: VoiceProfile): string[] {
	if (!profile.samples) return ["No comments were read, so there is nothing to imitate."];
	const total = profile.samples;
	const lines: string[] = [];
	const share = (count: number) => Math.round((count / total) * 100);
	// The threshold sits between the two sections measured on the real page: a
	// median of 11 characters there, 28 and 46 on works whose comments are
	// conversation. 40 sat above the middle case and described it as neither.
	if (profile.length.median > 25)
		lines.push(
			`Comments here run long: median ${profile.length.median} characters. A one-line reply reads as a tourist.`,
		);
	else if (profile.length.median < 12)
		lines.push(`Comments here are short: median ${profile.length.median} characters. Brevity is the local habit.`);
	else lines.push(`Median comment length is ${profile.length.median} characters.`);
	if (profile.exclamation.repeated)
		lines.push(
			`${share(profile.exclamation.repeated)}% use repeated exclamation marks (! or ！). One exclamation is punctuation; two or three is how people here sound.`,
		);
	if (profile.openers.length)
		lines.push(
			`Openers that repeat: ${profile.openers.map((open) => `${open.text}×${open.count}`).join(", ")}. Starting with the author's name is normal here, not overfamiliar.`,
		);
	if (share(profile.addresses_author) >= 25)
		lines.push(
			`${share(profile.addresses_author)}% address the author directly (姐姐/宝贝/老师…). Writing about the work without addressing anyone is the minority style.`,
		);
	if (share(profile.first_person) >= 40)
		lines.push(
			`${share(profile.first_person)}% speak in the first person: what the work reminded them of. This section is a conversation, not a review.`,
		);
	if (share(profile.questions) >= 20)
		lines.push(`${share(profile.questions)}% ask something. A question is a normal way to join in here.`);
	if (share(profile.uses_emoji) >= 20)
		lines.push(`${share(profile.uses_emoji)}% carry an emoji. Leaving them out entirely is a visible difference.`);
	return lines;
}

// Which comments in a section actually landed.
//
// The platform shows a like count per comment and marks the ones the work's
// author acknowledged. That is the only outcome signal the page gives, and it
// contradicts the obvious guess: on a section where the median comment ran 22
// characters, the most-liked one was four — "下次一起唱", acknowledged by the
// author — while the longest, most carefully written comment had none.
//
// So this measures rather than advises. A caller that concludes "short works
// here" from one section's data is drawing a conclusion the data supports only
// for that section.
export interface Engagement {
	rated: number;
	median_likes: number;
	top: { text: string; likes: number; length: number; liked_by_author: boolean }[];
	// Correlation between length and likes, -1..1. Near zero means length says
	// nothing about whether people liked it, which is the common case.
	length_likes_correlation: number;
	acknowledged: number;
}

export function measureEngagement(
	comments: { text?: string; likes?: number | null; liked_by_author?: boolean }[],
): Engagement {
	const rated = comments
		.filter((comment) => typeof comment.likes === "number")
		.map((comment) => ({
			text: (comment.text ?? "").slice(0, 120),
			likes: comment.likes as number,
			length: Array.from(comment.text ?? "").length,
			liked_by_author: !!comment.liked_by_author,
		}));
	const likes = rated.map((comment) => comment.likes).sort((a, b) => a - b);
	const median = likes.length ? likes[Math.floor(likes.length / 2)] : 0;
	return {
		rated: rated.length,
		median_likes: median,
		top: [...rated].sort((left, right) => right.likes - left.likes).slice(0, 5),
		length_likes_correlation: correlation(
			rated.map((comment) => comment.length),
			rated.map((comment) => comment.likes),
		),
		acknowledged: rated.filter((comment) => comment.liked_by_author).length,
	};
}

// Pearson, with the degenerate cases returning 0 rather than NaN: a section
// where nothing has likes has no relationship to report, not an undefined one.
function correlation(xs: number[], ys: number[]): number {
	if (xs.length < 3) return 0;
	const mean = (values: number[]) => values.reduce((sum, value) => sum + value, 0) / values.length;
	const mx = mean(xs);
	const my = mean(ys);
	let numerator = 0;
	let dx = 0;
	let dy = 0;
	for (let index = 0; index < xs.length; index++) {
		const a = xs[index] - mx;
		const b = ys[index] - my;
		numerator += a * b;
		dx += a * a;
		dy += b * b;
	}
	if (!dx || !dy) return 0;
	return Math.round((numerator / Math.sqrt(dx * dy)) * 100) / 100;
}

// Whether a comment has 梗 — the quality that makes a section laugh or answer.
//
// The numbers said what length could not: on the real section the top comment
// was four characters ("下次一起唱", acknowledged by the author) and a 150-word
// comment of praise vocabulary got two likes. Reading the top few shows why —
// it picked up something the stream had just said, or named a specific work to
// compare against. The long one described the singing in adjectives that would
// fit any singer, which is what "没有梗" looks like in text.
//
// Three things are detectable from text alone, and each is returned with the
// phrase that produced it so a reader can disagree:
//
//   echoes    — answers something already on screen ("下次一起唱", "欧克")
//   specific  — names a work, a person, a place, a number (only a viewer could)
//   turns     — a reversal or self-deprecation, which is where most humour sits
//
// A comment with none of them is not necessarily bad; it is simply not the kind
// of comment this section rewards.
export interface Wit {
	echoes: string[];
	specific: string[];
	turns: string[];
	// Adjectives about craft with no referent. The strongest negative signal:
	// they apply to any work in the category.
	generic_praise: string[];
	verdict: "has-wit" | "flat" | "generic-praise";
}

// Answering rather than starting: a short reply to something just said. Very
// short and ending in an agreement or a follow-on is the shape of an echo.
const ECHO = /(欧克|收到|安排上|\+1|同意|确实|真的吗|是吧|对啊|哈哈哈|笑死|绝了|走起|下次一起|一起唱|我也来|来了来了)/;
// Only a viewer can name this. A title, a person, a place or a number the
// comment itself did not supply.
const SPECIFIC = /(《[^》]{1,30}》|[A-Za-z][A-Za-z0-9]{2,}|王朝1982|同学|导演|原作|原唱|第\d+[集期]|\d+年|\d+月)/;
// Reversal and self-deprecation: the turn is where humour usually lives.
const TURN = /(结果|居然|竟然|没想到|本来|以为|反而|倒|差点|笑死|绷不住|不配|自卑|破防|泪目|不至于|凭什么)/;
// Praise vocabulary that fits any work in the category. This is the negative
// signal, not the positive one.
const GENERIC =
	/(唱腔|强弱层次|把控精妙|婉转|诠释到位|开口跪|天籁|余音绕梁|声线|功底扎实|表现力|感染力|氛围感|绝美|yyds|开阔大气|扑面而来|豪迈|傲骨|凌云|圆润|爆发|孤寂|雄心|古韵|层次|情感饱满|到位)/;

export function measureWit(text: string): Wit {
	const body = text.replace(/\s+/g, " ").trim();
	const echoes = matches(body, ECHO);
	const specific = matches(body, SPECIFIC);
	const turns = matches(body, TURN);
	const generic = matches(body, GENERIC);
	const characters = Array.from(body).length;
	// A generic-praise comment is one dominated by craft adjectives and carrying
	// no referent: length alone is what let the 150-word one look substantial.
	const praiseShare = characters ? generic.reduce((sum, phrase) => sum + Array.from(phrase).length, 0) / characters : 0;
	const verdict: Wit["verdict"] =
		praiseShare >= 0.15 && !specific.length
			? "generic-praise"
			: echoes.length || specific.length || turns.length
				? "has-wit"
				: "flat";
	return { echoes, specific, turns, generic_praise: generic, verdict };
}

function matches(body: string, pattern: RegExp): string[] {
	const found = new Set<string>();
	for (const match of body.matchAll(new RegExp(pattern.source, `${pattern.flags}g`))) {
		if (match[0]) found.add(match[0]);
	}
	return [...found];
}
