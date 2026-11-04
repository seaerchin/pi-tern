/**
 * The dialogs area in lib/surface/dialogs.ts: pi's built-in dialogs read by shape from the editor
 * slot, mirrored as modal overlays, and answered with keys through `handleInput()`.
 *
 * The fake dialogs carry the fields pi 1.5.0's `ExtensionSelectorComponent`,
 * `ExtensionInputComponent` and `ExtensionEditorComponent` hold.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDialogs, dialogKeys, dialogNode, FIELD_MODE, isDialogEvent, KEYS, readDialog } from "../lib/surface/dialogs.ts";
import type { TuiComponent } from "../lib/surface/host.ts";

const rows = (...lines: string[]): TuiComponent => ({ render: () => lines });

function fakeTui(dialog: TuiComponent): TuiComponent {
	const slot: TuiComponent = { render: () => [], children: [dialog] };
	return { render: () => [], children: [rows(), rows(), rows(), rows(), slot, rows(), rows()] };
}

/** A selector that applies arrow keys and Enter the way pi's does. */
function fakeSelector(baseTitle: string, options: string[], seconds?: number) {
	const answers: Array<string | undefined> = [];
	const selector = {
		baseTitle,
		options,
		selectedIndex: 0,
		countdown: seconds === undefined ? undefined : { remainingSeconds: seconds },
		keys: [] as string[],
		answers,
		render: () => [baseTitle],
		handleInput(key: string) {
			selector.keys.push(key);
			if (key === KEYS.up) selector.selectedIndex = Math.max(0, selector.selectedIndex - 1);
			if (key === KEYS.down) selector.selectedIndex = Math.min(options.length - 1, selector.selectedIndex + 1);
			if (key === KEYS.enter) answers.push(options[selector.selectedIndex]);
			if (key === KEYS.escape) answers.push(undefined);
		},
	};
	return selector;
}

function fakeInput(baseTitle: string, value: string, cursor: number) {
	const keys: string[] = [];
	return { baseTitle, input: { getValue: () => value, cursor }, keys, render: () => [], handleInput: (key: string) => keys.push(key) };
}

function fakeEditorDialog(title: string, text: string, caret: { line: number; col: number }) {
	const keys: string[] = [];
	const titleText = { text: `\x1b[38;5;4m${title}\x1b[39m`, render: () => [title] };
	return {
		children: [rows("────"), { text: "", render: () => [] }, titleText],
		editor: { getText: () => text, getCursor: () => caret },
		keys,
		render: () => [],
		handleInput: (key: string) => keys.push(key),
	};
}

test("a selector with Yes and No and a two-line title is pi's confirm", () => {
	const confirm = readDialog(fakeTui(fakeSelector("Delete file?\nThis removes notes.txt", ["Yes", "No"])));
	assert.equal(confirm?.kind, "confirm");
	assert.deepEqual(confirm && { title: confirm.title, message: "message" in confirm && confirm.message }, {
		title: "Delete file?",
		message: "This removes notes.txt",
	});
	assert.equal(readDialog(fakeTui(fakeSelector("Pick", ["Yes", "No"])))?.kind, "select", "one line is a plain select");
	assert.equal(readDialog(fakeTui(fakeSelector("Pick\nmore", ["a", "b"])))?.kind, "select");
});

test("the input and editor dialogs are read with their text and caret", () => {
	const input = readDialog(fakeTui(fakeInput("Your name", "Ada", 1)));
	assert.deepEqual(input && { kind: input.kind, title: input.title, text: "text" in input && input.text, cursor: "cursor" in input && input.cursor }, {
		kind: "input",
		title: "Your name",
		text: "Ada",
		cursor: 1,
	});
	const editor = readDialog(fakeTui(fakeEditorDialog("Commit message", "ab\ncd", { line: 1, col: 1 })));
	assert.deepEqual(editor && { kind: editor.kind, title: editor.title, cursor: "cursor" in editor && editor.cursor }, {
		kind: "editor",
		title: "Commit message",
		cursor: 4,
	});
});

test("anything else in the editor slot is not a dialog, so it stays rows", () => {
	assert.equal(readDialog(null), null);
	assert.equal(readDialog(fakeTui(rows("custom"))), null);
	const composer = { getText: () => "", render: () => [], handleInput() {} };
	assert.equal(readDialog(fakeTui(composer)), null, "pi's composer has no dialog shape");
	assert.equal(readDialog(fakeTui({ ...fakeSelector("t", ["a"]), options: [1, 2] } as unknown as TuiComponent)), null);
});

test("a select is a modal overlay with a list, and the countdown goes into the head", () => {
	const dialog = readDialog(fakeTui(fakeSelector("Pick a fruit", ["apple", "banana"], 7)));
	assert.ok(dialog);
	assert.deepEqual(dialogNode(dialog, 3), {
		id: "dlg3",
		k: "overlay",
		p: { anchor: "center", size: "md", modal: true, head: "Pick a fruit (7s)" },
		c: [
			{
				id: "dlg3l",
				k: "list",
				p: { selected: "dlg3i0" },
				c: [
					{ id: "dlg3i0", k: "item", p: { label: "apple" } },
					{ id: "dlg3i1", k: "item", p: { label: "banana" } },
				],
			},
		],
	});
});

