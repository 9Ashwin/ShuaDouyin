// What makes Chinese prose read as machine-written, as a check rather than a
// style note.
//
// The catalog is adapted from the Chinese cue list in PenguinHarness's humanizer
// skill (github.com/Prism-Shadow/penguin-harness, Apache-2.0), which was built
// from seven rounds of drafting, blind review and revision. Two things are
// different here. That skill is advice a model reads and applies; this is a
// function, so the tool can point at the exact phrase instead of hoping a caller
// remembers the rule. And it keeps the list's second half — the markers of
// over-correction — because scrubbing every tell out is its own way of reading as
// machine-written.

export interface Tell {
	// The pattern family, stable enough to group results by.
	id: string;
	// What it is, in the words a writer would use.
	name: string;
	// The matched text, so the reader can see what it points at.
	match: string;
	// Where in the string it starts.
	index: number;
	// Why it reads as a tell.
	why: string;
}

interface Rule {
	id: string;
	name: string;
	pattern: RegExp;
	why: string;
}

// Every rule is a pattern the text either has or does not have. A rule that
// needed judgement about intent would be a guess dressed as a check, and this is
// meant to be the opposite of that.
const RULES: Rule[] = [
	{
		id: "reversal",
		name: "翻案句",
		// The two halves are separated by a comma in ordinary Chinese ("这不是X，
		// 而是Y"), so a pattern that stopped at punctuation never matched the most
		// common shape of it.
		pattern: /不是[^。！？\n]{1,24}而是|不只是[^。！？\n]{1,24}更是|不在于[^。！？\n]{1,24}而在于/g,
		why: "先立一个错的再推翻，是最典型的模型句式。直接说要说什么。",
	},
	{
		id: "era-opener",
		name: "时代开场",
		// Two shapes of the same move. One names a period: "在……的今天/时代/背景下".
		// The other leans 在 against the period directly — "在当今……时代" has
		// modifiers between 的 and 时代, so a pattern expecting them next to each
		// other never matched the most common spelling of it.
		pattern:
			/在[^。！？\n]{0,12}的(今天|时代|背景下)|在(当今|如今|现在|这个)[^。！？\n]{0,10}(时代|社会|背景)|随着[^。！？\n]{1,16}的(发展|普及|兴起)/g,
		why: "宏大开场没有信息量，读者要看的是具体那件事。",
	},
	{
		id: "lift-ending",
		name: "结尾升华",
		pattern: /未来已来|的故事仍在继续|让我们(共同)?(期待|见证)|值得我们?深思/g,
		why: "把话说满了反而收不住，事件讲完就结束。",
	},
	{
		id: "triple",
		name: "三连排比",
		pattern: /([\p{L}]{2,6})、([\p{L}]{2,6})、([\p{L}]{2,6})/gu,
		why: "三项并列三连句是模型的节拍器，多数时候两项或直接写清楚更准。",
	},
	{
		id: "roadsign",
		name: "显性路标",
		// The comma is optional: "首先要有意识" is the same road sign as "首先，".
		pattern: /首先|其次|总而言之|综上所述|值得注意的是|最后才是/g,
		why: "写清楚内容本身就是导航，不需要另贴标签。",
	},
	{
		id: "self-note",
		name: "自我注解",
		pattern: /这意味着|这标志着|这就是为什么/g,
		why: "陈述完再补一句解释其意义，等于说两遍。",
	},
	{
		id: "symbolic",
		name: "象征膨胀",
		pattern: /见证了|承载着|彰显了|是.{0,8}的缩影|书写了.{0,8}篇章/g,
		why: "把普通事实说成历史时刻，读者会觉得被推销。",
	},
	{
		id: "jargon",
		name: "机构腔",
		pattern: /赋能|打造|助力|闭环|抓手|擦亮名片|进行(优化|梳理|调整)|加以(解决|改进)/g,
		why: "公文动词和小圈子黑话，人说话不这样。",
	},
	{
		id: "pseudo-hedge",
		name: "伪对冲",
		pattern: /某种意义上|一定程度上|或许正是|不无道理/g,
		why: "看起来谨慎，其实什么都没限定，比直接说更空。",
	},
	{
		id: "phantom-crowd",
		name: "幽灵人群",
		pattern: /比多数人预想的|超出很多人的想象|很多人都不知道/g,
		why: "谁在预想？没有指向的比较是空的。",
	},
	{
		id: "restate",
		name: "同义复读",
		pattern: /换句话说|也就是说|简而言之/g,
		why: "同一件事说第二遍。第一遍说明白就不需要这句。",
	},
	{
		id: "colon-definition",
		name: "定义腔",
		// Only the shape that is unmistakably a definition: a short noun phrase
		// followed by a colon and a full clause — "手冲的本质：一场与时间的对话".
		// Trying to exclude ordinary sentences by looking for a subject made the
		// pattern too clever to trust, and a check that cries wolf is worse than
		// no check. Requiring 的本质/的核心/的意义 narrows it to what it names.
		pattern: /[^：\n]{0,10}(的本质|的核心|的意义|的秘密)：[^\n]{6,}/g,
		why: "「本质：一场……」这种冒号定义腔是标题模板，不是判断。",
	},
];

