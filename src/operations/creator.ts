import type { Session } from "../browser.ts";
import { CliError } from "../errors.ts";

// This inspection uses a temporary page in the account's Chrome context.
// It does not touch an existing creator tab or upload a draft.
export async function inspectCreator(session: Session, signal: AbortSignal) {
	const context = session.browser.contexts()[0];
	if (!context) throw new CliError("browser_unavailable", "Chrome account context is unavailable");
	const page = await context.newPage();
	try {
		await page.route("**/*", async (route) => {
			if (
				route.request().isNavigationRequest() &&
				new URL(route.request().url()).origin !== "https://creator.douyin.com"
			)
				await route.abort();
			else await route.fallback();
		});
		await page.goto("https://creator.douyin.com/creator-micro/content/upload", { waitUntil: "domcontentloaded" });
		await page
			.locator('input[type="file"]')
			.first()
			.waitFor({ state: "attached", timeout: 6000 })
			.catch(() => undefined);
		signal.throwIfAborted();
		const url = new URL(page.url());
		if (url.protocol !== "https:" || url.hostname !== "creator.douyin.com" || url.username || url.password)
			throw new CliError("identity_mismatch", "Creator page redirected outside the creator center");
		const state = await page.evaluate(() => {
			const text = document.body?.innerText ?? "";
			const inputs = [...document.querySelectorAll<HTMLInputElement>('input[type="file"]')];
			return {
				login_required: /扫码登录|登录后|登录抖音/.test(text),
				video_upload_control: inputs.some((input) => !input.disabled && input.accept.includes("video")),
				image_tab_present: [...document.querySelectorAll("button,span,div")].some(
					(element) => element.children.length === 0 && element.textContent?.trim() === "发布图文",
				),
			};
		});
		return { ...state, account_verified: false, existing_drafts_inspected: false, scope: "creator_upload_landing" };
	} finally {
		await page.close().catch(() => undefined);
	}
}
