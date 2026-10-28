import { CliError } from "../errors.ts";

// A need signal is what a person says about what they want, in their own words.
// This is deliberately not a similarity score: "we both talk about 装修" is not a
// lead, and a buyer says "求推荐" and means it. So the job here is narrow — find
// explicit requests in text the caller already read, quote them, and say what
// the quote does and does not prove.

// Expressions people actually use to ask for something. Grouped so the result
// can say which kind of request it is; a question like "好用吗" is research, not
// a purchase.
const ASKING =
	/(求推荐|求链接|求个|请问有|有没有人知道|有没有.{0,12}推荐|哪有|哪里买|在哪买|怎么买|多少钱|价格|报价|想找|找谁|谁做|推荐一下|有推荐|能推荐|求带|求个联系方式|怎么联系)/;
const INTENT = /(想做|准备做|打算做|需要|想装|要装|预算|咨询|合作|接单|能不能做|做不做)/;
// A bare product name is not a need; it is a topic, and that is a different
// answer. Keeping the two apart is the whole point of this command.
const NEGATIVE = /(不用了|不需要|已经买了|买过了|已经有|不感兴趣|别推荐)/;

export interface Signal {
	text: string;
	quote: string;
	kind: "asking" | "intent" | "research";
	confidence: number;
	why: string;
}

export interface SignalSource {
	person: string;
	name?: string;
	where?: string;
	source?: string;
	text: string;
}

// Sentence-ish splits for text written by people, not by a typesetter. Chinese
// ends a sentence with any of these, and often with nothing at all; a line break
// or a long stretch is the practical boundary.
function segments(text: string): string[] {
	return text
		.split(/[\n。！？!?；;]+/)
		.map((part) => part.trim())
		.filter((part) => part.length >= 2);
}

export function extractSignals(input: { text: string }): Signal[] {
	const found: Signal[] = [];
	for (const segment of segments(input.text)) {
		if (NEGATIVE.test(segment)) continue;
		const asking = ASKING.test(segment);
		const intent = INTENT.test(segment);
		// Research: an evaluation question with no request attached. It belongs in
		// the list so the caller can see the person is in the market, but it is not
		// a lead and must not be counted as one.
		const research = !asking && !intent && /(好用吗|值不值|哪个好|区别|对比|怎么样)/.test(segment);
		if (!asking && !intent && !research) continue;
		const kind: Signal["kind"] = asking ? "asking" : intent ? "intent" : "research";
		found.push({
			text: segment,
			quote: segment,
			kind,
			// Asking is stronger evidence than describing an intention, and
			// comparing products is weaker than both: it says the person is looking,
			// not that they are asking.
			confidence: kind === "asking" ? 0.7 : kind === "intent" ? 0.5 : 0.2,
			why:
				kind === "asking"
					? "An explicit request for a recommendation, a contact or a price."
					: kind === "intent"
						? "States an intention or a need, without asking anyone for it yet."
						: "Comparing options. This says they are looking, not that they asked.",
		});
	}
	return found;
}

export function signals(input: { sources: SignalSource[]; limit?: number }) {
	const people = input.sources
		.filter((source) => source.person && typeof source.text === "string" && source.text.trim())
		.slice(0, input.limit ?? 50)
		.map((source) => {
			const found = extractSignals({ text: source.text });
			return {
				person: source.person,
				name: source.name ?? "",
				where: source.where ?? "",
				source: source.source ?? "",
				signals: found,
				// A need is not a lead until someone answers it. Saying so here keeps
				// the caller from treating a phrase match as a qualified buyer.
				summary: found.length
					? `${found.filter((signal) => signal.kind === "asking").length} explicit request(s)`
					: "No explicit need found in what was read",
			};
		});
	return {
		people,
		total: people.reduce((count, person) => count + person.signals.length, 0),
		scope: "caller_supplied_text",
		limitations: [
			"Judged from text the caller supplied; this command does not read the platform.",
			"A phrase match is a quoted request, not a qualified buyer.",
			"Negative statements (already bought, not interested) are excluded rather than scored.",
		],
	};
}

export function parseSources(raw: unknown): SignalSource[] {
	if (!Array.isArray(raw)) throw new CliError("invalid_argument", "--sources must be a JSON array");
	return raw.flatMap((entry: unknown) => {
		if (!entry || typeof entry !== "object") return [];
		const item = entry as Record<string, unknown>;
		const text = (key: string) => (typeof item[key] === "string" ? (item[key] as string) : "");
		if (!text("person") || !text("text")) return [];
		return [
			{
				person: text("person"),
				name: text("name"),
				where: text("where"),
				source: text("source"),
				text: text("text"),
			},
		];
	});
}
