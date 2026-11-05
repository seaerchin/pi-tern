/**
 * Composer area: the live editor in pi's editor slot as an `editor` node.
 *
 * The node carries the text, the caret, `sendable`, a placeholder, and the Vim `mode` and visual
 * selection from `pi-vim-editor`'s published status. An open autocomplete list is an `overlay` in `layer`,
 * anchored to the caret. Tern's `edit`, `undo` and `send` events go through pi's editor API. Two
 * things that API lacks, placing the caret and reading the autocomplete list, go through
 * `editorInternals` only. The editor node asks for Tern's focus, because Tern sends `edit` and
 * `undo` only for a focused field.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { bindingSequence, keySequence } from "./keys.ts";
import { piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent, type TuiComponent } from "./host.ts";

export interface Composer {
	/** The live editor, or null while a dialog holds pi's editor slot. */
	editor(): unknown;
	/** The composer's dock nodes, in order. Empty while a dialog holds the editor slot. */
	describe(cols: number): SemanticNode[];
	/** The composer's `layer` nodes: the autocomplete overlay while a list is open. */
	overlays(cols: number): SemanticNode[];
	/** The editor node's id while the editor is in pi's slot, else null. */
	focus(): string | null;
	/** True when the event was for the composer. The composer has applied it or dropped it. */
	onEvent(event: TernEvent): boolean;
	/** Send the draft, as a click on the frame's send control asks. */
	submit(): void;
}

/** Where `pi-vim-editor` publishes its Vim status on the editor instance. */
export const VIM_STATUS = Symbol.for("pi-vim-editor");

export const EDITOR_ID = "ke";
export const AUTOCOMPLETE_ID = "ka";
export const INSERT_BADGE_ID = "kei";

/** `pi-vim-editor`'s published Vim status. `selection` comes from capability version 2. */
export interface VimStatus {
	mode?: string;
	pending?: string;
	selection?: VimSelection;
}

/** A Visual selection as `pi-vim-editor` publishes it. Offsets are UTF-16 offsets into `getText()`. */
export interface VimSelection {
	kind: "char" | "line" | "block";
	/** `char`: one end of the selected range. Else the anchor's position. */
	anchor: number;
	/** `char`: the other end. Else the cursor's position. */
	head: number;
	/** `block` only: the selected range of each line. */
	spans?: { from: number; to: number }[];
}

/** A styled range on an `editor` node. */
export interface EditorDecoration {
	from: number;
	to: number;
	s: string;
}

/** Insert has no label: Tern edits natively only while the `editor` node carries no `mode`. */
const MODE_LABEL: Record<string, string | undefined> = {
	normal: "NORMAL",
	visual: "VISUAL",
	"visual-line": "VISUAL LINE",
	"visual-block": "VISUAL BLOCK",
	replace: "REPLACE",
};

/** The editor as the composer uses it: pi's public `EditorComponent` API plus `pi-vim-editor`'s status. */
export interface PiEditor extends TuiComponent {
	getText(): string;
	setText?(text: string): void;
	handleInput?(data: string): void;
	getCursor?(): { line: number; col: number };
	onSubmit?: (text: string) => void;
	addToHistory?(text: string): void;
	isShowingAutocomplete?(): boolean;
	disableSubmit?: boolean;
	[VIM_STATUS]?: { status?(): VimStatus | undefined };
}

/**
 * The pi-tui `Editor` internals the composer needs and no public API offers. Each is checked by
 * shape before use, so a pi update that changes them costs the caret placement or the
 * autocomplete overlay, never the composer.
 *
 * - `state.cursorLine` and `setCursorCol()`: where the caret goes after a Tern `edit`.
 *   `pi-vim-editor` moves the caret the same way.
 * - `autocompleteList`: the open list, rendered as rows inside the overlay.
 */
export interface EditorInternals {
	/** False when the shape did not match. The caret then stays where `setText` left it, at the end. */
	placeCaret(line: number, col: number): boolean;
	/** The open list, null when none is open, or undefined when the shape did not match. */
	autocompleteList(): TuiComponent | null | undefined;
}

export function editorInternals(editor: PiEditor): EditorInternals {
	const raw = editor as unknown as {
		state?: { cursorLine?: unknown };
		setCursorCol?: unknown;
		autocompleteList?: { render?: unknown };
	};
	return {
		placeCaret(line, col) {
			if (typeof raw.state?.cursorLine !== "number" || typeof raw.setCursorCol !== "function") return false;
			raw.state.cursorLine = line;
			(raw.setCursorCol as (col: number) => void).call(editor, col);
			return true;
		},
		autocompleteList() {
			if (editor.isShowingAutocomplete?.() !== true) return null;
			const list = raw.autocompleteList;
			// The list is created once the provider answers, so an open state without one is normal.
			if (list === undefined) return null;
			return typeof list.render === "function" ? (list as TuiComponent) : undefined;
		},
	};
}

export function findEditor(tui: TuiComponent | null): PiEditor | null {
	const slot = piSlot(tui, "editor");
	const editor = slot?.children?.find((child) => typeof (child as Partial<PiEditor>).getText === "function");
	return (editor as PiEditor | undefined) ?? null;
}

