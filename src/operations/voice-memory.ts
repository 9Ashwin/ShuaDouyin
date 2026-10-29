import type { Memory } from "../memory/concept.ts";
import type { VoiceProfile } from "../voice.ts";

// A voice profile is worth keeping only if it can be found again and compared.
//
// The first version measured each section and threw the measurement away, so
// every work started from nothing and the bot never got better at sounding
// local. Storing one memory per section does not fix that either: a memory per
// work is a pile nobody reads. What accumulates is the comparison — which
// lengths, which habits, which works look like each other.
//
// The record is deliberately plain text. A memory the platform cannot search by
// meaning has to be searchable by the words a person would actually use, so the
// guidance lines are stored beside the numbers.

export interface VoiceRecord {
	video_id: string;
	profile: VoiceProfile;
	sampled: number;
	at: string;
	// What the section rewarded, when the page showed it. Absent means the
	// section reported no like counts, which is different from nobody liking it.
	engagement?: { rated: number; median_likes: number; correlation: number };
}

const MARKER = "voice-profile";

export function voiceMemoryText(record: VoiceRecord): string {
	const { profile } = record;
	// Everything a future reader needs to decide whether this section matches the
	// one in front of them: the shape, the habits, and where it came from.
	return [
		`评论区风格样本（作品 ${record.video_id}，${record.sampled} 条）：`,
		`中位 ${profile.length.median} 字，p90 ${profile.length.p90} 字。`,
		`连续感叹号 ${percent(profile.exclamation.repeated, record.sampled)}，`,
		`直呼作者 ${percent(profile.addresses_author, record.sampled)}，`,
		`第一人称 ${percent(profile.first_person, record.sampled)}，`,
		`提问 ${percent(profile.questions, record.sampled)}。`,
		profile.openers.length
			? `反复出现的称呼：${profile.openers.map((open) => `${open.text}×${open.count}`).join("、")}。`
			: "没有反复出现的称呼。",
		record.engagement?.rated
			? `有赞数的 ${record.engagement.rated} 条，中位 ${record.engagement.median_likes} 赞，长度与赞数相关 ${record.engagement.correlation}。`
			: "",
	].join("");
}

function percent(count: number, total: number): string {
	return total ? `${Math.round((count / total) * 100)}%` : "0%";
}

// Reading a summary back. The caller asks "how do sections here write"; the
// answer is what previous sections looked like, grouped by shape rather than
// listed one by one, because the point is to recognise the kind of section.
export function summarise(records: VoiceRecord[]): {
	sections: number;
	shapes: { shape: string; sections: number; median_range: [number, number]; habits: string[] }[];
} {
	const groups = new Map<string, VoiceRecord[]>();
	for (const record of records) {
		const shape = shapeOf(record.profile);
		groups.set(shape, [...(groups.get(shape) ?? []), record]);
	}
	return {
		sections: records.length,
		shapes: [...groups.entries()]
			.map(([shape, list]) => {
				const medians = list.map((record) => record.profile.length.median).sort((a, b) => a - b);
				const habit = (pick: (profile: VoiceProfile) => number) =>
					Math.round((list.reduce((sum, record) => sum + pick(record.profile), 0) / list.length) * 100);
				const habits: string[] = [];
				if (habit((profile) => (profile.samples ? profile.exclamation.repeated / profile.samples : 0)) >= 30)
					habits.push("repeated exclamation marks");
				if (habit((profile) => (profile.samples ? profile.addresses_author / profile.samples : 0)) >= 40)
					habits.push("addresses the author");
				if (habit((profile) => (profile.samples ? profile.first_person / profile.samples : 0)) >= 40)
					habits.push("speaks in the first person");
				if (habit((profile) => (profile.samples ? profile.questions / profile.samples : 0)) >= 20)
					habits.push("asks questions");
				return {
					shape,
					sections: list.length,
					median_range: [medians[0] ?? 0, medians[medians.length - 1] ?? 0] as [number, number],
					habits,
				};
			})
			.sort((left, right) => right.sections - left.sections),
	};
}

// Three shapes is enough to be actionable and few enough to stay honest. More
// buckets would describe each section more precisely while giving a caller
// nothing to choose between.
export function shapeOf(profile: VoiceProfile): string {
	if (profile.length.p90 <= 25) return "one-liner";
	if (profile.length.median <= 25) return "short-sentence";
	return "paragraph";
}

export function voiceMemories(memories: Memory[]): VoiceRecord[] {
	return memories
		.filter((memory) => memory.tags?.includes(MARKER) && memory.type === "insight")
		.map((memory) => {
			const median = /中位 (\d+) 字/.exec(memory.body)?.[1];
			const p90 = /p90 (\d+) 字/.exec(memory.body)?.[1];
			const video = /作品 (\d+)/.exec(memory.body)?.[1];
			const sampled = /，(\d+) 条/.exec(memory.body)?.[1];
			return {
				video_id: video ?? "",
				sampled: Number(sampled ?? 0),
				at: memory.updated_at,
				profile: {
					samples: Number(sampled ?? 0),
					length: { mean: 0, median: Number(median ?? 0), p90: Number(p90 ?? 0) },
					exclamation: { samples: 0, repeated: countIn(memory.body, "连续感叹号") },
					openers: [],
					addresses_author: countIn(memory.body, "直呼作者"),
					uses_emoji: 0,
					first_person: countIn(memory.body, "第一人称"),
					questions: countIn(memory.body, "提问"),
				},
			};
		});
}

// The stored text keeps percentages for a reader; grouping needs the counts
// back, and the sample size is on the same line.
function countIn(body: string, label: string): number {
	const percent = new RegExp(`${label} (\\d+)%`).exec(body)?.[1];
	const total = /，(\d+) 条/.exec(body)?.[1];
	return Math.round((Number(percent ?? 0) / 100) * Number(total ?? 0) || 0);
}
