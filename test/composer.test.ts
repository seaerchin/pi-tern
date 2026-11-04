/**
 * The composer in lib/surface/composer.ts: the `editor` node, the autocomplete overlay, and how
 * Tern's `edit`, `undo` and `send` events reach pi's editor.
 *
 * The editor is faked with pi's public `EditorComponent` methods plus the internals the adapter
 * shape-checks (`state.cursorLine`, `setCursorCol`, `autocompleteList`).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	AUTOCOMPLETE_ID,
	caretOffset,
	caretPosition,
	createComposer,
	EDITOR_ID,
	editorNode,
	keySequence,
	resolveEdit,
	selectionProps,
	undoKeySequence,
	VIM_STATUS,
	type PiEditor,
} from "../lib/surface/composer.ts";
import type { TuiComponent } from "../lib/surface/host.ts";

const rows = (...lines: string[]): TuiComponent => ({ render: () => lines });
const box = (...children: TuiComponent[]): TuiComponent => ({ render: (cols) => children.flatMap((child) => child.render(cols)), children });

/** A pi editor that keeps its text as lines, like pi-tui's, and records what the composer called. */
function fakeEditor(text = "", vim?: { mode: string; pending?: string }) {
	const calls: string[] = [];
	const editor = {
		state: { lines: text.split("\n"), cursorLine: 0, cursorCol: 0 },
		disableSubmit: false,
		autocompleteList: undefined as TuiComponent | undefined,
		showingAutocomplete: false,
		render: () => ["── editor ──"],
		getText() {
			return editor.state.lines.join("\n");
		},
		setText(next: string) {
			calls.push(`setText ${JSON.stringify(next)}`);
			editor.state.lines = next.replace(/\t/g, "    ").split("\n");
			editor.state.cursorLine = editor.state.lines.length - 1;
			editor.state.cursorCol = editor.state.lines.at(-1)?.length ?? 0;
		},
		getCursor() {
			return { line: editor.state.cursorLine, col: editor.state.cursorCol };
		},
		setCursorCol(col: number) {
			editor.state.cursorCol = col;
		},
		handleInput(data: string) {
			calls.push(`handleInput ${JSON.stringify(data)}`);
		},
		addToHistory(entry: string) {
			calls.push(`addToHistory ${JSON.stringify(entry)}`);
		},
		onSubmit(prompt: string) {
			calls.push(`onSubmit ${JSON.stringify(prompt)}`);
		},
		isShowingAutocomplete() {
			return editor.showingAutocomplete;
		},
		[VIM_STATUS]: { status: () => vim },
	};
	return { editor, calls };
}

function fakeTui(editorSlot: TuiComponent): TuiComponent {
	return box(rows("transcript"), rows(), rows(), rows(), editorSlot, rows(), rows("footer"));
}

/** A composer over `slot`, with the warnings it raised through `ctx.ui.notify`. */
function composerOver(slot: TuiComponent) {
	const warnings: string[] = [];
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) };
	const composer = createComposer(pi as unknown as ExtensionAPI, { tui: () => fakeTui(slot), invalidate() {}, log() {}, blob: () => undefined });
	handlers.get("session_start")?.({}, { hasUI: true, ui: { notify: (message: string) => warnings.push(message) } });
	return { composer, warnings };
}

const event = (body: Record<string, unknown>) => ({ id: EDITOR_ID, sf: "sf1", ...body });

test("the editor node maps each Vim mode to a label, and Insert to none", () => {
	const labels = ["insert", "normal", "visual", "visual-line", "visual-block", "replace"].map(
		(mode) => editorNode(fakeEditor("x", { mode }).editor as PiEditor).p?.mode,
	);
	assert.deepEqual(labels, [undefined, "NORMAL", "VISUAL", "VISUAL LINE", "VISUAL BLOCK", "REPLACE"]);
	assert.equal(editorNode(fakeEditor("x", { mode: "normal", pending: "2d" }).editor as PiEditor).p?.mode, "NORMAL 2d");
	assert.equal(editorNode(fakeEditor("x").editor as PiEditor).p?.mode, undefined, "no pi-vim-editor, no label");
});

test("the editor node is sendable unless pi disabled submit, and has no selection until #18", () => {
	const { editor } = fakeEditor("hi");
	assert.equal(editorNode(editor as PiEditor).p?.sendable, true);
	editor.disableSubmit = true;
	assert.equal(editorNode(editor as PiEditor).p?.sendable, false);
	assert.deepEqual(selectionProps({ mode: "visual" }, "hi"), {});
	const props = editorNode(fakeEditor("hi", { mode: "visual" }).editor as PiEditor).p ?? {};
	assert.equal("anchor" in props || "decor" in props, false);
});

test("caret offsets and positions round-trip across lines", () => {
	const text = "ab\ncde\n";
	for (let offset = 0; offset <= text.length; offset += 1) {
		assert.equal(caretOffset(text, caretPosition(text, offset)), offset);
	}
	assert.deepEqual(caretPosition(text, 3), { line: 1, col: 0 });
	assert.equal(caretOffset(text, { line: 1, col: 99 }), 6, "a column past the line end clamps");
});