/** The caret as a UTF-16 offset into `text`, from pi's line and column. */
export function caretOffset(text: string, caret: { line: number; col: number }): number {
	const lines = text.split("\n");
	let offset = 0;
	for (let i = 0; i < caret.line && i < lines.length; i += 1) offset += lines[i].length + 1;
	return offset + Math.min(caret.col ?? 0, lines[caret.line]?.length ?? 0);
}

/** A UTF-16 offset into `text` as pi's line and column. */
export function caretPosition(text: string, offset: number): { line: number; col: number } {
	const lines = text.split("\n");
	let remaining = Math.max(0, Math.min(offset, text.length));
	let line = 0;
	while (line < lines.length - 1 && remaining > lines[line].length) {
		remaining -= lines[line].length + 1;
		line += 1;
	}
	return { line, col: remaining };
}

/** The `decor` style for a block selection. Tern draws `mark` with an accent background, as a selection. */
export const SELECTION_DECOR = "mark";

/**
 * The Vim visual selection as `editor` props, as decided in #7.
 *
 * Tern selects from `anchor` to the caret, so `char` and `line` move the caret to the selection's
 * moving end. Pi's own caret sits on the last selected character, one short of that end. `line`
 * stretches to the line edges. Tern has one selection per field, so each line of a `block` is a
 * `decor` range.
 */
export function selectionProps(
	vim: VimStatus | undefined,
	text: string,
): { anchor?: number; cursor?: number; decor?: EditorDecoration[] } {
	const selection = vim?.selection;
	const inText = (offset: unknown): offset is number =>
		Number.isInteger(offset) && (offset as number) >= 0 && (offset as number) <= text.length;
	if (!selection || !inText(selection.anchor) || !inText(selection.head)) return {};
	const { anchor, head } = selection;
	switch (selection.kind) {
		case "char":
			return { anchor, cursor: head };
		case "line": {
			const first = Math.min(anchor, head);
			const start = first === 0 ? 0 : text.lastIndexOf("\n", first - 1) + 1;
			const newline = text.indexOf("\n", Math.max(anchor, head));
			const end = newline === -1 ? text.length : newline;
			return head >= anchor ? { anchor: start, cursor: end } : { anchor: end, cursor: start };
		}
		case "block": {
			const decor = (selection.spans ?? [])
				.filter((span) => inText(span?.from) && inText(span.to) && span.from < span.to)
				.map(({ from, to }) => ({ from, to, s: SELECTION_DECOR }));
			return decor.length > 0 ? { decor } : {};
		}
		default:
			return {};
	}
}

export function editorNode(editor: PiEditor): SemanticNode {
	const text = String(editor.getText() ?? "");
	const cursor = caretOffset(text, editor.getCursor?.() ?? { line: 0, col: 0 });
	const props: Record<string, unknown> = {
		text,
		cursor,
		sendable: editor.disableSubmit !== true,
		placeholder: "Message pi",
	};
	const vim = editor[VIM_STATUS]?.status?.();
	Object.assign(props, selectionProps(vim, text));
	const mode = vim?.mode ? MODE_LABEL[vim.mode] : undefined;
	if (mode) props.mode = vim?.pending ? `${mode} ${vim.pending}` : mode;
	return { id: EDITOR_ID, k: "editor", p: props };
}

/**
 * The Insert label as a badge beside the editor, because a `mode` on the editor node stops Tern's
 * native editing. Null outside Insert.
 */
export function insertBadge(editor: PiEditor): SemanticNode | null {
	if (editor[VIM_STATUS]?.status?.()?.mode !== "insert") return null;
	return { id: INSERT_BADGE_ID, k: "badge", p: { text: "INSERT", tone: "accent" } };
}

/** Pi's normalization for stored text (`Editor.setText`), so caret offsets match what it keeps. */
function normalizeText(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
}

