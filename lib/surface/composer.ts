/**
 * Composer area: the live editor in pi's editor slot as an `editor` node.
 *
 * Built in #11: text, caret, `sendable`, placeholder, the Vim `mode`, autocomplete, and Tern's
 * `edit`, `undo` and `send` events. This stub is the prototype's composer: the editor node with the
 * Vim status, and the autocomplete menu as rows. The sink still applies `edit`, `undo` and `send`
 * to the editor `editor()` returns.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent, type TuiComponent } from "./host.ts";

export interface Composer {
	/** The live editor, or null while a dialog holds pi's editor slot. */
	editor(): unknown;
	/** The composer's dock nodes, in order. Empty while a dialog holds the editor slot. */
	describe(cols: number): SemanticNode[];
	/** The composer's node, which holds Tern's keyboard focus while no dialog does. Null while a dialog holds the editor slot. */
	focus(): string | null;
	/** True when the event was for the composer and pi's editor has applied it. */
	onEvent(event: TernEvent): boolean;
}

/** Where `pi-vim-editor` publishes its Vim status on the editor instance. */
export const VIM_STATUS = Symbol.for("pi-vim-editor");

/** Insert has no label: Tern edits natively only while the `editor` node carries no `mode`. */
const MODE_LABEL: Record<string, string | undefined> = {
	normal: "NORMAL",
	visual: "VISUAL",
	"visual-line": "VISUAL",
	"visual-block": "VISUAL",
	replace: "REPLACE",
};

/** The editor as the composer reads it: pi-tui's `Editor` API plus `pi-vim-editor`'s status. */
export interface PiEditor extends TuiComponent {
	getText(): string;
	getCursor?(): { line: number; col: number };
	[VIM_STATUS]?: { status?(): { mode?: string; pending?: string } | undefined };
	autocompleteState?: unknown;
	autocompleteList?: TuiComponent;
}

export function findEditor(tui: TuiComponent | null): PiEditor | null {
	const slot = piSlot(tui, "editor");
	const editor = slot?.children?.find((child) => typeof (child as Partial<PiEditor>).getText === "function");
	return (editor as PiEditor | undefined) ?? null;
}

export function editorNode(editor: PiEditor): SemanticNode {
	const text = String(editor.getText() ?? "");
	const caret = editor.getCursor?.() ?? { line: 0, col: 0 };
	const lines = text.split("\n");
	let cursor = 0;
	for (let i = 0; i < caret.line && i < lines.length; i += 1) cursor += lines[i].length + 1;
	cursor += Math.min(caret.col ?? 0, lines[caret.line]?.length ?? 0);
	const props: Record<string, unknown> = { text, cursor, sendable: true, placeholder: "Message pi" };
	const vim = editor[VIM_STATUS]?.status?.();
	const mode = vim?.mode ? MODE_LABEL[vim.mode] : undefined;
	if (mode) props.mode = vim?.pending ? `${mode} ${vim.pending}` : mode;
	return { id: "ke", k: "editor", p: props };
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createComposer(_pi: ExtensionAPI, host: SurfaceHost): Composer {
	return {
		editor: () => findEditor(host.tui()),
		describe(cols) {
			const editor = findEditor(host.tui());
			if (!editor) return [];
			const nodes: SemanticNode[] = [];
			if (editor.autocompleteState && editor.autocompleteList) {
				nodes.push({ id: "ka", k: "rows", p: { cols, lines: renderRows(editor.autocompleteList, cols) } });
			}
			nodes.push(editorNode(editor));
			return nodes;
		},
		focus: () => (findEditor(host.tui()) ? "ke" : null),
		onEvent: () => false,
	};
}
