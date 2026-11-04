/**
 * Pi's `/tree` selector as Tern's native `picker` in its tree layout.
 *
 * The selector stays pi's. The picker mirrors its `TreeList`, read by shape, and every click is
 * sent as the key it stands for through the selector's public `handleInput()`, as the dialogs are
 * (ADR 0002, extended). Typed keys already reach the selector, because pi focuses it, so search
 * and pi's own tree keys keep working. While pi edits a label the selector stays rows.
 */
import { bindingSequence, KEYS } from "./keys.ts";
import { piSlot, type SemanticNode, type TernEvent, type TuiComponent } from "./host.ts";

/** The picker's node id. It starts with the dialogs' prefix, so the dialogs area owns its events. */
export const TREE_ID = "dlgtree";

/** pi's tree filters, in the order of its filter keys, with the binding and default key of each. */
export const TREE_FILTERS = [
	{ id: "default", label: "Default", binding: "app.tree.filter.default", key: "ctrl+d" },
	{ id: "no-tools", label: "No tools", binding: "app.tree.filter.noTools", key: "ctrl+t" },
	{ id: "user-only", label: "User", binding: "app.tree.filter.userOnly", key: "ctrl+u" },
	{ id: "labeled-only", label: "Labeled", binding: "app.tree.filter.labeledOnly", key: "ctrl+l" },
	{ id: "all", label: "All", binding: "app.tree.filter.all", key: "ctrl+a" },
] as const;

export type TreeNodeKind = "user" | "assistant" | "tool" | "marker";

export interface TreeRow {
	id: string;
	label: string;
	node: TreeNodeKind;
	depth: number;
	folded: boolean;
	tag?: string;
}

export interface TreeView {
	component: { handleInput(data: string): void };
	rows: TreeRow[];
	selected: number;
	query: string;
	filter: string;
	leaf: string | null;
	total: number;
}

type Fields = Record<string, unknown>;
const fieldsOf = (value: unknown): Fields | undefined => (value && typeof value === "object" ? (value as Fields) : undefined);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

interface EntryLike {
	id?: string;
	type?: string;
	message?: { role?: string; content?: unknown };
	customType?: string;
}

/** The style Tern gives a tree row: user and assistant turns, tool steps, and every other entry as a marker. */
export function nodeKind(entry: EntryLike): TreeNodeKind {
	if (entry.type !== "message") return "marker";
	const role = entry.message?.role;
	if (role === "user") return "user";
	if (role === "assistant") return "assistant";
	if (role === "toolResult" || role === "bashExecution") return "tool";
	return "marker";
}

/** pi's own row text without its colours and without the role prefix the row style already shows. */
export function rowLabel(display: string): string {
	const text = plain(display).trim();
	return text.replace(/^(user|assistant): /, "") || "(empty)";
}

/** The open `/tree` selector in pi's editor slot, or null for anything else or a changed shape. */
export function readTree(tui: TuiComponent | null): TreeView | null {
	const component = fieldsOf(piSlot(tui, "editor")?.children?.[0]);
	if (!component || typeof component.getTreeList !== "function" || typeof component.handleInput !== "function") return null;
	// pi's label editor takes the keys while it is open, so the selector stays rows until it closes.
	if (component.labelInput !== null && component.labelInput !== undefined) return null;
	const list = fieldsOf((component.getTreeList as () => unknown).call(component));
	if (!list || !Array.isArray(list.filteredNodes) || typeof list.selectedIndex !== "number") return null;
	const display = typeof list.getEntryDisplayText === "function" ? (list.getEntryDisplayText as (node: unknown, selected: boolean) => string) : null;
	const folded = list.foldedNodes instanceof Set ? (list.foldedNodes as Set<string>) : new Set<string>();
	const shift = list.multipleRoots === true ? 1 : 0;
	const rows: TreeRow[] = [];
	for (const flat of list.filteredNodes as unknown[]) {
		const flatFields = fieldsOf(flat);
		const node = fieldsOf(flatFields?.node);
		const entry = fieldsOf(node?.entry) as EntryLike | undefined;
		if (!entry || typeof entry.id !== "string") return null;
		const text = display ? String(display.call(list, node, false)) : (entry.type ?? "entry");
		const row: TreeRow = {
			id: entry.id,
			label: rowLabel(text),
			node: nodeKind(entry),
			depth: Math.max(0, (typeof flatFields?.indent === "number" ? flatFields.indent : 0) - shift),
			folded: folded.has(entry.id),
		};
		if (typeof node?.label === "string" && node.label) row.tag = node.label;
		rows.push(row);
	}
	return {
		component: component as unknown as TreeView["component"],
		rows,
		selected: list.selectedIndex,
		query: typeof list.searchQuery === "string" ? list.searchQuery : "",
		filter: typeof list.filterMode === "string" ? list.filterMode : "default",
		leaf: typeof list.currentLeafId === "string" ? list.currentLeafId : null,
		total: Array.isArray(list.flatNodes) ? list.flatNodes.length : rows.length,
	};
}

