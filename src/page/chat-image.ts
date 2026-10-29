import { clean, editorHasDraft, fail, find, one, own, point, scalarID } from "./dom.ts";
import { installGuard } from "./interactions.ts";
import { chatRoot, readChat } from "./readers.ts";

declare global {
	interface Window {
		__dyImageGuard?: {
			token: string;
			accepted: boolean;
			blocked: boolean;
			expired: boolean;
			interfered: boolean;
			confirmationEditor?: HTMLElement;
			preflight: () => void;
			cleanup: () => void;
			timer?: ReturnType<typeof setTimeout>;
		};
	}
}

export function prepareChatImage(conversation: string, token: string, name: string, size: number, mime: string) {
	readChat(conversation);
	if (find(document, '[role="dialog"] [class*="MsgInputSendFileModalbox"]').length)
		fail("draft_conflict", "An image confirmation is already open");
	const { root } = chatRoot();
	const editor = one(find(root, '[data-e2e="msg-input"] [contenteditable="true"]'), "private message editor");
	if (editorHasDraft(editor)) fail("draft_conflict", "Conversation has an existing draft");
	const uploader = one(find(root, '[class*="MsgInputFileUploadim-saas-fileUploader"]'), "image upload container");
	const input = one(
		[...uploader.querySelectorAll<HTMLInputElement>('input[type="file"].semi-upload-hidden-input[multiple]')],
		"image upload input",
	);
	if (
		input.disabled ||
		input.files?.length ||
		uploader.querySelector('[class*="upload-list-item"],[data-e2e="image-preview"]')
	)
		fail("draft_conflict", "Conversation already contains an image draft");
	window.__dyImageGuard?.cleanup();
	input.setAttribute("data-dy-image-input", token);
	const state: NonNullable<Window["__dyImageGuard"]> = {
		token,
		accepted: false,
		blocked: false,
		expired: false,
		interfered: false,
		preflight: () => {},
		cleanup: () => {},
	};
	state.preflight = () => {
		readChat(conversation);
		if (
			chatRoot().root !== root ||
			!editor.isConnected ||
			one(find(root, '[data-e2e="msg-input"] [contenteditable="true"]'), "private message editor") !== editor ||
			!input.isConnected ||
			!root.contains(input) ||
			input.getAttribute("data-dy-image-input") !== token
		)
			fail("identity_mismatch", "Image upload target changed");
		if (
			state.expired ||
			state.interfered ||
			editorHasDraft(editor) ||
			input.files?.length ||
			find(document, '[role="dialog"] [class*="MsgInputSendFileModalbox"]').length ||
			uploader.querySelector('[class*="upload-list-item"],[data-e2e="image-preview"]')
		)
			fail("draft_conflict", "Conversation draft changed before image upload");
	};
	const listener = (event: Event) => {
		if (event.target !== input) return;
		const files = input.files;
		if (!files || files.length !== 1 || files[0].name !== name || files[0].size !== size || files[0].type !== mime) {
			state.interfered = true;
			return;
		}
		try {
			if (
				chatRoot().root !== root ||
				!editor.isConnected ||
				one(find(root, '[data-e2e="msg-input"] [contenteditable="true"]'), "private message editor") !== editor ||
				!input.isConnected ||
				!root.contains(input) ||
				input.getAttribute("data-dy-image-input") !== token
			)
				fail("identity_mismatch", "Image upload target changed");
			readChat(conversation);
			if (
				state.expired ||
				state.interfered ||
				editorHasDraft(editor) ||
				uploader.querySelector('[class*="upload-list-item"],[data-e2e="image-preview"]')
			)
				fail("draft_conflict", "Conversation draft changed before upload");
			state.accepted = true;
		} catch {
			state.blocked = true;
			event.preventDefault();
			event.stopImmediatePropagation();
		}
	};
	const preventInterference = (event: Event) => {
		if (!(event.target instanceof Node)) return;
		if (
			(event.type === "click" && uploader.contains(event.target)) ||
			(["beforeinput", "paste", "drop"].includes(event.type) &&
				(editor.contains(event.target) ||
					uploader.contains(event.target) ||
					!!state.confirmationEditor?.contains(event.target)))
		) {
			state.interfered = true;
		}
	};
	for (const type of ["input", "change"]) document.addEventListener(type, listener, true);
	for (const type of ["click", "beforeinput", "paste", "drop"])
		document.addEventListener(type, preventInterference, true);
	state.cleanup = () => {
		if (state.timer) clearTimeout(state.timer);
		for (const type of ["input", "change"]) document.removeEventListener(type, listener, true);
		for (const type of ["click", "beforeinput", "paste", "drop"])
			document.removeEventListener(type, preventInterference, true);
		input.removeAttribute("data-dy-image-input");
	};
	window.__dyImageGuard = state;
	state.timer = setTimeout(() => {
		state.expired = true;
		input.removeAttribute("data-dy-image-input");
		setTimeout(() => cleanupChatImage(token), 5000);
	}, 12000);
	return { selector: `[data-dy-image-input="${token}"]` };
}

