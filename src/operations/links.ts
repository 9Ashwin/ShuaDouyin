import { CliError } from "../errors.ts";

type Fetch = (input: string, init: RequestInit) => Promise<Response>;

function parseLink(raw: string): URL {
	const links = raw.match(/https?:\/\/[^\s<>"'，。！？、]+/g) ?? [];
	if (links.length !== 1) throw new CliError("invalid_argument", "Provide exactly one Douyin link");
	let url: URL;
	try {
		url = new URL(links[0].replace(/[)\],.!;]+$/u, ""));
	} catch {
		throw new CliError("invalid_argument", "Invalid Douyin link");
	}
	if (
		url.protocol !== "https:" ||
		url.username ||
		url.password ||
		!["www.douyin.com", "douyin.com", "v.douyin.com", "www.iesdouyin.com"].includes(url.host)
	)
		throw new CliError("invalid_argument", "Expected an HTTPS Douyin link without credentials or a custom port");
	return url;
}

function target(url: URL) {
	const path = ["www.douyin.com", "douyin.com"].includes(url.host)
		? /^\/(video|note)\/(\d{1,64})\/?$/.exec(url.pathname)
		: null;
	const share = url.host === "www.iesdouyin.com" ? /^\/share\/(video|note)\/(\d{1,64})\/?$/.exec(url.pathname) : null;
	const modals = ["www.douyin.com", "douyin.com"].includes(url.host) ? url.searchParams.getAll("modal_id") : [];
	if (modals.length > 1 || (modals.length === 1 && !/^\d{1,64}$/.test(modals[0])))
		throw new CliError("identity_mismatch", "Link has ambiguous work identifiers");
	const modal = modals[0] ?? null;
	if (modal && (path?.[2] ?? share?.[2]) && modal !== (path?.[2] ?? share?.[2]))
		throw new CliError("identity_mismatch", "Link has conflicting work identifiers");
	const id = path?.[2] ?? share?.[2] ?? (modal && /^\d{1,64}$/.test(modal) ? modal : null);
	if (!id) return null;
	const kind = path ? path[1] : share?.[1] === "note" ? "note" : "unknown";
	return { id, kind, url: `https://www.douyin.com/${kind === "note" ? "note" : "video"}/${id}` };
}

export async function resolveLink(raw: string, signal: AbortSignal, request: Fetch = fetch) {
	let url = parseLink(raw);
	const direct = target(url);
	if (direct) return { ...direct, hops: 0 };
	if (url.host !== "v.douyin.com")
		throw new CliError("invalid_argument", "Link does not contain a recognizable work ID");
	for (let hop = 1; hop <= 4; hop++) {
		if (url.host !== "v.douyin.com" || !/^\/[A-Za-z0-9]+\/?$/.test(url.pathname))
			throw new CliError("identity_mismatch", "Short link redirect is not an accepted Douyin work link");
		url.search = "";
		url.hash = "";
		let response: Response;
		try {
			response = await request(url.href, {
				method: "GET",
				redirect: "manual",
				signal,
				headers: { "user-agent": "Mozilla/5.0" },
			});
		} catch (cause) {
			signal.throwIfAborted();
			throw new CliError("network_unavailable", "Could not resolve the Douyin short link", { cause });
		}
		const location = response.headers.get("location");
		await response.body?.cancel().catch(() => undefined);
		if (response.status < 300 || response.status >= 400 || !location)
			throw new CliError("not_found", "Short link did not redirect to a recognizable work");
		let next: URL;
		try {
			next = new URL(location, url);
		} catch {
			throw new CliError("identity_mismatch", "Short link returned an invalid redirect");
		}
		if (
			next.protocol !== "https:" ||
			next.username ||
			next.password ||
			!["www.douyin.com", "douyin.com", "v.douyin.com", "www.iesdouyin.com"].includes(next.host)
		)
			throw new CliError("identity_mismatch", "Short link redirected outside allowed Douyin hosts");
		const resolved = target(next);
		if (resolved) return { ...resolved, hops: hop };
		if (next.host !== "v.douyin.com")
			throw new CliError("not_found", "Short link did not resolve to a recognizable work");
		url = next;
	}
	throw new CliError("not_found", "Short link exceeded the redirect limit");
}
