import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";
import { listComments } from "./comments.ts";
import { navigate } from "./navigation.ts";
import type { Input } from "./validate.ts";

// What one person actually says, read from the platform rather than inferred from
// a word match.
//
// Discovery was judging candidates on whether a topic string appeared in text the
// caller supplied. That is a thumb on a scale: it says two people used the same
// word, which is not common ground. This reads what the person published and what
// they wrote under other people's work, and hands back the material with its
// source so a caller can judge instead of guess.
//
// It stays an evidence gatherer. Nothing here decides whether someone is worth
// meeting; that judgement is why an agent is in the loop at all.

export interface PersonEvidence {
	person: string;
	name: string | null;
	bio: string | null;
	// Their own works: title and duration only, because a work is what they chose to
	// publish and the title is what they called it.
	works: { id: string | null; title: string; duration: number | null }[];
	// What they wrote under works. Each carries the work it was under, because the
	// same sentence means different things on different videos.
	comments: { text: string; likes: number | null; on_work: string | null; stance: string | null }[];
	// Topics that recur across what they wrote, with how often. These are counts of
	// words the person used, not interests this tool believes they have.
	recurring: { phrase: string; count: number }[];
	// What this did not do.
	limits: string[];
}

// Words that appear in a person's comments and carry no information about them.
const STOP = new Set([
	"这个",
	"那个",
	"这样",
	"那样",
	"什么",
	"怎么",
	"就是",
	"不是",
	"可以",
	"还是",
	"但是",
	"所以",
	"因为",
	"如果",
	"已经",
	"一个",
	"自己",
	"真的",
	"都是",
	"也有",
	"没有",
	"我们",
	"你们",
	"他们",
	"感觉",
]);

// Two-character runs are where Chinese topic words live, but taking every pair
// produces only noise. A phrase counts when it repeats at least twice across what
// this person wrote, which is a low bar deliberately: it is a list of words to
// look at, not a claim about them.
function recurringPhrases(texts: string[]): { phrase: string; count: number }[] {
	const counts = new Map<string, number>();
	for (const text of texts) {
		const runs = text.match(/[\p{Script=Han}]{2,}/gu) ?? [];
		for (const run of runs) {
			// A run is scanned as overlapping pairs, so 深山老林 yields 深山 and 林,
			// not only the whole thing. Longer runs are kept whole as well.
			const seen = new Set<string>();
			for (let index = 0; index + 2 <= run.length; index++) seen.add(run.slice(index, index + 2));
			if (run.length <= 6) seen.add(run);
			for (const phrase of seen) if (!STOP.has(phrase)) counts.set(phrase, (counts.get(phrase) ?? 0) + 1);
		}
	}
	return [...counts.entries()]
		.filter(([, count]) => count >= 2)
		.sort((left, right) => right[1] - left[1])
		.slice(0, 12)
		.map(([phrase, count]) => ({ phrase, count }));
}

// Waiting for the grid is what separates "this profile has no works" from "the
// works have not rendered yet", and only the page can answer it.
async function waitForWorks(session: Session, signal: AbortSignal): Promise<void> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const state = await session.call<{ works: number }>("profile.works").catch(() => ({ works: 0 }));
		if (state.works > 0) return;
		await new Promise((resolve) => setTimeout(resolve, 150));
		signal.throwIfAborted();
	}
}

export async function readPerson(session: Session, input: Input, signal: AbortSignal): Promise<PersonEvidence> {
	const person = input.user_id ?? "";
	if (!person) throw new CliError("invalid_argument", "A user id is required");
	const limits: string[] = [
		"This reads public profile text and what the person wrote under the works visited. It does not see private messages, deleted comments or anything not currently loaded.",
		"Recurring words are counts of what they wrote, not interests this tool believes they have.",
	];
	// The profile first: the name and bio are what the person says about themselves,
	// and the work list is what they chose to publish.
	await navigate(session, `https://www.douyin.com/user/${person}`, "profile", signal);
	// The work grid fills in after the header. Reading as soon as the navigation
	// settles returned a profile that looked like it had no works at all, while the
	// same page read a moment later listed four.
	await waitForWorks(session, signal);
	const profile = await session.call<{
		name?: string;
		bio?: string;
		videos?: { url?: string; title?: string }[];
	}>("user.get", { user_id: person });
	const works = (profile.videos ?? []).slice(0, input.limit ?? 5).map((video) => ({
		id: /\/video\/(\d+)/.exec(video.url ?? "")?.[1] ?? null,
		title: (video.title ?? "").trim(),
		duration: null as number | null,
	}));
	// Their comments under other works need works to read. This account's own feed
	// is where the comments already loaded belong to whoever they were written
	// under, so the works visited are the ones just listed; anything else would be
	// reading a stranger's comment section and calling it this person's voice.
	const comments: PersonEvidence["comments"] = [];
	for (const work of works.slice(0, 3)) {
		if (!work.id) continue;
		// Each work has to be opened first: reading comments is guarded on being on
		// a work page, and jumping there from the profile reported an identity
		// mismatch rather than the comment list.
		await navigate(session, `https://www.douyin.com/video/${work.id}`, "video", signal);
		const listed = (await listComments(session, { ...input, video_id: work.id, limit: 40 }, signal)) as {
			items?: { text?: string; likes?: number | null; author_url?: string | null; stance?: string }[];
		};
		for (const item of listed.items ?? []) {
			// Only what this person wrote: the row's author id is the stable one, and a
			// display name would pull in everyone who shares it.
			if (!(item.author_url ?? "").includes(`/user/${person}`)) continue;
			comments.push({
				text: (item.text ?? "").trim(),
				likes: typeof item.likes === "number" ? item.likes : null,
				on_work: work.id,
				stance: item.stance ?? null,
			});
		}
	}
	const recurring = recurringPhrases([...comments.map((comment) => comment.text), ...works.map((work) => work.title)]);
	if (!works.length) limits.push("No works are listed on this profile, so nothing they published was read.");
	if (!comments.length)
		limits.push(
			"None of their comments were found under the works visited. That is not evidence they do not comment, only that nothing loaded matched.",
		);
	return {
		person,
		name: (profile.name ?? "").trim() || null,
		bio: (profile.bio ?? "").trim() || null,
		works,
		comments,
		recurring,
		limits,
	};
}
