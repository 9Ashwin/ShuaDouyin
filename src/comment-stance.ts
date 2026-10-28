// A comment section is not a review section. The strongest reading of a real
// feed walkthrough was that most comments talk about the commenter — their
// memories, their feelings, the story the work reminds them of — and only some
// address the work itself. That difference decides whether a reply is worth
// writing and what it should say, so it is made explicit rather than guessed at
// when writing one.

export type Stance = "about_work" | "about_self" | "asking" | "spam" | "unknown";

export type CommentStance = Stance;

export interface StanceResult {
	stance: Stance;
	// What in the text produced the verdict. A label with no evidence is not
	// reviewable, and this project does not ship labels a reader cannot check.
	signals: string[];
}

const WORK_REFERENCE =
	/(这个视频|这条视频|这歌|这首歌|这段|这个舞|这音乐|唱得|唱功|嗓子|嗓音|声音|编曲|旋律|歌词|高潮|开头|节奏|剪辑|运镜|画面|拍得|拍成|灯光|穿搭|背景|镜头|vlog|视频里|原作|原唱)/;
const SELF_STATEMENT =
	/(我想|我想起|让我|我记得|我哭|我笑|我听了|我看|我年轻|我已经|我再|我曾|我前女友|我老公|我老婆|我妈|我爸|我儿子|我女儿|曾经|当年|那年|以前|那时候|再也回不去|想起|怀念|放不下|忘不了|释然|单身|结婚|离婚|分手|前任|初恋|告别|好久没有|追了好|追到|听到|看到|听完|看完|泪目|破防|哭了|笑了)/;
const ADDRESSING_AUTHOR =
	/(姐姐|主播|作者|主包|博主|宝宝|大大|老师|点歌|求更新|更新了|能不能|可以拍|唱一下|唱一个|下次|求个|求推荐)/;
const ASKING = /[?？]|吗$|呢$|有没有|谁知道|哪里|什么|怎么|是不是|请问/;
const SPAM = /(互关|互赞|加微信|加v|私聊我|主页有|点我头像|免费领|赚钱|兼职|代刷|上车|项目|日入|招人)/i;

export function classifyComment(text: string): StanceResult {
	const body = text.replace(/\s+/g, " ").trim();
	if (!body) return { stance: "unknown", signals: [] };
	if (SPAM.test(body)) return { stance: "spam", signals: ["advertisement or mutual-follow wording"] };
	const work = WORK_REFERENCE.exec(body)?.[0];
	const self = SELF_STATEMENT.exec(body)?.[0];
	const addressing = ADDRESSING_AUTHOR.exec(body)?.[0];
	const asking = ASKING.test(body);
	// A question aimed at the author or the room is asking, whatever else is in
	// it: answering a question is a different act from joining a conversation.
	if (asking && (addressing || work)) {
		return {
			stance: "asking",
			signals: [`question mark or question wording`, ...(addressing ? [`addressed at "${addressing}"`] : [])],
		};
	}
	// The author is addressed directly: that is about the work and its maker.
	if (addressing) return { stance: "about_work", signals: [`addresses the creator with "${addressing}"`] };
	// Someone describing their own reaction is talking about themselves even when
	// the sentence mentions the work: "每次听到这首歌鸡皮疙瘩都起来了" is a personal
	// experience, not an observation about the song. The first person decides.
	if (self) return { stance: "about_self", signals: [`narrates the commenter's own experience with "${self}"`] };
	if (work) return { stance: "about_work", signals: [`refers to the work with "${work}"`] };
	// Nothing points clearly either way. Saying unknown is the honest answer:
	// guessing here would put a label on most of a comment section that nobody
	// could defend.
	return { stance: "unknown", signals: [] };
}
