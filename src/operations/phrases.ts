import type { Memory } from "../memory/concept.ts";
import type { Wit } from "../voice.ts";

// A phrase that worked is worth remembering once, and worth forgetting after
// it has been used.
//
// The failure this exists to prevent: the first echo that got a like becomes
// the opener for every comment after it, and the bot stops sounding like a
// person and starts sounding like a template. So a phrase is stored with how
// many times it has been used and when, and what a caller gets back is either
// "fresh" (never used, recently learned) or "spent" (used enough that saying it
// again would be a repeat). Spent phrases are reported rather than hidden: the
// caller needs to know the phrase exists and that it is not available.

export interface Phrase {
	text: string;
	// What made it work, from the same three dimensions the wit measurement
	// reports.
	kind: "echo" | "specific" | "turn";
	// The work it was first seen on, so a caller can tell whether the ground is
	// the same. "下次一起唱" fits a stream that just offered to sing again, not
	// every work.
	from_video: string;
	learned_at: string;
	used: number;
	last_used: string | null;
	// The like count that made it worth keeping. A phrase kept from a comment
	// nobody liked is worse than no phrase at all.
	likes: number;
}

export interface PhraseState extends Phrase {
	status: "fresh" | "usable" | "spent";
	// Days since it was last used, rounded down. A phrase can come back into
	// circulation after enough silence — repetition is about proximity, not
	// a permanent ban.
	idle_days: number;
}

const MARKER = "phrase-ledger";
// A phrase used three times is a tic. Two is enough for it to be ready to use
// once more if the ground fits; beyond that it needs silence rather than
// another chance.
const SPENT_AT = 3;
// Long enough that a reader will not connect the two uses.
const COOLDOWN_DAYS = 14;

export function phraseMemoryText(phrase: Phrase): string {
	return [
		`可用句式（${phrase.kind}，来自作品 ${phrase.from_video}，${phrase.likes} 赞）：`,
		`「${phrase.text}」`,
		`已用 ${phrase.used} 次${phrase.last_used ? `，最后一次 ${phrase.last_used}` : ""}。`,
	].join("");
}

export function phraseState(phrase: Phrase, now: Date): PhraseState {
	const idle = phrase.last_used ? Math.floor((now.getTime() - Date.parse(phrase.last_used)) / 86_400_000) : null;
	const idleDays = idle === null ? 0 : Math.max(0, idle);
	// Repetition is about proximity. A phrase used three times in a week is a
	// tic; the same phrase used once a month for three months is a habit a
	// person could have. Silence brings it back.
	const status: PhraseState["status"] =
		phrase.used === 0 ? "fresh" : phrase.used >= SPENT_AT && idleDays < COOLDOWN_DAYS ? "spent" : "usable";
	return { ...phrase, status, idle_days: idleDays };
}

// What a caller can actually say right now. Spent phrases come back separately
// so the caller knows the phrase exists and why it is not offered — silently
// dropping it would make the same suggestion return after a restart.
export function availablePhrases(phrases: Phrase[], now: Date): { usable: PhraseState[]; spent: PhraseState[] } {
	const states = phrases.map((phrase) => phraseState(phrase, now));
	return {
		usable: states
			.filter((state) => state.status !== "spent")
			.sort((left, right) => {
				// Fresh and high-liked first, then by idle time: the phrase least
				// recently said is the one least likely to read as a repeat.
				if (left.status !== right.status) return left.status === "fresh" ? -1 : 1;
				if (left.idle_days !== right.idle_days) return right.idle_days - left.idle_days;
				return right.likes - left.likes;
			}),
		spent: states.filter((state) => state.status === "spent").sort((left, right) => right.used - left.used),
	};
}

export function phraseMemories(memories: Memory[]): Phrase[] {
	return memories
		.filter((memory) => memory.tags?.includes(MARKER))
		.flatMap((memory) => {
			const text = /「(.+?)」/.exec(memory.body)?.[1];
			if (!text) return [];
			const kind = /句式（(\w+)/.exec(memory.body)?.[1];
			const video = /作品 (\d+)/.exec(memory.body)?.[1];
			const likes = /，(\d+) 赞/.exec(memory.body)?.[1];
			const used = /已用 (\d+) 次/.exec(memory.body)?.[1];
			const last = /最后一次 ([0-9T:.Z-]+)/.exec(memory.body)?.[1];
			return [
				{
					text,
					kind: kind === "specific" || kind === "turn" ? kind : "echo",
					from_video: video ?? "",
					learned_at: memory.created_at,
					used: Number(used ?? 0),
					last_used: last ?? null,
					likes: Number(likes ?? 0),
				},
			];
		});
}