// The other failure: a text scrubbed until it reads like a checklist. These do
// not fail a check the same way — one of them is fine — but several together
// mean the writing was driven by a rulebook rather than by what it had to say.
const OVERCORRECTED: Rule[] = [
	{
		id: "comma-chain",
		name: "逗号串",
		// The tell is a long run of clauses joined by commas with no full stop to
		// end the sentence — four commas is where it starts reading as one breath.
		// Requiring six characters per clause was too strict: the run that appears
		// in practice has short clauses.
		pattern: /[^，。！？；\n]{3,}，[^，。！？；\n]{3,}，[^，。！？；\n]{3,}，[^，。！？；\n]{3,}，/g,
		why: "七个分句一逗到底，是把句号全删了的痕迹。",
	},
	{
		id: "uniform-short",
		name: "等长短句链",
		pattern: /(?:^|[。！？])([\p{L}]{2,6}。){3,}/gu,
		why: "四五个同长主谓短句连排，是留白节拍器，人写的段落会有长有短。",
	},
	{
		id: "judgement-series",
		name: "判断句系列",
		pattern: /的是[^，。]{2,10}。/g,
		why: "连续用「……的是X」承重，同一句型当引擎，读起来就假了。",
	},
];

export interface Verdict {
	// The tells found in the drafting sense.
	tells: Tell[];
	// Markers of a text scrubbed past natural.
	overcorrected: Tell[];
	// One judgement, so a caller does not have to interpret the counts.
	verdict: "reads-human" | "still-ai" | "over-corrected";
	// What to do about it, in the order worth doing.
	guidance: string[];
}

function collect(text: string, rules: Rule[]): Tell[] {
	const found: Tell[] = [];
	for (const rule of rules) {
		// A global regex keeps lastIndex between calls, so each rule gets its own.
		const pattern = new RegExp(rule.pattern.source, rule.pattern.flags);
		for (const match of text.matchAll(pattern)) {
			if (typeof match.index !== "number") continue;
			found.push({
				id: rule.id,
				name: rule.name,
				match: match[0],
				index: match.index,
				why: rule.why,
			});
		}
	}
	return found.sort((left, right) => left.index - right.index);
}

export function checkVoice(text: string): Verdict {
	const body = text.replace(/\s+/g, " ").trim();
	const tells = collect(body, RULES);
	const overcorrected = collect(body, OVERCORRECTED);
	// Two or more of the same family, or three different families, is a pattern
	// rather than one unlucky phrase.
	const families = new Map<string, number>();
	for (const tell of tells) families.set(tell.id, (families.get(tell.id) ?? 0) + 1);
	const repeated = [...families.values()].some((count) => count > 1);
	// One over-correction marker is enough on its own: a seven-clause comma run is
	// not a stray, it is the shape of a text that had every full stop deleted.
	const verdict: Verdict["verdict"] =
		tells.length >= 3 || repeated ? "still-ai" : overcorrected.length >= 1 ? "over-corrected" : "reads-human";
	const guidance: string[] = [];
	if (tells.length)
		guidance.push(`删掉这些：${[...new Set(tells.map((tell) => tell.name))].join("、")}。它们各自都有为什么。`);
	if (verdict === "over-corrected")
		guidance.push("痕迹是「把 AI 味擦干净」留下的：句子被削得一样长了。让段落有长有短，允许一句平常的话结尾。");
	// The one rule that matters more than the whole catalog, and the one the
	// source skill calls out as the way every overdriven rule mints a new tell.
	if (verdict === "reads-human") guidance.push("读起来没问题。别为了让分数更好看再改一遍。");
	return { tells, overcorrected, verdict, guidance };
}
