/**
 * Dialogs area (`layer`): pi's built-in `select`, `confirm`, `input` and `editor` dialogs as modal
 * overlays.
 *
 * Pi's dialog stays pi's. The overlay mirrors the dialog component in pi's editor slot, read by
 * shape, and Tern's events reach it as keys through its public `handleInput()` (ADR 0002,
 * extended). Typed keys already reach the dialog, because pi focuses it. A dialog whose shape
 * doesn't match shows as rows in the dock.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSlot, type SemanticNode, type SurfaceHost, type TernEvent, type TuiComponent } from "./host.ts";

export interface Dialogs {
	/** The children of `layer`. Empty while no dialog is open. */
	describe(cols: number): SemanticNode[];
	/** The node that should hold Tern's keyboard focus, or null while no dialog is open. */
	focus(): string | null;
	/** True when the event was for a dialog node, open or closed. Dialogs see events before the other areas. */
	onEvent(event: TernEvent): boolean;
}

/** The keys sent through `handleInput()`, as pi-tui's default keybindings read them. */
export const KEYS = { up: "\x1b[A", down: "\x1b[B", enter: "\r", escape: "\x1b" } as const;

/** The options pi's `confirm` passes to its selector. */
const CONFIRM_OPTIONS = ["Yes", "No"];

/**
 * Tern edits a field natively only while it carries no `mode` label. A label sends every key to pi
 * as pty bytes, so pi's value stays the only truth and no `edit` has to be replayed as keys. OMP
 * uses the same label when another owner reads the keys.
 */
export const FIELD_MODE = "PTY";

/** Every dialog node id starts with this, so events for a closed dialog can still be recognised. */
const ID_PREFIX = "dlg";

interface DialogComponent extends TuiComponent {
	handleInput(data: string): void;
}

/** A dialog as read from pi's editor slot. `seconds` is the timeout countdown, when there is one. */
export type Dialog = { component: DialogComponent; seconds?: number } & (
	| { kind: "select"; title: string; options: string[]; selected: number }
	| { kind: "confirm"; title: string; message: string; selected: number }
	| { kind: "input"; title: string; text: string; cursor: number }
	| { kind: "editor"; title: string; text: string; cursor: number }
);

type Fields = Record<string, unknown>;

const isFunction = (value: unknown): value is (...args: unknown[]) => unknown => typeof value === "function";
const fieldsOf = (value: unknown): Fields | undefined => (value && typeof value === "object" ? (value as Fields) : undefined);
const plain = (text: string) => text.replace(/\x1b\[[0-9;]*m/g, "");

function countdownSeconds(component: Fields): number | undefined {
	const seconds = fieldsOf(component.countdown)?.remainingSeconds;
	return typeof seconds === "number" ? seconds : undefined;
}

/** A caret at `{ line, col }` as a UTF-16 offset into `text`, which is what Tern's `cursor` is. */
function caretOffset(text: string, caret: unknown): number {
	const { line, col } = (fieldsOf(caret) ?? {}) as { line?: unknown; col?: unknown };
	if (typeof line !== "number") return text.length;
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < line && i < lines.length; i += 1) offset += lines[i].length + 1;
	return offset + Math.min(typeof col === "number" ? col : 0, lines[line]?.length ?? 0);
}

/**
 * The editor dialog keeps its title only in its first text child, styled by pi's theme. The other
 * dialogs keep it in `baseTitle`.
 */
function firstText(component: TuiComponent): string {
	for (const child of component.children ?? []) {
		const text = fieldsOf(child)?.text;
		if (typeof text === "string" && text.trim() !== "") return plain(text);
	}
	return "";
}

/** The dialog in pi's editor slot, read by shape, or null when the slot holds anything else. */
export function readDialog(tui: TuiComponent | null): Dialog | null {
	const component = piSlot(tui, "editor")?.children?.[0];
	const fields = fieldsOf(component);
	if (!component || !fields || !isFunction(fields.handleInput)) return null;
	const dialog = component as DialogComponent;
	const seconds = countdownSeconds(fields);
	const { baseTitle, options, selectedIndex } = fields;
	if (typeof baseTitle === "string" && Array.isArray(options) && typeof selectedIndex === "number") {
		if (!options.every((option) => typeof option === "string")) return null;
		// pi's confirm is its selector with "Yes" and "No" and the title `title\nmessage`.
		const newline = baseTitle.indexOf("\n");
		if (newline !== -1 && options.length === 2 && options.every((option, i) => option === CONFIRM_OPTIONS[i])) {
			return { kind: "confirm", component: dialog, seconds, title: baseTitle.slice(0, newline), message: baseTitle.slice(newline + 1), selected: selectedIndex };
		}
		return { kind: "select", component: dialog, seconds, title: baseTitle, options: options as string[], selected: selectedIndex };
	}
	const input = fieldsOf(fields.input);
	if (typeof baseTitle === "string" && input && isFunction(input.getValue)) {
		const text = String(input.getValue());
		const cursor = typeof input.cursor === "number" ? Math.min(input.cursor, text.length) : text.length;
		return { kind: "input", component: dialog, seconds, title: baseTitle, text, cursor };
	}
	const editor = fieldsOf(fields.editor);
	if (editor && isFunction(editor.getText)) {
		const text = String(editor.getText());
		const cursor = isFunction(editor.getCursor) ? caretOffset(text, editor.getCursor()) : text.length;
		return { kind: "editor", component: dialog, seconds, title: firstText(component), text, cursor };
	}
	return null;
}