export function preflightChatImage(token: string) {
	const guard = window.__dyImageGuard;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Image upload witness changed");
	guard.preflight();
	return { ready: true };
}

export function chatImageState(conversation: string, token: string) {
	readChat(conversation);
	const guard = window.__dyImageGuard;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Image upload witness changed");
	return { accepted: guard.accepted, blocked: guard.blocked };
}

function modalConversation(dialog: HTMLElement, expected: string) {
	let fields: string[];
	let value: string;
	if (expected.startsWith("secuid:")) {
		fields = ["_toParticipantSecUserId"];
		value = expected.slice("secuid:".length);
	} else if (expected.startsWith("native:")) {
		fields = ["conversationId", "conversationShortId"];
		value = expected.slice("native:".length);
	} else {
		const match = /^rendered:(conversationId|conversationShortId|groupId|secUid|userId):(.+)$/.exec(expected);
		if (!match) fail("identity_mismatch", "Image confirmation does not expose a supported stable recipient ID");
		fields = [match[1]];
		value = match[2];
	}
	const keys = Object.getOwnPropertyNames(dialog).filter((key) => key.startsWith("__reactFiber$"));
	if (keys.length !== 1) fail("identity_mismatch", "Image confirmation recipient identity is unavailable");
	const ids = new Set<string>();
	let fiber = own(dialog, keys[0]);
	for (let depth = 0; fiber && depth < 40; depth++) {
		const identity = own(own(fiber, "memoizedProps"), "curConversation");
		for (const field of fields) {
			const id = scalarID(own(identity, field));
			if (id) ids.add(id);
		}
		fiber = own(fiber, "return");
	}
	if (ids.size !== 1 || !ids.has(value))
		fail("identity_mismatch", "Image confirmation recipient identity does not match");
}

