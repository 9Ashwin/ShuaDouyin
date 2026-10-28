// Pure text rules for the live chat. Kept out of the page adapter so they can be
// tested in node: the adapter runs inside the page and cannot be imported here,
// and these are exactly the rules that were wrong on the first attempt.

export type ChatKind = "chat" | "gift" | "join" | "system";

export interface Classified {
	author: string;
	text: string;
	kind: ChatKind;
}

// A line with an author separator is someone speaking, whatever words it
// contains. "示例用户：一下就回来了" ends with 来了 and was counted as a join
// until the separator was taken as the deciding mark.
const SEPARATOR = /^(.{1,40}?)[:：]\s*([\s\S]+)$/;
const GIFT_BODY = /送出了|送给主播/;
const COUNTED = /[×x]\s*\d+/;
const SYSTEM = /欢迎来到直播间|严禁|理性消费|公告/;
const JOIN = /^\S{1,40}\s*(来了|进入了直播间)$/;

export function classifyLine(raw: string): Classified {
	const text = raw.replace(/\s+/g, " ").trim();
	const match = SEPARATOR.exec(text);
	const author = match ? match[1].trim() : "";
	const body = match ? match[2].trim() : text;
	const kind: ChatKind = SYSTEM.test(text)
		? "system"
		: GIFT_BODY.test(body) && COUNTED.test(body)
			? "gift"
			: !match && JOIN.test(text)
				? "join"
				: "chat";
	return { author, text: body, kind };
}

// The panel is the authority on price. A caller naming a different price for an
// item must not be able to send it, and a name that is not there at all is not
// a near miss to be resolved by position.
export function giftMatches(item: { name: string; price: number | null }, name: string, price: number): boolean {
	return item.name === name && item.price === price;
}

// The panel writes each gift as "<price>钻<name><price>钻赠送". The name sits
// between the two prices; taking the whole label as the name would never match.
export function parseGiftLabel(label: string): { name: string; price: number } | null {
	const match = /^(\d+)\s*钻\s*(.+?)\s*(\d+)\s*钻/.exec(label.replace(/\s+/g, " ").trim());
	if (!match) return null;
	const name = match[2].trim();
	if (!name) return null;
	return { name, price: Number(match[1]) };
}

// What the room says was sent, compared against what was asked for. Anything the
// room reports that was not requested still left the account, so it is returned
// rather than filtered away.
export function giftOutcome(sent: { text: string; author: string }[], selfName: string, asked: string) {
	const mine = sent.filter((row) => !!selfName && row.author === selfName);
	return {
		mine: mine.map((row) => row.text),
		matched: mine.filter((row) => row.text.includes(asked)).length,
		unexpected: mine.filter((row) => !row.text.includes(asked)).map((row) => row.text),
	};
}