// A comment that did well is a candidate phrase, but only the part that would
// transfer. The whole sentence is tied to one work; the shape is what travels.
export function candidatePhrase(
	comment: { text: string; likes?: number | null },
	wit: Wit,
	video: string,
): Phrase | null {
	const text = comment.text.replace(/\s+/g, " ").trim();
	// A phrase has to be short enough to be a phrase and liked enough to be worth
	// copying. An unliked sentence is not a candidate no matter how well formed.
	if (Array.from(text).length > 30 || (comment.likes ?? 0) < 3) return null;
	const kind = wit.echoes.length ? "echo" : wit.turns.length ? "turn" : wit.specific.length ? "specific" : null;
	if (!kind) return null;
	// A specific phrase names another work or person, which is why it landed —
	// and why it does not travel. "有点像王朝1982的《我本将心向明月》" is a good
	// comment on one video and nonsense on the next. Only the shape can be
	// reused, so a specific phrase is kept only when the referent is generic
	// enough to swap in another.
	// A specific phrase only travels when the referent can be swapped. A named
	// work, person or account cannot, so it stays a good comment rather than
	// becoming a reusable line.
	const namesSomeone = /《[^》]+》|[A-Za-z]{3,}|同学|导演|原作|原唱|主播|博主/.test(text);
	if (kind === "specific" && (namesSomeone || Array.from(text).length > 12)) return null;
	return {
		text,
		kind,
		from_video: video,
		learned_at: new Date().toISOString(),
		used: 0,
		last_used: null,
		likes: comment.likes ?? 0,
	};
}

// Recording that a phrase was said. The count is the whole point: a caller
// that uses a phrase has to say so, or the ledger cannot tell a fresh phrase
// from one that has been in every comment this week.
export function usePhrase(phrase: Phrase, now: Date): Phrase {
	return { ...phrase, used: phrase.used + 1, last_used: now.toISOString() };
}

// What the ledger is for, in one line, so a caller that ignores the counts
// still sees why they exist.
export const PHRASE_RULE =
	"A phrase earns its place by being used once and then resting. Reaching for the same line every time is what makes a bot read as a bot, not a person with a style.";

// Whether a set of recent comments repeats itself.
//
// The ledger stops one phrase from being reused, but it cannot see a pattern
// across different phrases: reaching for a new echo every time is still
// formulaic. So the check is on the comments actually written, not on the
// ledger — how many of them opened the same way, used the same phrase, or had
// the same shape.
export interface Sameness {
	comments: number;
	repeated_openers: { opener: string; count: number }[];
	repeated_phrases: { phrase: string; count: number }[];
	average_length: number;
	length_spread: number;
	// One sentence for a caller that reads nothing else.
	verdict: "varied" | "narrowing" | "template";
}

export function measureSameness(comments: { text: string; at?: string }[]): Sameness {
	const texts = comments.map((comment) => comment.text.replace(/\s+/g, " ").trim()).filter(Boolean);
	const openers = new Map<string, number>();
	const phrases = new Map<string, number>();
	for (const text of texts) {
		const opener = /^([\p{L}\p{N}]{1,6})(?:[!！,，。、~～\s]|$)/u.exec(text)?.[1];
		if (opener) openers.set(opener, (openers.get(opener) ?? 0) + 1);
		// A phrase is the first four characters: long enough to be a habit,
		// short enough that two comments sharing it is worth noticing.
		const lead = Array.from(text).slice(0, 4).join("");
		if (Array.from(text).length >= 3) phrases.set(lead, (phrases.get(lead) ?? 0) + 1);
	}
	const lengths = texts.map((text) => Array.from(text).length);
	const mean = lengths.reduce((sum, value) => sum + value, 0) / (lengths.length || 1);
	const spread = Math.sqrt(lengths.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (lengths.length || 1));
	const repeatedOpeners = [...openers.entries()].filter(([, count]) => count > 1);
	const repeatedPhrases = [...phrases.entries()].filter(([, count]) => count > 1);
	// A spread under a third of the mean means every comment is roughly the same
	// size, which is the shape of a template rather than a person writing.
	const narrow = texts.length >= 3 && spread < mean / 3;
	const verdict: Sameness["verdict"] =
		repeatedPhrases.length >= 2 || (repeatedPhrases.length >= 1 && narrow)
			? "template"
			: repeatedOpeners.length || repeatedPhrases.length || narrow
				? "narrowing"
				: "varied";
	return {
		comments: texts.length,
		repeated_openers: repeatedOpeners.map(([opener, count]) => ({ opener, count })),
		repeated_phrases: repeatedPhrases.map(([phrase, count]) => ({ phrase, count })),
		average_length: Math.round(mean),
		length_spread: Math.round(spread),
		verdict,
	};
}
