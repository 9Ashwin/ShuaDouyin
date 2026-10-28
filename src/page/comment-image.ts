import { commentEditor } from "./comments.ts";
import { clean, editorHasDraft, fail, find, one, point } from "./dom.ts";
import { installGuard, publishIcon } from "./interactions.ts";
import { guardVideo } from "./readers.ts";

declare global {
	interface Window {
		__dyCommentImage?: {
			token: string;
			accepted: boolean;
			blocked: boolean;
			expired: boolean;
			interfered: boolean;
			publishButton?: HTMLElement;
			preflight: () => void;
			cleanup: () => void;
			timer?: ReturnType<typeof setTimeout>;
		};
	}
}

export function prepareCommentImage(
	videoID: string,
	commentID: string | undefined,
	token: string,
	name: string,
	size: number,
	mime: string,
) {
	guardVideo(videoID);
	const { editor, root } = commentEditor(commentID);
	if (editorHasDraft(editor)) fail("draft_conflict", "Comment composer already contains a draft");
	const inputs = [...root.querySelectorAll<HTMLInputElement>('input[type="file"]')];
	if (inputs.length !== 1 || inputs[0].disabled || inputs[0].files?.length)
		fail("draft_conflict", "Image input is unavailable or contains a draft");
	const input = inputs[0];
	window.__dyCommentImage?.cleanup();
	input.setAttribute("data-dy-comment-image", token);
	const state: NonNullable<Window["__dyCommentImage"]> = {
		token,
		accepted: false,
		blocked: false,
		expired: false,
		interfered: false,
		preflight: () => {},
		cleanup: () => {},
	};
	const checkTarget = () => {
		guardVideo(videoID);
		if (
			!root.isConnected ||
			!editor.isConnected ||
			!input.isConnected ||
			!root.contains(editor) ||
			!root.contains(input) ||
			input.getAttribute("data-dy-comment-image") !== token
		)
			fail("identity_mismatch", "Comment image target changed");
		const current = commentEditor(commentID, true);
		if (current.editor !== editor || current.root !== root) fail("identity_mismatch", "Comment composer changed");
	};
	state.preflight = () => {
		checkTarget();
		if (
			state.expired ||
			state.interfered ||
			editorHasDraft(editor) ||
			input.files?.length ||
			root.querySelector('img,video,audio,[data-slate-void="true"]')
		)
			fail("draft_conflict", "Comment draft changed before image upload");
	};
	const listener = (event: Event) => {
		if (event.target !== input) return;
		const files = input.files;
		if (!files || files.length !== 1 || files[0].name !== name || files[0].size !== size || files[0].type !== mime) {
			state.interfered = true;
			return;
		}
		try {
			checkTarget();
			if (
				state.expired ||
				state.interfered ||
				editorHasDraft(editor) ||
				(!state.accepted && root.querySelector('img,video,audio,[data-slate-void="true"]'))
			)
				fail("draft_conflict", "Comment draft changed before upload");
			state.accepted = true;
		} catch {
			state.blocked = true;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	const observeEdit = (event: Event) => {
		if (event.type === "click" && event.target instanceof Node && state.publishButton?.contains(event.target)) return;
		if (
			event.target instanceof Node &&
			root.contains(event.target) &&
			["beforeinput", "paste", "drop", "click"].includes(event.type)
		)
			state.interfered = true;
	};
	for (const type of ["input", "change"]) document.addEventListener(type, listener, true);
	for (const type of ["beforeinput", "paste", "drop", "click"]) document.addEventListener(type, observeEdit, true);
	state.cleanup = () => {
		if (state.timer) clearTimeout(state.timer);
		for (const type of ["input", "change"]) document.removeEventListener(type, listener, true);
		for (const type of ["beforeinput", "paste", "drop", "click"]) document.removeEventListener(type, observeEdit, true);
		input.removeAttribute("data-dy-comment-image");
	};
	window.__dyCommentImage = state;
	state.timer = setTimeout(() => {
		state.expired = true;
		input.removeAttribute("data-dy-comment-image");
		setTimeout(() => cleanupCommentImage(token), 5000);
	}, 12000);
	return { selector: `[data-dy-comment-image="${token}"]` };
}
export function preflightCommentImage(token: string) {
	const guard = window.__dyCommentImage;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Comment image witness changed");
	guard.preflight();
	return { ready: true };
}
export function commentImageState(videoID: string, token: string) {
	guardVideo(videoID);
	const guard = window.__dyCommentImage;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Comment image witness changed");
	return { accepted: guard.accepted, blocked: guard.blocked };
}

export async function prepareCommentImageConfirmation(
	videoID: string,
	commentID: string | undefined,
	token: string,
	expectedSize: number,
	expectedSHA256: string,
) {
	const upload = window.__dyCommentImage;
	if (!upload || upload.token !== token || !upload.accepted || upload.blocked || upload.expired || upload.interfered)
		fail("identity_mismatch", "Comment image upload witness is unavailable");
	guardVideo(videoID);
	const { editor, root } = commentEditor(commentID, true);
	if (editorHasDraft(editor)) fail("draft_conflict", "Comment contains text or other media");
	const preview = one(find<HTMLImageElement>(root, "img"), "comment image preview");
	const source = preview.currentSrc || preview.src;
	if (
		!(source.startsWith("blob:https://www.douyin.com/") || /^data:image\/(?:png|jpeg|gif);base64,/i.test(source)) ||
		source.length > 14_000_000
	)
		fail("identity_mismatch", "Comment image preview cannot be verified locally");
	let bytes: ArrayBuffer;
	try {
		const response = await fetch(source);
		const length = response.headers.get("content-length");
		if (source.startsWith("blob:") && (!length || Number(length) !== expectedSize))
			fail("identity_mismatch", "Comment image preview size is unavailable or different");
		bytes = await response.arrayBuffer();
	} catch (error) {
		if (error && typeof error === "object" && "code" in error) throw error;
		fail("identity_mismatch", "Comment image preview cannot be read");
	}
	if (bytes.byteLength !== expectedSize) fail("identity_mismatch", "Comment image preview size does not match");
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (digest !== expectedSHA256) fail("identity_mismatch", "Comment image preview differs from the selected file");
	if (window.__dyCommentImage !== upload || !upload.accepted || upload.blocked || upload.expired || upload.interfered)
		fail("identity_mismatch", "Comment image upload witness changed");
	const buttons = () =>
		find(
			root,
			'[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],[aria-label="发布"],[aria-label="发表评论"],span.wchsYBpK',
		).filter(
			(element) =>
				element.matches(
					'[data-e2e="comment-post"],[data-e2e="comment-submit"],[data-e2e="comment-publish"],[aria-label="发布"],[aria-label="发表评论"]',
				) ||
				/^(发布|发送|发表评论|发布评论)$/.test(clean(element.textContent)) ||
				publishIcon(element),
		);
	const button = one(buttons(), "comment publish control");
	upload.publishButton = button;
	if (upload.timer) clearTimeout(upload.timer);
	let expired = false;
	installGuard(button, token, () => {
		if (
			expired ||
			window.__dyCommentImage !== upload ||
			upload.expired ||
			upload.blocked ||
			upload.interfered ||
			!upload.accepted ||
			window.__douyinCLIGuard?.token !== token ||
			window.__douyinCLIGuard.state.dispatched
		)
			fail("identity_mismatch", "Comment image confirmation expired or was already dispatched");
		guardVideo(videoID);
		const current = commentEditor(commentID, true);
		if (
			current.editor !== editor ||
			current.root !== root ||
			editorHasDraft(editor) ||
			!root.contains(preview) ||
			one(find(root, "img"), "comment image preview") !== preview ||
			(preview.currentSrc || preview.src) !== source ||
			one(buttons(), "comment publish control") !== button
		)
			fail("identity_mismatch", "Comment image draft changed before publishing");
	});
	upload.timer = setTimeout(() => {
		expired = true;
		button.removeAttribute("data-douyin-cli-control");
		setTimeout(() => cleanupCommentImage(token), 5000);
	}, 12000);
	return point(button, token);
}

export function commentImageConfirmationState(videoID: string, token: string) {
	guardVideo(videoID);
	const guard = window.__douyinCLIGuard;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Comment image confirmation witness changed");
	return { dispatched: guard.state.dispatched, blocked: guard.state.blocked };
}
export function cleanupCommentImage(token: string) {
	if (window.__dyCommentImage?.token === token) {
		window.__dyCommentImage.cleanup();
		delete window.__dyCommentImage;
	}
	if (window.__douyinCLIGuard?.token === token) {
		window.__douyinCLIGuard.cleanup();
		delete window.__douyinCLIGuard;
	}
	return {};
}