test("an edit replaces the range and maps Tern's caret, and a stale one is dropped", () => {
	assert.deepEqual(resolveEdit("hello world", { from: 6, to: 11, text: "t", cursor: 7, len: 11 }), {
		text: "hello t",
		cursor: 7,
		changed: true,
	});
	assert.equal(resolveEdit("hello world", { from: 6, to: 11, text: "t", cursor: 7, len: 14 }), null, "keys in flight");
	assert.deepEqual(resolveEdit("abc", { from: 3, to: 1, text: "", cursor: 1, len: 3 }), { text: "a", cursor: 1, changed: true }, "reversed ends");
	assert.deepEqual(resolveEdit("abc", { from: 1, to: 1, text: "", cursor: 1, len: 3 }), { text: "abc", cursor: 1, changed: false }, "a caret move");
	assert.deepEqual(resolveEdit("ab", { from: 1, to: 1, text: "\t", cursor: 2, len: 2 }), { text: "a    b", cursor: 5, changed: true }, "a tab becomes pi's four spaces");
	const emoji = "a😀b";
	assert.deepEqual(resolveEdit(emoji, { from: 2, to: 3, text: "", cursor: 2, len: 4 }), { text: "ab", cursor: 1, changed: true }, "a surrogate pair is never split");
});

test("pi key ids encode as the CSI u sequence pi-tui matches", () => {
	assert.equal(keySequence("ctrl+-"), "\x1b[45;5u");
	assert.equal(keySequence("ctrl++"), "\x1b[43;5u");
	assert.equal(keySequence("shift+ctrl+z"), "\x1b[122;6u");
	assert.equal(keySequence("escape"), "\x1b[27u");
	assert.equal(keySequence("up"), undefined, "no CSI u form");
	assert.equal(keySequence("hyper+z"), undefined, "unknown modifier");
	assert.equal(undoKeySequence(), "\x1b[45;5u", "pi's default undo key, ctrl+-");
});

test("send submits through pi's own path and keeps a draft in history", () => {
	const { editor, calls } = fakeEditor("my draft");
	const { composer } = composerOver(box(editor));
	assert.equal(composer.onEvent(event({ ev: "send", text: "/session" })), true);
	assert.deepEqual(calls, ['addToHistory "my draft"', 'setText ""', 'onSubmit "/session"']);
});

test("a blank send, or one while pi disabled submit, does nothing but is still consumed", () => {
	const { editor, calls } = fakeEditor("");
	const { composer } = composerOver(box(editor));
	assert.equal(composer.onEvent(event({ ev: "send", text: "  " })), true);
	editor.disableSubmit = true;
	assert.equal(composer.onEvent(event({ ev: "send", text: "hi" })), true);
	assert.deepEqual(calls, []);
});

test("an edit sets pi's text as one undo step and places the caret", () => {
	const { editor, calls } = fakeEditor("hello world");
	const { composer } = composerOver(box(editor));
	composer.onEvent(event({ ev: "edit", from: 0, to: 5, text: "HI", cursor: 2, len: 11 }));
	assert.deepEqual(calls, ['setText "HI world"']);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	composer.onEvent(event({ ev: "edit", from: 0, to: 2, text: "x", cursor: 1, len: 99 }));
	assert.equal(calls.length, 1, "a stale edit never reaches pi");
});

test("without the caret internals an edit still applies, and the composer warns once", () => {
	const { editor, calls } = fakeEditor("ab\ncd");
	const { composer, warnings } = composerOver(box({ ...editor, setCursorCol: undefined } as unknown as TuiComponent));
	composer.onEvent(event({ ev: "edit", from: 0, to: 1, text: "X", cursor: 1, len: 5 }));
	composer.onEvent(event({ ev: "edit", from: 0, to: 1, text: "Y", cursor: 1, len: 5 }));
	assert.equal(calls.length, 2);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /caret/);
});

test("undo sends pi's undo key through handleInput, so pi-vim-editor sees it", () => {
	const { editor, calls } = fakeEditor("abc");
	const { composer } = composerOver(box(editor));
	assert.equal(composer.onEvent(event({ ev: "undo" })), true);
	assert.deepEqual(calls, ['handleInput "\\u001b[45;5u"']);
});

test("events for other nodes pass, and editor events during a dialog are dropped", () => {
	const { editor, calls } = fakeEditor("abc");
	const { composer } = composerOver(box(editor));
	assert.equal(composer.onEvent({ ev: "select", id: "l1", item: "i1" }), false);
	assert.equal(composer.onEvent({ ev: "send", id: "other", text: "hi" }), false);
	const dialog = composerOver(box(rows("Pick one")));
	assert.equal(dialog.composer.onEvent(event({ ev: "send", text: "hi" })), true, "not left for the sink's stale editor");
	assert.equal(dialog.composer.focus(), null);
	assert.deepEqual(calls, []);
});

test("an open autocomplete list is an overlay anchored to the caret, and the editor asks for focus", () => {
	const { editor } = fakeEditor("/se");
	const { composer } = composerOver(box(editor));
	assert.equal(composer.focus(), EDITOR_ID);
	assert.deepEqual(composer.overlays(80), [], "closed");
	editor.showingAutocomplete = true;
	assert.deepEqual(composer.overlays(80), [], "open, with the provider still answering");
	editor.autocompleteList = rows("→ settings", "  session");
	assert.deepEqual(composer.overlays(80), [
		{
			id: AUTOCOMPLETE_ID,
			k: "overlay",
			p: { anchor: { caret: EDITOR_ID }, size: "lg" },
			c: [{ id: `${AUTOCOMPLETE_ID}r`, k: "rows", p: { cols: 80, lines: ["→ settings", "  session"] } }],
		},
	]);
	assert.deepEqual(composer.describe(80).map((node) => node.id), [EDITOR_ID], "the dock holds only the editor");
});

test("an autocomplete list of another shape is not shown, and the composer warns once", () => {
	const { editor } = fakeEditor("/se");
	editor.showingAutocomplete = true;
	(editor as { autocompleteList: unknown }).autocompleteList = { items: [] };
	const { composer, warnings } = composerOver(box(editor));
	assert.deepEqual(composer.overlays(80), []);
	composer.overlays(80);
	assert.equal(warnings.length, 1);
	assert.match(warnings[0], /autocomplete/);
});
