import { clean, fail, findRendered, one, own, reactProps, scalarID } from "./dom.ts";
import { authenticatedUser, guardVideo } from "./readers.ts";

export function commentID(row: Element | null): string | null {
	if (!row) return null;
	const tooltips = [...row.querySelectorAll('[id^="tooltip_"]')]
		.filter((element) => element.closest('[data-e2e="comment-item"]') === row)
		.map((element) => /^tooltip_(\d+)$/.exec(element.id)?.[1]);
	const ids = [row.getAttribute("data-comment-id"), /^comment_(\d+)$/.exec(row.id)?.[1], ...tooltips].filter(
		(id): id is string => !!id && /^\d{1,64}$/.test(id),
	);
	return new Set(ids).size === 1 ? ids[0] : null;
}

export function commentRow(id: string): HTMLElement {
	// The row may be below the fold; layout presence is what makes it a target.
	// The caller scrolls it into view before clicking.
	return one(
		findRendered(document, '[data-e2e="comment-item"]').filter((element) => commentID(element) === id),
		"comment with the requested ID",
	);
}

// Who wrote one comment. A reply reaches the comment's author, which is not the
// work's author: recording the work's author there would credit the wrong person
// with the contact. Returns null when the row is not loaded, and an id of null
// when the row is there but carries no stable profile link — a display name is
// never an identity, so that case is reported rather than guessed.
export function commentAuthor(target: string): { found: boolean; author_id: string | null } {
	const row = findRendered(document, '[data-e2e="comment-item"]').find((element) => commentID(element) === target);
	if (!row) return { found: false, author_id: null };
	const ids = new Set(
		[...row.querySelectorAll<HTMLAnchorElement>('a[href*="/user/"]')]
			.map((anchor) => {
				const url = new URL(anchor.href);
				return url.origin === "https://www.douyin.com" ? (/^\/user\/([^/?#]+)/.exec(url.pathname)?.[1] ?? null) : null;
			})
			.filter((id): id is string => !!id && id !== "self"),
	);
	return { found: true, author_id: ids.size === 1 ? [...ids][0] : null };
}

// The comment list loads as the page scrolls, so a target further down is not
// in the DOM yet. One step is requested at a time; the caller waits for the
// page to load the next batch and asks again.
export function pageTowardComment(id: string): { present: boolean; moved: boolean } {
	const present = findRendered(document, '[data-e2e="comment-item"]').some((element) => commentID(element) === id);
	if (present) return { present: true, moved: false };
	const root = document.scrollingElement ?? document.documentElement;
	const before = root.scrollTop;
	root.scrollBy(0, Math.max(400, root.clientHeight * 0.8));
	return { present: false, moved: root.scrollTop !== before };
}

// The comment body no longer carries a data-e2e attribute on the live page, and
// its wrapper class changes per build. Structure is the stable part: the body
// is the row's longest free text that is not the author, the timestamp, the
// like count or an action label, and it sits before any nested reply.
const ACTION_LABELS = /^(回复|分享|展开|收起|作者赞过|作者|置顶|收起回复|\.{2,}|…+)$/;
// The expand control reads 展开2条回复 / 共3条回复 and is not comment text.
const EXPAND_LABEL = /^(?:展开|收起)?\s*(?:共)?\s*\d+\s*条回复$/;
// 周前 was missing, which let "1周前·广东" through as if it were a comment.
const TIMESTAMP =
	/(分钟前|小时前|天前|周前|昨天|前天|刚刚|月前|\d{1,2}-\d{1,2}|\d{4}-\d{1,2}-\d{1,2}|\d{4}年\d{1,2}月)/;
// Emoji in a comment are inline <img> elements whose alt is the character, so
// the element holding the sentence is not childless and was skipped entirely.
// A mention is an inline <a> for the same reason: a comment that @s someone
// wraps part of its sentence in a link, and treating that as non-inline made
// the whole body disappear.
const INLINE = new Set(["IMG", "SVG", "BR", "PICTURE", "A"]);
const EMOJI_SOURCE = /twemoji/i;

function bodyText(element: HTMLElement): string {
	// Reading the rendered text alone would drop the emoji, and reading the
	// markup would keep the file names. The alt of an emoji image is the
	// character the reader sees, so it is substituted for the image.
	const clone = element.cloneNode(true) as HTMLElement;
	for (const image of clone.querySelectorAll("img")) {
		const alt = image.getAttribute("alt") ?? "";
		const replacement = document.createTextNode(
			EMOJI_SOURCE.test(image.src) || image.src.includes("/twemoji/") ? alt : "",
		);
		image.replaceWith(replacement);
	}
	return clean(clone.textContent);
}

function commentBody(owned: (selectors: string) => HTMLElement[]): string {
	const marked = owned('[data-e2e="comment-content"],.comment-item-content');
	if (marked.length === 1) return bodyText(marked[0]);
	// The author name appears both as the profile link and as a span inside it,
	// so matching on text alone is not enough; the link subtree is excluded.
	// The header that holds the name and the timestamp is not always inside the
	// link, and a comment with only an image has no body of its own — its row's
	// longest leaf was the author's name, so the name came back as the comment.
	const authors = owned('a[href*="/user/"]');
	// The header class is `comment-item-info-wrap`. Matching "wrapper" missed it,
	// and the name's span chain sits inside the profile anchor rather than beside
	// it, so the link-subtree check alone did not reach every wrapper in the chain.
	const header = (element: HTMLElement) => !!element.closest('[class*="comment-item-info-wrap"]');
	const inAuthor = (element: HTMLElement) =>
		header(element) || authors.some((anchor) => anchor === element || anchor.contains(element));
	const leaves = owned("span,div").filter(
		(element) =>
			!inAuthor(element) &&
			// A leaf is an element with no element children, or one whose only
			// element children are inline decoration such as an emoji image.
			[...element.children].every((child) => INLINE.has(child.tagName)),
	);
	// The outermost and innermost of a chain carry the same text; keeping both
	// would let a wrapper outrank a real short comment, so the innermost wins.
	const inner = leaves.filter((element) => !leaves.some((other) => other !== element && element.contains(other)));
	const candidates = inner
		.map(bodyText)
		.filter(
			(text) =>
				text.length > 0 &&
				!ACTION_LABELS.test(text) &&
				!EXPAND_LABEL.test(text) &&
				!/^\d[\d.]*[万wW]?$/.test(text) &&
				!TIMESTAMP.test(text) &&
				!text.startsWith("@"),
		);
	// Prefer the longest candidate: comments are sentences, the surrounding
	// chrome is short.
	return candidates.sort((left, right) => right.length - left.length)[0] ?? "";
}

// A row with replies shows 展开N条回复 instead of them. The reply that was just
// sent lives in that collapsed section, so it has to be opened to be read.
// Returns the click point of the expand control, or null when already open.
export function expandControl(target: string): HTMLElement | null {
	const row = commentRow(target);
	const candidates = findRendered(row, 'button,[role="button"],span,div').filter(
		(element) =>
			element.closest('[data-e2e="comment-item"]') === row &&
			/^(?:(?:展开|查看)\s*\d*\s*条回复|查看更多回复)$/.test(clean(element.textContent)),
	);
	const leaves = candidates.filter(
		(element) => !candidates.some((other) => other !== element && element.contains(other)),
	);
	return leaves.length ? one(leaves, "comment reply expansion control") : null;
}

export function readComments(videoID: string) {
	guardVideo(videoID);
	const self = authenticatedUser();
	// Comments live below the fold, so they are matched by being laid out rather
	// than by being on screen; a viewport filter would report an empty list.
	return (
		findRendered(document, '[data-e2e="comment-item"]')
			.filter((row) => {
				const owner = row.closest("[data-aweme-id],[data-video-id]");
				const id = owner?.getAttribute("data-aweme-id") ?? owner?.getAttribute("data-video-id");
				return !id || id === videoID;
			})
			.map((row) => {
				const owned = (selectors: string) =>
					findRendered(row, selectors).filter((element) => element.closest('[data-e2e="comment-item"]') === row);
				const content = commentBody(owned);
				const images = owned('img[data-e2e="comment-image"],img.duf1cdUE')
					.filter(
						(element): element is HTMLImageElement =>
							element instanceof HTMLImageElement && !element.closest('a[href*="/user/"]'),
					)
					.map((image) => ({
						ready: image.complete && image.naturalWidth > 0,
						source_available: !!(image.currentSrc || image.getAttribute("src")),
					}));
				// A voice comment is a player control, not text. The platform attaches
				// its own transcript when it can; a missing transcript is reported as
				// null rather than mistaken for an empty comment.
				const voiceNode = owned(
					'[data-e2e="comment-voice"],audio,[class*="commentVoice"],[class*="CommentVoice"],[class*="udioComment"]',
				)[0];
				const kind: "text" | "image" | "voice" = voiceNode ? "voice" : !content && images.length ? "image" : "text";
				const voice = voiceNode
					? {
							transcript: (() => {
								const node = owned('[data-e2e="voice-transcript"],[class*="transcript"],[class*="ranscript"]')[0];
								const text = clean(node?.textContent);
								return text || null;
							})(),
							// The player labels its length as 3'' or 03:12; either is the
							// duration the reader sees, and neither is guessed.
							duration: (() => {
								const label = clean(voiceNode.textContent);
								const seconds = /(\d+)\s*['′]{1,2}/.exec(label)?.[1];
								if (seconds) return Number(seconds);
								const clock = /(\d+):(\d{2})/.exec(label);
								return clock ? Number(clock[1]) * 60 + Number(clock[2]) : null;
							})(),
						}
					: null;
				// ALink is the site's own link component, not a per-build class, so it
				// survives rebuilds where the wrapper class does not.
				const anchors = owned(
					'.comment-item-avatar a[href],a[data-e2e="comment-author"],a.ALink-a[href*="/user/"]',
				) as HTMLAnchorElement[];
				const userID = (anchor: HTMLAnchorElement): string | undefined => {
					const url = new URL(anchor.href);
					return url.origin === "https://www.douyin.com" ? /^\/user\/([^/]+)\/?$/.exec(url.pathname)?.[1] : undefined;
				};
				// A comment can @ people, and each mention is a /user/ link inside the
				// body. Counting every link made an @-heavy comment look ambiguous and
				// left its author empty. The author is the link that carries the
				// avatar or the name, not one that starts with @.
				const body = row.querySelector('[data-e2e="comment-content"],.comment-item-content');
				const authors = anchors.filter((anchor) => {
					if (anchor.closest('[data-e2e="comment-content"],.comment-item-content') !== body) return true;
					// Inside the body, a mention is identifiable by its text; an author
					// link is not rendered there.
					return !clean(anchor.textContent).startsWith("@");
				});
				const ids = new Set(authors.map(userID).filter((id): id is string => !!id));
				const authorID = ids.size === 1 ? [...ids][0] : null;
				const matchingAuthors = authors.filter((candidate) => userID(candidate) === authorID);
				const author = authorID
					? (matchingAuthors.find((candidate) => clean(candidate.textContent)) ?? matchingAuthors[0])
					: null;
				const marker =
					row.getAttribute("data-is-self") === "true" ||
					row.getAttribute("data-author-is-self") === "true" ||
					owned('[data-e2e="comment-self"]').length === 1;
				const mine = marker || !!(self && authorID === self);
				// The comment's own like count is what tells whether anyone read it.
				// It sits in the stats container beside 分享 and 回复, and the page
				// gives it no data-e2e of its own — a count is the only numeric leaf
				// there that is not a timestamp or a reply total.
				const stats = owned('[class*="comment-item-stats"]')[0];
				const likeText = stats
					? clean(
							[...stats.querySelectorAll("span,div")]
								.filter((element) => !element.children.length)
								.map((element) => clean(element.textContent))
								.find((text) => /^\d[\d.]*[万wW]?$/.test(text)),
						)
					: "";
				const likes = likeText
					? /[万wW]$/.test(likeText)
						? Math.round(Number.parseFloat(likeText) * 10_000)
						: Number.parseInt(likeText, 10)
					: null;
				// "作者赞过" is the platform saying the work's author acknowledged
				// this comment, which is stronger evidence than a like count.
				const likedByAuthor = owned("*")
					.filter((element) => !element.children.length)
					.some((element) => clean(element.textContent) === "作者赞过");
				const status = row.getAttribute("data-send-status") ?? row.getAttribute("data-comment-status") ?? "";
				const pending =
					/pending|sending|reviewing/.test(status) ||
					owned('[data-e2e="comment-pending"],[aria-busy="true"]').length > 0;
				const failed = /failed|rejected|error/.test(status) || owned('[data-e2e="comment-failed"]').length > 0;
				return {
					id: commentID(row),
					video_id: videoID,
					parent_id:
						row.getAttribute("data-parent-comment-id") ??
						commentID(row.parentElement?.closest('[data-e2e="comment-item"]') ?? null),
					text: content,
					kind,
					...(voice ? { voice } : {}),
					images,
					author: clean(author?.textContent),
					author_url: author?.href ?? null,
					likes,
					liked_by_author: likedByAuthor,
					mine,
					pending,
					failed,
					sent: !!commentID(row) && mine && !pending && !failed,
				};
			})
			// A voice comment with no transcript has neither text nor images, and
			// dropping it is what made them read as missing rather than as voice.
			.filter((comment) => comment.id && (comment.text || comment.images.length || comment.kind === "voice"))
	);
}

// The placeholder can show a display name, but names are not comment identities.
function replyMarker(root: HTMLElement): { id: string | null; author: string | null } {
	const ids = new Set<string>();
	for (const element of [root, ...root.querySelectorAll('[data-reply-comment-id],[data-e2e="comment-reply-target"]')]) {
		const native =
			element.getAttribute("data-reply-comment-id") ??
			(element.matches('[data-e2e="comment-reply-target"]') ? element.getAttribute("data-comment-id") : null);
		if (native) ids.add(native);
		for (const props of reactProps(element)) {
			for (const field of ["replyComment", "replyTo", "replyInfo"]) {
				const value = own(props, field);
				const id = scalarID(own(value, "cid")) ?? scalarID(own(value, "comment_id")) ?? scalarID(own(value, "id"));
				if (id) ids.add(id);
			}
		}
	}
	if (ids.size > 1) fail("identity_mismatch", "Reply target is ambiguous");
	const markers = findRendered(document, '[id^="placeholder-"]').map((element) => clean(element.textContent));
	const authors = new Set<string>();
	for (const marker of markers) {
		const match = /^回复\s*[@＠]\s*(.+)$/.exec(marker);
		if (match) authors.add(match[1].trim());
	}
	if (authors.size > 1) fail("identity_mismatch", "Reply target author is ambiguous");
	return { id: [...ids][0] ?? null, author: [...authors][0] ?? null };
}

// Reports whether the composer is already bound to the requested comment, so a
// caller does not re-click a control that has become 回复中.
export function replyState(target: string): { bound_to: string | null; author: string | null } {
	const editors = findRendered(
		document,
		'.comment-input-container [contenteditable="true"],.comment-input-container textarea,.comment-input-inner-container [contenteditable="true"],.comment-input-inner-container textarea,.public-DraftEditor-content',
	);
	if (!editors.length) return { bound_to: null, author: null };
	const root = editors[0].closest<HTMLElement>(".comment-input-container,.comment-input-inner-container");
	if (!root) return { bound_to: null, author: null };
	const marker = replyMarker(root);
	if (marker.id !== null) return { bound_to: marker.id, author: marker.author };
	// The composer may be bound without a placeholder: the target row then
	// renders 回复中, which is the page stating this comment is the reply target.
	const row = findRendered(document, '[data-e2e="comment-item"]').find((element) => commentID(element) === target);
	const active = row
		? findRendered(row, "span,div").some(
				(element) => element.closest('[data-e2e="comment-item"]') === row && clean(element.textContent) === "回复中",
			)
		: false;
	if (active) return { bound_to: target, author: marker.author };
	return { bound_to: null, author: marker.author };
}

export function commentEditor(commentID?: string, allowMedia = false) {
	// The composer is laid out as soon as the reply control is activated; a
	// viewport check here would race the page's own scroll into position.
	const editors = findRendered(
		document,
		'.comment-input-container [contenteditable="true"],.comment-input-container textarea,.comment-input-inner-container [contenteditable="true"],.comment-input-inner-container textarea,[data-e2e="comment-input"] [contenteditable="true"],textarea[data-e2e="comment-input"],[contenteditable="true"][data-e2e="comment-input"],.public-DraftEditor-content',
	).filter((element) => !element.closest('[data-e2e="im-dialog"],[data-e2e="danmaku-container"]'));
	if (!editors.length) fail("editor_not_ready", "Comment editor is not active");
	const editor = one(editors, "public comment editor");
	// The composer opened from a reply control on the live page is bounded by
	// comment-input-inner-container only; .comment-input-container is not always
	// present, so both are accepted.
	const root =
		editor.closest<HTMLElement>(
			'.comment-input-container,.comment-input-inner-container,[data-e2e="comment-composer"]',
		) ?? editor.parentElement;
	if (!root) fail("selector_changed", "No bounded comment composer");
	// A reply needs the composer bound to that comment; a top-level post must not
	// be in reply state at all, or the text would land under someone else's
	// comment instead of on the work. replyState() is the single place that
	// resolves the page's several ways of showing that binding.
	if (commentID) {
		const bound = replyState(commentID);
		if (bound.bound_to !== commentID)
			fail("identity_mismatch", "Comment composer is not in reply state for this comment");
	} else {
		const marker = replyMarker(root);
		if (
			marker.id !== null ||
			marker.author !== null ||
			root.querySelector('[data-e2e="comment-reply-target"],.PPsJmqBy')
		)
			fail("identity_mismatch", "Comment composer is bound to a reply target");
	}
	if (
		!allowMedia &&
		(root.querySelector<HTMLInputElement>('input[type="file"]')?.files?.length ||
			editor.querySelector('img,video,audio,[data-slate-void="true"]'))
	) {
		fail("draft_conflict", "Comment composer contains media");
	}
	return { editor, root };
}
