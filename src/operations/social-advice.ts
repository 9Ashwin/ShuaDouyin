import type { ResponseWindow } from "./response-window.ts";
import type { Card, Vocabulary } from "./social.ts";

// What to do next with someone, proposed rather than done.
//
// The loop was missing the step between "I sent something" and "they are a
// contact": nothing looked at whether anything came back before deciding to keep
// going. Now that the response window is a fact the tool can read, this turns it
// into a recommendation.
//
// It recommends and stops. The stage command already refuses to infer "connected"
// from anything but a stated decision, and a later version of this module must not
// become the back door to that — a proposal is shown to a caller, who can disagree
// with the reasons, and nothing is written until someone acts on it.

export type AdviceKind =
	// Keep going: they answered, so the conversation has somewhere to go.
	| "continue"
	// Wait: something was sent recently and nothing has had time to come back.
	| "wait"
	// Stop: repeated messages with nothing back, over a period that rules out timing.
	| "stop"
	// Ask: the facts do not decide it, and pretending otherwise would be a guess.
	| "unknown";

export interface Advice {
	kind: AdviceKind;
	// One sentence a caller can act on.
	say: string;
	// What in the window led here, so the caller can disagree with the reasoning.
	reasons: string[];
	// What this did not consider.
	limits: string;
}

// How long silence has to last before it means something. Shorter than this and
// the answer is "wait", because a share sent an hour ago is not being ignored.
const WAIT_HOURS = 24;
// Two messages into silence is a conversation that has not started. One is often
// just the first thing anyone says.
const IGNORED_MESSAGES = 2;

export function advise(card: Card, window: ResponseWindow): Advice {
	const reasons: string[] = [];
	const limits =
		"This reads direction, timing and the card's own history. It cannot tell a message that was never opened from one that was read and not answered, and it does not read what any reply said.";
	if (window.answered > 0) {
		reasons.push(`对方回过 ${window.answered} 次`);
		if (window.median_reply_hours !== null) reasons.push(`中位回得隔 ${window.median_reply_hours} 小时`);
		if (window.unanswered.length) reasons.push(`还有 ${window.unanswered.length} 条没回`);
		return {
			kind: "continue",
			// Answered once means the channel works. What to send is the caller's
			// judgement, so this says only whether continuing is supported.
			say: "对方回过话，继续是有依据的。说什么要看具体内容，不是这一步能定的。",
			reasons,
			limits,
		};
	}
	if (window.only_outgoing) {
		const oldest = window.unanswered.reduce<number | null>(
			(max, entry) => (entry.hours_waiting === null ? max : Math.max(max ?? 0, entry.hours_waiting)),
			null,
		);
		const count = window.unanswered.length;
		reasons.push(`${count} 条发出去，一条都没回`);
		if (oldest !== null) reasons.push(`最久的一条等了 ${oldest} 小时`);
		// Both conditions have to hold. A single message from this morning is not
		// evidence of being ignored, and neither is two messages sent an hour ago.
		if (count >= IGNORED_MESSAGES && oldest !== null && oldest >= WAIT_HOURS)
			return {
				kind: "stop",
				say: `发了 ${count} 条、最久等了 ${oldest} 小时都没有回应，继续发是在打扰。停下来，或者换别人。`,
				reasons,
				limits,
			};
		return {
			kind: "wait",
			say:
				count >= IGNORED_MESSAGES
					? `发了几条还没回，但最久的才 ${oldest ?? 0} 小时。再等等，别追。`
					: "只发过一条，还没到能判断的时候。",
			reasons,
			limits,
		};
	}
	const lastIncoming = window.last_incoming_at;
	const lastOutgoing = window.last_outgoing_at;
	if (lastIncoming && lastOutgoing) {
		const mine = Date.parse(lastOutgoing);
		const theirs = Date.parse(lastIncoming);
		if (Number.isFinite(mine) && Number.isFinite(theirs) && theirs > mine) {
			reasons.push("最后一条是对方发的");
			return {
				kind: "continue",
				say: "最后一句是对方说的，接下去是自然的。",
				reasons,
				limits,
			};
		}
	}
	if (lastIncoming) {
		reasons.push(`对方最后一次说话在 ${lastIncoming}`);
		return {
			kind: "continue",
			say: "对方主动说过话，这条线是活的。",
			reasons,
			limits,
		};
	}
	reasons.push("这个窗口里没有对方的消息");
	return {
		kind: "unknown",
		say:
			card.contact_count > 0
				? "卡片记着联系过，但当前会话没有对方的消息。可能不在这个会话里，也可能是窗口没加载到。"
				: "还没有联系记录，也没有对方的消息。先看这个人的主页和公开评论区，别急着私信。",
		reasons,
		limits,
	};
}

// What the proposal would change, stated without changing it.
export function wouldSetStage(card: Card, advice: Advice, vocabulary: Vocabulary): string | null {
	if (advice.kind !== "continue") return null;
	// The only stage this ever suggests is the one the vocabulary says evidence can
	// reach. Anything past it is a claim about the other person, and a proposal has
	// no more standing to make that claim than an inference does.
	const current = vocabulary.stages.indexOf(card.stage);
	const reachable = vocabulary.stages[Math.min(card.contact_count + 1, vocabulary.evidence_stops_at)];
	if (!reachable || current < 0 || vocabulary.stages.indexOf(reachable) <= current) return null;
	return reachable;
}