/** The tree as a modal picker sheet. A picker under `layer` is its own sheet, so it needs no overlay. */
export function treeNode(tree: TreeView): SemanticNode {
	const items = tree.rows.map((row) => {
		const item: Record<string, unknown> = { id: row.id, label: row.label, node: row.node, depth: row.depth };
		if (row.folded) item.open = false;
		if (row.tag) item.badges = [{ text: row.tag, tone: "warning" }];
		return item;
	});
	return {
		id: TREE_ID,
		k: "picker",
		p: {
			title: "Session tree",
			subtitle: "Pick a point to continue from",
			noun: "entries",
			size: "lg",
			layout: "tree",
			preview: "none",
			query: tree.query,
			placeholder: "Search entries",
			tabs: TREE_FILTERS.map((filter) => ({ id: filter.id, label: filter.label })),
			tab: tree.filter,
			items,
			selected: tree.rows[tree.selected]?.id ?? null,
			current: tree.leaf ? [tree.leaf] : [],
			total: tree.total,
			empty: "No entries found",
			focus: "list",
			actions: [
				{ id: "go", label: "Go here", keys: ["enter"], primary: true },
				{ id: "close", label: "Close", keys: ["esc"], end: true },
			],
		},
	};
}

function moveKeys(from: number, to: number): string[] {
	const step = to > from ? KEYS.down : KEYS.up;
	return Array<string>(Math.abs(to - from)).fill(step);
}

/** The keys that answer a picker event the way pi's tree keys would, or null for an event it ignores. */
export function treeKeys(tree: TreeView, event: TernEvent): string[] | null {
	if (event.id !== TREE_ID) return null;
	if (typeof event.tab === "string") return filterKeys(tree, event.tab);
	const item = typeof event.item === "string" ? event.item : undefined;
	if (event.ev === "select" || event.ev === "activate") {
		const index = tree.rows.findIndex((row) => row.id === item);
		if (index === -1) return null;
		const keys = moveKeys(tree.selected, index);
		return event.ev === "activate" ? [...keys, KEYS.enter] : keys;
	}
	if (event.ev !== "action") return null;
	const act = String(event.act ?? "");
	if (act === "go") return [KEYS.enter];
	// pi's Escape clears an open search first, so a close with a query takes two.
	if (act === "close" || act === "cancel") return tree.query ? [KEYS.escape, KEYS.escape] : [KEYS.escape];
	const tab = act === "tab" ? String(event.value ?? "") : act.startsWith("tab:") ? act.slice(4) : "";
	return tab ? filterKeys(tree, tab) : null;
}

/** pi's key for a filter. Its filter keys toggle back to default, so the current filter sends nothing. */
function filterKeys(tree: TreeView, id: string): string[] | null {
	const filter = TREE_FILTERS.find((candidate) => candidate.id === id);
	if (!filter) return null;
	if (filter.id === tree.filter) return [];
	const key = bindingSequence(filter.binding, filter.key);
	return key ? [key] : null;
}
