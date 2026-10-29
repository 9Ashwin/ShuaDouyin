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