function splitsSurrogatePair(text: string, offset: number): boolean {
	if (offset <= 0 || offset >= text.length) return false;
	const high = text.charCodeAt(offset - 1);
	const low = text.charCodeAt(offset);
	return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

function clampOffset(value: unknown, max: number): number {
	const number = Number(value);
	return Number.isFinite(number) ? Math.min(Math.max(Math.trunc(number), 0), max) : 0;
}

/**
 * A Tern `edit` against the current text: null when stale, else the new text and caret.
 *
 * Tern sends `len`, the length of the text it saw. A different length means keys are still in
 * flight, so the edit is dropped as OMP does. The caret is mapped from Tern's expected result onto
 * the normalized one.
 */
export function resolveEdit(current: string, event: TernEvent): { text: string; cursor: number; changed: boolean } | null {
	if (Number(event.len) !== current.length) return null;
	let ternFrom = clampOffset(event.from, current.length);
	let ternTo = clampOffset(event.to, current.length);
	if (ternTo < ternFrom) [ternFrom, ternTo] = [ternTo, ternFrom];
	// A range never splits a surrogate pair, so it widens to the whole character.
	const from = splitsSurrogatePair(current, ternFrom) ? ternFrom - 1 : ternFrom;
	const to = splitsSurrogatePair(current, ternTo) ? ternTo + 1 : ternTo;
	const raw = typeof event.text === "string" ? event.text : "";
	const insert = normalizeText(raw);
	const text = current.slice(0, from) + insert + current.slice(to);
	// Where Tern's caret sits in its own result, carried over to the widened, normalized one.
	const expected = clampOffset(event.cursor, current.length - (ternTo - ternFrom) + raw.length);
	let cursor: number;
	if (expected <= from) cursor = expected;
	else if (expected <= ternFrom) cursor = from;
	else if (expected < ternFrom + raw.length) cursor = from + Math.min(expected - ternFrom, insert.length);
	else cursor = from + insert.length + Math.max(0, expected - ternFrom - raw.length - (to - ternTo));
	cursor = Math.min(cursor, text.length);
	if (splitsSurrogatePair(text, cursor)) cursor -= 1;
	return { text, cursor, changed: from !== to || insert !== "" };
}

export { keySequence };

/**
 * The bytes of pi's undo key, so an `undo` event goes through `handleInput` like the key would.
 * That keeps `pi-vim-editor`'s own undo bookkeeping in step. Undefined when no bound key encodes.
 */
export function undoKeySequence(): string | undefined {
	return bindingSequence("tui.editor.undo");
}

/**
 * Apply one Tern event to the editor. Mirrors pi's own paths: `send` is pi's Alt+Enter submit,
 * with a draft kept in history for recall as Tern asks. `warn` reports a missing internal once.
 */
export function applyEditorEvent(editor: PiEditor, event: TernEvent, warn: (message: string) => void): void {
	switch (event.ev) {
		case "send": {
			const text = String(event.text ?? "");
			if (!text.trim() || editor.disableSubmit === true || typeof editor.onSubmit !== "function") return;
			const draft = String(editor.getText() ?? "");
			if (draft.trim()) editor.addToHistory?.(draft);
			editor.setText?.("");
			editor.onSubmit(text);
			return;
		}
		case "edit": {
			const current = String(editor.getText() ?? "");
			const resolved = resolveEdit(current, event);
			if (!resolved) return;
			if (resolved.changed) editor.setText?.(resolved.text);
			// Pi may normalize differently than expected, so the caret is placed in the text it kept.
			const kept = String(editor.getText() ?? "");
			const caret = caretPosition(kept, Math.min(resolved.cursor, kept.length));
			if (!editorInternals(editor).placeCaret(caret.line, caret.col)) {
				warn("pi-tern: pi's editor changed shape, so a Tern edit leaves the caret at the end.");
			}
			return;
		}
		case "undo": {
			const sequence = undoKeySequence();
			if (sequence) editor.handleInput?.(sequence);
			else warn("pi-tern: pi's undo key has no sequence pi-tern can send, so Tern's undo does nothing.");
			return;
		}
		default:
			return;
	}
}

const EDITOR_EVENTS = new Set(["send", "edit", "undo", "focus"]);

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createComposer(pi: ExtensionAPI, host: SurfaceHost): Composer {
	let notify: ((message: string) => void) | undefined;
	const warned = new Set<string>();
	const warn = (message: string) => {
		if (warned.has(message)) return;
		warned.add(message);
		notify?.(message);
	};
	pi.on("session_start", (_event, ctx) => {
		if (ctx.hasUI) notify = (message) => ctx.ui.notify(message, "warning");
	});

	return {
		editor: () => findEditor(host.tui()),
		describe() {
			const editor = findEditor(host.tui());
			if (!editor) return [];
			const badge = insertBadge(editor);
			return badge ? [badge, editorNode(editor)] : [editorNode(editor)];
		},
		overlays(cols) {
			const editor = findEditor(host.tui());
			if (!editor) return [];
			const list = editorInternals(editor).autocompleteList();
			if (list === undefined) warn("pi-tern: pi's editor changed shape, so autocomplete is not shown. Its keys still work.");
			const lines = list ? renderRows(list, cols) : [];
			if (lines.length === 0) return [];
			// Tern positions a caret-anchored overlay only directly under `layer`, as OMP hoists it.
			// `lg` spans the pane, the width pi lays the list out for. Smaller sizes clip its descriptions.
			return [
				{
					id: AUTOCOMPLETE_ID,
					k: "overlay",
					p: { anchor: { caret: EDITOR_ID }, size: "lg" },
					c: [{ id: `${AUTOCOMPLETE_ID}r`, k: "rows", p: { cols, lines } }],
				},
			];
		},
		focus: () => (findEditor(host.tui()) ? EDITOR_ID : null),
		onEvent(event) {
			if (event.id !== EDITOR_ID || !EDITOR_EVENTS.has(String(event.ev))) return false;
			// While a dialog holds the slot the event is dropped, so the sink never applies it to a stale editor.
			const editor = findEditor(host.tui());
			if (editor) applyEditorEvent(editor, event, warn);
			return true;
		},
		submit() {
			const editor = findEditor(host.tui());
			if (editor) applyEditorEvent(editor, { ev: "send", text: String(editor.getText() ?? "") }, warn);
		},
	};
}
