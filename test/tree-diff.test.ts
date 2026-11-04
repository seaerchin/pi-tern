/**
 * The semantic node tree diff in native/tree-diff.mjs.
 *
 * Tern keeps the document between frames, so a wrong op leaves a stale or duplicated node on
 * screen with no error. These pin the exact ops for each kind of change.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { diffChildren, propDelta } from "../native/tree-diff.mjs";
import type { FrameOp, SemanticNode } from "../native/native.d.mts";

const md = (id: string, text: string): SemanticNode => ({ id, k: "md", p: { text } });
const diff = (prev: SemanticNode[], next: SemanticNode[]) => diffChildren("main", prev, next, [] as FrameOp[]);

test("an unchanged tree produces no ops", () => {
	const tree = [md("a", "one"), { id: "c", k: "card", p: { head: "x" }, c: [md("c1", "body")] }];
	assert.deepEqual(diff(tree, structuredClone(tree)), []);
});

test("new nodes are added in order, appended when nothing follows them", () => {
	assert.deepEqual(diff([], [md("a", "one"), md("b", "two")]), [
		["add", "a", "main", null, md("a", "one")],
		["add", "b", "main", null, md("b", "two")],
	]);
});

test("a node inserted between kept nodes is added before the next kept sibling", () => {
	const ops = diff([md("a", "1"), md("c", "3")], [md("a", "1"), md("b", "2"), md("c", "3")]);
	assert.deepEqual(ops, [["add", "b", "main", "c", md("b", "2")]]);
});

test("a removed node is deleted", () => {
	assert.deepEqual(diff([md("a", "1"), md("b", "2")], [md("a", "1")]), [["del", "b"]]);
});

test("a changed prop is set alone, without the props that stayed the same", () => {
	const prev = [{ id: "e", k: "editor", p: { text: "hi", cursor: 2, sendable: true } }];
	const next = [{ id: "e", k: "editor", p: { text: "hit", cursor: 3, sendable: true } }];
	assert.deepEqual(diff(prev, next), [["set", "e", { text: "hit", cursor: 3 }]]);
});

test("a dropped prop is set to null, so a Vim mode label clears on Insert", () => {
	const prev = [{ id: "e", k: "editor", p: { text: "", mode: "NORMAL" } }];
	const next = [{ id: "e", k: "editor", p: { text: "" } }];
	assert.deepEqual(diff(prev, next), [["set", "e", { mode: null }]]);
});

test("a kind change deletes and re-adds the node in place", () => {
	const ops = diff([md("a", "1"), md("b", "2")], [{ id: "a", k: "rows", p: { lines: [] } }, md("b", "2")]);
	assert.deepEqual(ops, [
		["del", "a"],
		["add", "a", "main", "b", { id: "a", k: "rows", p: { lines: [] } }],
	]);
});

test("children are diffed under their own parent", () => {
	const prev = [{ id: "c", k: "card", p: { head: "edit", status: "running" }, c: [md("c1", "a")] }];
	const next = [{ id: "c", k: "card", p: { head: "edit", status: "done" }, c: [md("c1", "a"), md("c2", "b")] }];
	assert.deepEqual(diff(prev, next), [
		["set", "c", { status: "done" }],
		["add", "c2", "c", null, md("c2", "b")],
	]);
});

test("a reordered node is deleted and added again at its new position", () => {
	const ops = diff([md("a", "1"), md("b", "2"), md("c", "3")], [md("c", "3"), md("a", "1"), md("b", "2")]);
	assert.deepEqual(ops, [
		["del", "c"],
		["add", "c", "main", "a", md("c", "3")],
	]);
});

test("propDelta is null when nothing changed and ignores undefined values", () => {
	assert.equal(propDelta({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2], c: undefined }), null);
	assert.deepEqual(propDelta({ a: 1 }, { a: 2 }), { a: 2 });
});
