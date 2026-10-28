import { clean, fail, findRendered, one, point } from "./dom.ts";
import { installGuard } from "./interactions.ts";
import { guardPage } from "./readers.ts";

const groups = [
	["排序依据", "综合排序", "最新发布", "最多点赞"],
	["发布时间", "不限", "一天内", "一周内", "半年内"],
	["视频时长", "不限", "1分钟以下", "1-5分钟", "5分钟以上"],
	["搜索范围", "不限", "关注的人", "最近看过", "还未看过"],
	["内容形式", "不限", "视频", "图文"],
];

function guardSearch(query: string) {
	const state = guardPage();
	if (
		state.private_chat_visible ||
		state.page_kind !== "search" ||
		!state.url ||
		new URL(state.url).pathname !== `/search/${encodeURIComponent(query)}` ||
		![null, "general"].includes(new URL(state.url).searchParams.get("type"))
	)
		fail("identity_mismatch", "Search changed during filter selection");
}

function menu() {
	const label = one(
		findRendered(document, "span").filter((element) => clean(element.textContent) === "筛选"),
		"search filter entry",
	);
	if (!label.parentElement) fail("selector_changed", "Search filter container is missing");
	return label.parentElement;
}

function entries(root: HTMLElement) {
	const rows = groups.map((expected, group) => {
		const options = findRendered(root, `[data-index1="${group}"]`);
		if (options.length !== expected.length - 1) fail("selector_changed", "Search filter options changed");
		const result = expected.slice(1).map((text, index) =>
			one(
				options.filter(
					(node) => node.getAttribute("data-index2") === String(index) && clean(node.textContent) === text,
				),
				"search filter option",
			),
		);
		const parent = result[0].parentElement;
		if (
			!parent ||
			result.some((node) => node.parentElement !== parent) ||
			![...parent.children].some((node) => clean(node.textContent) === expected[0])
		)
			fail("selector_changed", "Search filter group changed");
		return result;
	});
	// This class was observed moving with the selected option on the live
	// page. If the page changes its marker, fail rather than infer semantics
	// from arbitrary positional styling classes.
	const marker = "sDNqBVWH";
	if (!rows.every((row) => row.filter((node) => node.classList.contains(marker)).length === 1))
		fail("selector_changed", "Search filter selected state is ambiguous");
	return { rows, marker, selected: rows.map((row) => row.findIndex((node) => node.classList.contains(marker))) };
}

export function openSearchFilters(query: string, token: string) {
	guardSearch(query);
	const root = menu();
	if (findRendered(root, '[data-index1="0"]').length) return { already: true };
	const button = one(
		findRendered(root, "span").filter((node) => clean(node.textContent) === "筛选"),
		"search filter entry",
	);
	installGuard(button, token, () => {
		guardSearch(query);
		if (menu() !== root) fail("identity_mismatch", "Filter entry changed");
	});
	return point(button, token);
}

export function searchFilterState(query: string) {
	guardSearch(query);
	const { selected, marker } = entries(menu());
	return { selected, marker };
}

export function prepareSearchFilter(query: string, group: number, choice: number, token: string) {
	guardSearch(query);
	const root = menu();
	const state = entries(root);
	if (!state.rows[group]?.[choice]) fail("invalid_argument", "Unknown search filter");
	if (state.selected[group] === choice) return { already: true };
	const button = state.rows[group][choice];
	installGuard(button, token, () => {
		guardSearch(query);
		const current = entries(menu());
		if (
			current.marker !== state.marker ||
			current.rows[group]?.[choice] !== button ||
			current.selected.some((value, index) => value !== state.selected[index])
		)
			fail("identity_mismatch", "Search filter changed before selection");
	});
	return point(button, token);
}