/** Node ids for one dialog. Each dialog gets its own overlay, so a new one is added and focused. */
export function dialogIds(n: number) {
	const overlay = `${ID_PREFIX}${n}`;
	return {
		overlay,
		list: `${overlay}l`,
		item: (index: number) => `${overlay}i${index}`,
		message: `${overlay}m`,
		buttons: `${overlay}b`,
		yes: `${overlay}y`,
		no: `${overlay}n`,
		field: `${overlay}f`,
		submit: `${overlay}s`,
		cancel: `${overlay}c`,
	};
}

/** The overlay for a dialog: modal, centred, with the countdown copied into its head. */
export function dialogNode(dialog: Dialog, n: number): SemanticNode {
	const ids = dialogIds(n);
	const head = dialog.seconds === undefined ? dialog.title : `${dialog.title} (${dialog.seconds}s)`;
	let children: SemanticNode[];
	switch (dialog.kind) {
		case "select":
			children = [
				{
					id: ids.list,
					k: "list",
					p: { selected: ids.item(dialog.selected) },
					c: dialog.options.map((label, i) => ({ id: ids.item(i), k: "item", p: { label } })),
				},
			];
			break;
		case "confirm":
			children = [
				{ id: ids.message, k: "md", p: { text: dialog.message } },
				{
					id: ids.buttons,
					k: "row",
					p: { gap: "sm", justify: "end" },
					c: [
						{ id: ids.yes, k: "button", p: { text: CONFIRM_OPTIONS[0], variant: dialog.selected === 0 ? "primary" : "default" } },
						{ id: ids.no, k: "button", p: { text: CONFIRM_OPTIONS[1], variant: dialog.selected === 1 ? "primary" : "default" } },
					],
				},
			];
			break;
		case "input":
		case "editor":
			children = [
				{ id: ids.field, k: dialog.kind, p: { text: dialog.text, cursor: dialog.cursor, mode: FIELD_MODE } },
				{
					id: ids.buttons,
					k: "row",
					p: { gap: "sm", justify: "end" },
					c: [
						{ id: ids.submit, k: "button", p: { text: "Submit", variant: "primary" } },
						{ id: ids.cancel, k: "button", p: { text: "Cancel", variant: "default" } },
					],
				},
			];
			break;
	}
	return { id: ids.overlay, k: "overlay", p: { anchor: "center", size: "md", modal: true, head }, c: children };
}

/** The node Tern should focus: the text field, or the overlay when the dialog has none. */
export function dialogFocus(dialog: Dialog, n: number): string {
	const ids = dialogIds(n);
	return dialog.kind === "input" || dialog.kind === "editor" ? ids.field : ids.overlay;
}

/** Move the selector to `target` and press Enter, as a user at the keyboard would. */
function chooseKeys(selected: number, target: number): string[] {
	const step = target > selected ? KEYS.down : KEYS.up;
	return [...Array<string>(Math.abs(target - selected)).fill(step), KEYS.enter];
}

/** The keys that answer a dialog for a Tern event, or null when the event is not for this dialog. */
export function dialogKeys(dialog: Dialog, n: number, event: TernEvent): string[] | null {
	const ids = dialogIds(n);
	if (dialog.kind === "select" && (event.ev === "select" || event.ev === "activate") && event.id === ids.list) {
		const target = dialog.options.findIndex((_option, i) => ids.item(i) === event.item);
		return target === -1 ? null : chooseKeys(dialog.selected, target);
	}
	if (dialog.kind === "confirm" && event.ev === "action") {
		if (event.id === ids.yes) return chooseKeys(dialog.selected, 0);
		if (event.id === ids.no) return chooseKeys(dialog.selected, 1);
	}
	if ((dialog.kind === "input" || dialog.kind === "editor") && event.ev === "action") {
		// Enter submits in pi's editor dialog too. A newline there is Shift+Enter.
		if (event.id === ids.submit) return [KEYS.enter];
		if (event.id === ids.cancel) return [KEYS.escape];
	}
	return null;
}

/** True for an event addressed to any dialog node, open or already closed. */
export function isDialogEvent(event: TernEvent): boolean {
	return typeof event.id === "string" && event.id.startsWith(ID_PREFIX);
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createDialogs(_pi: ExtensionAPI, host: SurfaceHost): Dialogs {
	const numbers = new WeakMap<DialogComponent, number>();
	let next = 0;
	const current = (): { dialog: Dialog; n: number } | null => {
		const dialog = readDialog(host.tui());
		if (!dialog) return null;
		let n = numbers.get(dialog.component);
		if (n === undefined) {
			next += 1;
			n = next;
			numbers.set(dialog.component, n);
		}
		return { dialog, n };
	};
	return {
		describe() {
			const open = current();
			return open ? [dialogNode(open.dialog, open.n)] : [];
		},
		focus() {
			const open = current();
			return open ? dialogFocus(open.dialog, open.n) : null;
		},
		onEvent(event) {
			// A dialog's events are consumed even when they answer nothing, so the sink never applies a
			// stale `edit` or `undo` for a dialog field to the composer.
			if (!isDialogEvent(event)) return false;
			const open = current();
			const keys = open ? dialogKeys(open.dialog, open.n, event) : null;
			if (open && keys) for (const key of keys) open.dialog.component.handleInput(key);
			return true;
		},
	};
}