export async function prepareChatImageConfirmation(
	conversation: string,
	token: string,
	expectedName: string,
	expectedSize: number,
	expectedSHA256: string,
) {
	const uploadGuard = window.__dyImageGuard;
	if (
		!uploadGuard ||
		uploadGuard.token !== token ||
		!uploadGuard.accepted ||
		uploadGuard.blocked ||
		uploadGuard.expired ||
		uploadGuard.interfered
	)
		fail("identity_mismatch", "Image upload witness is unavailable");
	const chat = readChat(conversation);
	const dialog = one(
		find(document, '[role="dialog"] [class*="MsgInputSendFileModalbox"]'),
		"image confirmation dialog",
	);
	modalConversation(dialog, conversation);
	const receiver = one(find(dialog, '[class*="MsgInputSendFileModalreceiver"]'), "image confirmation recipient");
	if (!chat.name || clean(receiver.textContent) !== `发送给 ${chat.name}`)
		fail("identity_mismatch", "Image confirmation recipient does not match the open conversation");
	const preview = one(
		find<HTMLImageElement>(dialog, '[class*="MsgInputSendFileModalitemIconInner"]'),
		"image confirmation preview",
	);
	const title = one(find(dialog, '[class*="MsgInputSendFileModalitemContentTitle"]'), "image confirmation filename");
	const editor = one(find<HTMLTextAreaElement>(dialog, "textarea"), "image confirmation text field");
	if (clean(title.textContent) !== expectedName || editor.value.trim())
		fail("draft_conflict", "Image confirmation differs from the requested image or contains text");
	const source = preview.currentSrc || preview.src;
	if (!/^data:image\/(?:png|jpeg|gif);base64,/i.test(source) || source.length > 14_000_000)
		fail("identity_mismatch", "Image preview cannot be verified locally");
	let data: ArrayBuffer;
	try {
		data = await (await fetch(source)).arrayBuffer();
	} catch {
		fail("identity_mismatch", "Image preview cannot be read");
	}
	if (data.byteLength !== expectedSize) fail("identity_mismatch", "Image preview size does not match");
	const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", data))]
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
	if (digest !== expectedSHA256) fail("identity_mismatch", "Image preview does not match the selected file");
	if (
		window.__dyImageGuard !== uploadGuard ||
		!uploadGuard.accepted ||
		uploadGuard.blocked ||
		uploadGuard.expired ||
		uploadGuard.interfered
	)
		fail("identity_mismatch", "Image upload witness changed while verifying preview");
	const button = one(
		find<HTMLButtonElement>(dialog, 'button[class*="MsgInputSendFileModalbtnSure"]').filter(
			(element) => clean(element.textContent) === "发送",
		),
		"image confirmation send control",
	);
	uploadGuard.confirmationEditor = editor;
	modalConversation(button, conversation);
	if (uploadGuard?.token === token && uploadGuard.timer) clearTimeout(uploadGuard.timer);
	let expired = false;
	installGuard(button, token, () => {
		if (
			expired ||
			window.__dyImageGuard !== uploadGuard ||
			uploadGuard.expired ||
			uploadGuard.interfered ||
			uploadGuard.blocked ||
			!uploadGuard.accepted
		)
			fail("identity_mismatch", "Image confirmation witness expired or changed");
		if (window.__douyinCLIGuard?.token !== token || window.__douyinCLIGuard.state.dispatched)
			fail("identity_mismatch", "Image confirmation has already been dispatched");
		const current = readChat(conversation);
		modalConversation(dialog, conversation);
		modalConversation(button, conversation);
		if (
			!dialog.isConnected ||
			!dialog.contains(button) ||
			!dialog.contains(preview) ||
			one(find(dialog, '[class*="MsgInputSendFileModalreceiver"]'), "image confirmation recipient") !== receiver ||
			one(find(dialog, '[class*="MsgInputSendFileModalitemContentTitle"]'), "image confirmation filename") !== title ||
			one(find(dialog, "textarea"), "image confirmation text field") !== editor ||
			(preview.currentSrc || preview.src) !== source ||
			clean(title.textContent) !== expectedName ||
			editor.value.trim() ||
			!current.name ||
			clean(receiver.textContent) !== `发送给 ${current.name}`
		)
			fail("identity_mismatch", "Image confirmation changed before sending");
	});
	const timer = setTimeout(() => {
		expired = true;
		button.removeAttribute("data-douyin-cli-control");
		setTimeout(() => cleanupChatImage(token), 5000);
	}, 12000);
	if (uploadGuard?.token === token) uploadGuard.timer = timer;
	return point(button, token);
}

// What the conversation looked like before the send, so the row the send
// produces can be recognised afterwards. Without a baseline there was no way to
// tell a new image message from one that was already there, which is why every
// image send returned uncertain.
export function chatImageBaseline(conversation: string) {
	readChat(conversation);
	const { root } = chatRoot();
	const media = [...root.querySelectorAll<HTMLImageElement>("img")].map((image) => image.src).filter(Boolean);
	return { media: media.length, sources: media.slice(-20) };
}

export function chatImageConfirmationState(conversation: string, token: string, baseline?: { sources: string[] }) {
	readChat(conversation);
	const guard = window.__douyinCLIGuard;
	if (!guard || guard.token !== token) fail("identity_mismatch", "Image confirmation witness changed");
	const { root } = chatRoot();
	const now = [...root.querySelectorAll<HTMLImageElement>("img")].map((image) => image.src).filter(Boolean);
	// A new image source that was not in the baseline is the send's own row. The
	// page reuses one URL for a repeated image, so a count alone is not enough.
	const known = new Set(baseline?.sources ?? []);
	const appeared = baseline ? now.filter((source) => !known.has(source)).length : 0;
	return {
		dispatched: guard.state.dispatched,
		blocked: guard.state.blocked,
		dialog_closed: find(document, '[role="dialog"] [class*="MsgInputSendFileModalbox"]').length === 0,
		new_media: appeared,
	};
}

export function cleanupChatImage(token: string) {
	if (window.__dyImageGuard?.token === token) {
		window.__dyImageGuard.cleanup();
		delete window.__dyImageGuard;
	}
	if (window.__douyinCLIGuard?.token === token) {
		window.__douyinCLIGuard.cleanup();
		delete window.__douyinCLIGuard;
	}
	return {};
}
