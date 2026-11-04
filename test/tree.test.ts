/**
 * Pi's `/tree` selector as a native picker: the selector read by shape, the picker node, and
 * clicks sent as pi's tree keys.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDialogs } from "../lib/surface/dialogs.ts";
import type { SurfaceHost, TuiComponent } from "../lib/surface/host.ts";
import { KEYS, keySequence } from "../lib/surface/keys.ts";
import { nodeKind, readTree, rowLabel, TREE_ID, treeKeys, treeNode, type TreeView } from "../lib/surface/tree.ts";

function flat(id: string, type: string, role: string | undefined, indent: number, label?: string) {
	return { indent, node: { entry: { id, type, ...(role ? { message: { role } } : {}) }, ...(label ? { label } : {}) } };
}

/** pi's `TreeSelectorComponent` with its `TreeList`, as tree-selector.js builds them. */
function fakeSelector(overrides: Record<string, unknown> = {}) {
	const filteredNodes = [flat("u1", "message", "user", 0), flat("a1", "message", "assistant", 0, "kept"), flat("t1", "message", "toolResult", 1), flat("m1", "model_change", undefined, 1)];
	const list = {
		filteredNodes,
		flatNodes: [...filteredNodes, flat("x", "message", "user", 0)],
		selectedIndex: 1,
		searchQuery: "",
		filterMode: "default",
		currentLeafId: "a1",
		foldedNodes: new Set(["t1"]),
		multipleRoots: false,
		getEntryDisplayText: (node: { entry: { id: string } }) => `\x1b[32m${node.entry.id === "u1" ? "user: " : node.entry.id === "a1" ? "assistant: " : ""}text ${node.entry.id}\x1b[0m`,
		...overrides,
	};
	const keys: string[] = [];
	const selector = { labelInput: null, render: () => ["tree"], getTreeList: () => list, handleInput: (key: string) => keys.push(key) };
	return { selector, list, keys };
}

function tuiWith(component: unknown): TuiComponent {
	const rows = (): TuiComponent => ({ render: () => [] });
	return { render: () => [], children: [rows(), rows(), rows(), rows(), { render: () => [], children: [component as TuiComponent] }, rows(), rows()] };
}

test("the open tree selector is read by shape, row by row", () => {
	const { selector } = fakeSelector();
	const tree = readTree(tuiWith(selector));
	assert.deepEqual(tree?.rows, [
		{ id: "u1", label: "text u1", node: "user", depth: 0, folded: false },
		{ id: "a1", label: "text a1", node: "assistant", depth: 0, folded: false, tag: "kept" },
		{ id: "t1", label: "text t1", node: "tool", depth: 1, folded: true },
		{ id: "m1", label: "text m1", node: "marker", depth: 1, folded: false },
	]);
	assert.deepEqual([tree?.selected, tree?.query, tree?.filter, tree?.leaf, tree?.total], [1, "", "default", "a1", 5]);
});

test("anything else in the editor slot, or pi's label editor, is not the tree", () => {
	assert.equal(readTree(tuiWith({ render: () => [], handleInput() {} })), null);
	assert.equal(readTree(tuiWith({ ...fakeSelector().selector, labelInput: {} })), null, "a label is being edited");
	assert.equal(readTree(tuiWith(fakeSelector({ filteredNodes: "nope" }).selector)), null, "a changed list shape");
	assert.equal(readTree(null), null);
});

test("rows lose pi's role prefix and colours, and each entry type has its row style", () => {
	assert.equal(rowLabel("\x1b[36muser: \x1b[0mhello"), "hello");
	assert.equal(rowLabel("   "), "(empty)");
	assert.equal(nodeKind({ type: "message", message: { role: "bashExecution" } }), "tool");
	assert.equal(nodeKind({ type: "compaction" }), "marker");
});

test("the picker is a tree sheet with pi's filters as tabs and Go here and Close", () => {
	const tree = readTree(tuiWith(fakeSelector().selector)) as TreeView;
	const node = treeNode(tree);
	assert.deepEqual([node.id, node.k], [TREE_ID, "picker"]);
	const p = node.p ?? {};
	assert.deepEqual([p.layout, p.selected, p.current, p.tab, p.total, p.query], ["tree", "a1", ["a1"], "default", 5, ""]);
	assert.deepEqual((p.tabs as { id: string }[]).map((tab) => tab.id), ["default", "no-tools", "user-only", "labeled-only", "all"]);
	assert.deepEqual((p.items as Record<string, unknown>[])[1], { id: "a1", label: "text a1", node: "assistant", depth: 0, badges: [{ text: "kept", tone: "warning" }] });
	assert.equal((p.items as Record<string, unknown>[])[2].open, false, "a folded branch");
	assert.deepEqual((p.actions as { id: string }[]).map((action) => action.id), ["go", "close"]);
});

test("clicks become pi's tree keys", () => {
	const tree = readTree(tuiWith(fakeSelector().selector)) as TreeView;
	assert.deepEqual(treeKeys(tree, { ev: "select", id: TREE_ID, item: "m1" }), [KEYS.down, KEYS.down]);
	assert.deepEqual(treeKeys(tree, { ev: "activate", id: TREE_ID, item: "u1" }), [KEYS.up, KEYS.enter]);
	assert.deepEqual(treeKeys(tree, { ev: "action", id: TREE_ID, act: "go" }), [KEYS.enter]);
	assert.deepEqual(treeKeys(tree, { ev: "action", id: TREE_ID, act: "close" }), [KEYS.escape]);
	assert.deepEqual(treeKeys({ ...tree, query: "x" }, { ev: "action", id: TREE_ID, act: "close" }), [KEYS.escape, KEYS.escape], "Escape clears the search first");
	// Tern sends a tab click as an action with the tab id as its value.
	assert.deepEqual(treeKeys(tree, { ev: "action", id: TREE_ID, act: "tab", value: "no-tools" }), [keySequence("ctrl+t")]);
	assert.deepEqual(treeKeys(tree, { ev: "action", id: TREE_ID, act: "tab", value: "default" }), [], "pi's filter keys toggle, so the current filter sends nothing");
	assert.equal(treeKeys(tree, { ev: "select", id: TREE_ID, item: "gone" }), null);
	assert.equal(treeKeys(tree, { ev: "select", id: "dlg1l", item: "u1" }), null);
});

test("the dialogs area shows the tree and answers it through handleInput", () => {
	const { selector, keys } = fakeSelector();
	const logs: string[] = [];
	const host: SurfaceHost = { tui: () => tuiWith(selector), invalidate() {}, log: (message) => logs.push(message), blob: () => undefined };
	const dialogs = createDialogs({} as ExtensionAPI, host);
	assert.deepEqual(dialogs.describe(80).map((node) => node.k), ["picker"]);
	assert.equal(dialogs.focus(), TREE_ID);
	assert.equal(dialogs.onEvent({ ev: "action", id: TREE_ID, act: "go" }), true);
	assert.deepEqual(keys, [KEYS.enter]);
	dialogs.onEvent({ ev: "change", id: TREE_ID, value: 1 });
	dialogs.onEvent({ ev: "change", id: TREE_ID, value: 2 });
	assert.equal(logs.length, 1, "an unmapped event shape is logged once");
});