test("confirm is two buttons, and input and editor fields carry a mode label plus Submit and Cancel", () => {
	const confirm = readDialog(fakeTui(fakeSelector("Delete?\nSure", ["Yes", "No"])));
	assert.ok(confirm);
	const buttons = dialogNode(confirm, 1).c?.[1]?.c?.map((node) => [node.id, node.k, node.p?.text]);
	assert.deepEqual(buttons, [["dlg1y", "button", "Yes"], ["dlg1n", "button", "No"]]);

	const input = readDialog(fakeTui(fakeInput("Name", "Ada", 3)));
	assert.ok(input);
	const [field, row] = dialogNode(input, 2).c ?? [];
	assert.deepEqual(field, { id: "dlg2f", k: "input", p: { text: "Ada", cursor: 3, mode: FIELD_MODE } });
	assert.deepEqual(row.c?.map((node) => [node.id, node.p?.text]), [["dlg2s", "Submit"], ["dlg2c", "Cancel"]]);

	const editor = readDialog(fakeTui(fakeEditorDialog("Msg", "x", { line: 0, col: 1 })));
	assert.ok(editor);
	assert.equal(dialogNode(editor, 4).c?.[0]?.k, "editor");
});

test("a click becomes arrow keys from the current selection, then Enter", () => {
	const selector = fakeSelector("Pick", ["a", "b", "c"]);
	selector.selectedIndex = 2;
	const dialog = readDialog(fakeTui(selector));
	assert.ok(dialog);
	assert.deepEqual(dialogKeys(dialog, 1, { ev: "select", id: "dlg1l", item: "dlg1i0" }), [KEYS.up, KEYS.up, KEYS.enter]);
	assert.deepEqual(dialogKeys(dialog, 1, { ev: "activate", id: "dlg1l", item: "dlg1i2" }), [KEYS.enter]);
	assert.equal(dialogKeys(dialog, 1, { ev: "select", id: "dlg1l", item: "dlg9i0" }), null);
	assert.equal(dialogKeys(dialog, 2, { ev: "select", id: "dlg1l", item: "dlg1i0" }), null, "another dialog's list");
});

test("confirm buttons pick option 0 or 1, and Submit and Cancel are Enter and Escape", () => {
	const confirm = readDialog(fakeTui(fakeSelector("Delete?\nSure", ["Yes", "No"])));
	assert.ok(confirm);
	assert.deepEqual(dialogKeys(confirm, 1, { ev: "action", id: "dlg1n", act: "click" }), [KEYS.down, KEYS.enter]);
	assert.deepEqual(dialogKeys(confirm, 1, { ev: "action", id: "dlg1y", act: "click" }), [KEYS.enter]);
	const input = readDialog(fakeTui(fakeInput("Name", "", 0)));
	assert.ok(input);
	assert.deepEqual(dialogKeys(input, 1, { ev: "action", id: "dlg1s", act: "click" }), [KEYS.enter]);
	assert.deepEqual(dialogKeys(input, 1, { ev: "action", id: "dlg1c", act: "click" }), [KEYS.escape]);
	assert.equal(dialogKeys(input, 1, { ev: "edit", id: "dlg1f", from: 0, to: 0, text: "x" }), null);
});

test("the area answers through handleInput, focuses the dialog, and keeps each dialog's own ids", () => {
	let tui: TuiComponent | null = null;
	const dialogs = createDialogs({} as ExtensionAPI, { tui: () => tui, invalidate() {} });
	assert.deepEqual(dialogs.describe(80), []);
	assert.equal(dialogs.focus(), null);

	const first = fakeSelector("Pick", ["a", "b"]);
	tui = fakeTui(first);
	assert.equal(dialogs.describe(80)[0]?.id, "dlg1");
	assert.equal(dialogs.focus(), "dlg1");
	assert.equal(dialogs.onEvent({ ev: "select", id: "dlg1l", item: "dlg1i1" }), true);
	assert.deepEqual(first.keys, [KEYS.down, KEYS.enter]);
	assert.deepEqual(first.answers, ["b"]);

	const second = fakeInput("Name", "", 0);
	tui = fakeTui(second);
	assert.equal(dialogs.describe(80)[0]?.id, "dlg2", "a new dialog gets a new overlay");
	assert.equal(dialogs.focus(), "dlg2f", "the text field holds the focus");
	assert.equal(dialogs.onEvent({ ev: "action", id: "dlg2c", act: "click" }), true);
	assert.deepEqual(second.keys, [KEYS.escape]);

	tui = fakeTui(rows("composer"));
	assert.equal(dialogs.onEvent({ ev: "edit", id: "dlg2f", from: 0, to: 0, text: "x", len: 0 }), true, "a closed dialog's edit never reaches the composer");
	assert.equal(dialogs.onEvent({ ev: "edit", id: "ke", from: 0, to: 0, text: "x", len: 0 }), false);
	assert.equal(isDialogEvent({ ev: "ack", s: 3 }), false);
});
