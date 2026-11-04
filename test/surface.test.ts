/**
 * The full surface in lib/surface/: when it activates, and the composer and dock it describes.
 *
 * pi's TUI is faked with the seven containers interactive mode mounts, because the areas read only
 * `children` and `render()`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { NativeHandle, SemanticSurface } from "../native/native.d.mts";
import { editorNode, findEditor, VIM_STATUS, type PiEditor } from "../lib/surface/composer.ts";
import { createDock } from "../lib/surface/dock.ts";
import type { TuiComponent } from "../lib/surface/host.ts";
import { registerNativeSurface } from "../lib/surface/index.ts";

const rows = (...lines: string[]): TuiComponent => ({ render: () => lines });
const box = (...children: TuiComponent[]): TuiComponent => ({ render: (cols) => children.flatMap((child) => child.render(cols)), children });

function fakeEditor(text: string, cursor: { line: number; col: number }, vim?: { mode: string; pending?: string }): PiEditor {
	return { render: () => ["── editor ──"], getText: () => text, getCursor: () => cursor, [VIM_STATUS]: { status: () => vim } };
}

function fakeTui(editorSlot: TuiComponent): TuiComponent {
	return box(rows("transcript"), rows(), rows("Working..."), rows("widget above"), editorSlot, rows(), rows("~/work", "model"));
}

test("the editor node carries the caret as an offset and the Vim mode label", () => {
	const node = editorNode(fakeEditor("ab\ncd", { line: 1, col: 1 }, { mode: "normal", pending: "d" }));
	assert.deepEqual(node, { id: "ke", k: "editor", p: { text: "ab\ncd", cursor: 4, sendable: true, placeholder: "Message pi", mode: "NORMAL d" } });
	assert.equal(editorNode(fakeEditor("", { line: 0, col: 0 }, { mode: "insert" })).p?.mode, undefined, "Insert has no label");
});

test("the dock is rows above, the composer, then rows below, like the prototype", () => {
	const editor = fakeEditor("hi", { line: 0, col: 2 });
	const tui = fakeTui(box(editor));
	assert.equal(findEditor(tui), editor);
	const dock = createDock({} as ExtensionAPI, { tui: () => tui, invalidate() {} });
	const nodes = dock.describe(80, [editorNode(editor)]);
	assert.deepEqual(
		nodes.map((node) => [node.id, node.k]),
		[["kt", "rows"], ["ke", "editor"], ["kb", "rows"]],
	);
	assert.deepEqual(nodes[0].p?.lines, ["Working...", "widget above"]);
	assert.deepEqual(nodes[2].p?.lines, ["~/work", "model"]);
});

test("while a dialog holds the editor slot, the slot shows as rows", () => {
	const tui = fakeTui(box(rows("Pick one", "> a", "  b")));
	assert.equal(findEditor(tui), null);
	const nodes = createDock({} as ExtensionAPI, { tui: () => tui, invalidate() {} }).describe(80, []);
	assert.deepEqual(nodes[1], { id: "kx", k: "rows", p: { cols: 80, lines: ["Pick one", "> a", "  b"] } });
});

/** A pi whose handlers and widgets the test can drive. */
function fakePi() {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => void>();
	const pi = { on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, handler) };
	return { pi: pi as unknown as ExtensionAPI, handlers };
}

function withHandle(handle: NativeHandle | undefined, run: () => void) {
	const globals = globalThis as { __piTernNative?: NativeHandle };
	const previous = globals.__piTernNative;
	try {
		if (handle) globals.__piTernNative = handle;
		else delete globals.__piTernNative;
		run();
	} finally {
		if (previous) globals.__piTernNative = previous;
		else delete globals.__piTernNative;
	}
}

function fakeHandle(semantic: boolean, attached: SemanticSurface[]): NativeHandle {
	return {
		state: () => ({ active: true, semantic }) as ReturnType<NativeHandle["state"]>,
		suspend: () => false,
		resume: () => false,
		fallback: () => true,
		attachSurface: (surface) => attached.push(surface) > 0,
		invalidate() {},
	};
}

test("outside the native launcher, and with PI_TERN_SEMANTIC=0, the surface registers nothing", () => {
	for (const handle of [undefined, fakeHandle(false, [])]) {
		withHandle(handle, () => {
			const { pi, handlers } = fakePi();
			registerNativeSurface(pi);
			assert.equal(handlers.size, 0);
		});
	}
});

test("inside the native surface it attaches once pi's TUI arrives through the widget factory", () => {
	const attached: SemanticSurface[] = [];
	withHandle(fakeHandle(true, attached), () => {
		const { pi, handlers } = fakePi();
		registerNativeSurface(pi);
		const tui = fakeTui(box(fakeEditor("", { line: 0, col: 0 }, { mode: "normal" })));
		let placement: unknown;
		handlers.get("session_start")?.(
			{},
			{
				hasUI: true,
				ui: {
					setWidget: (_key: string, factory: (root: unknown) => unknown, options: { placement?: string }) => {
						placement = options.placement;
						factory(tui);
					},
				},
			},
		);
		assert.equal(placement, "belowEditor");
		assert.equal(attached.length, 1);
		const regions = attached[0].describe(80);
		assert.deepEqual(regions.main, [{ id: "xrows", k: "rows", p: { cols: 80, lines: ["transcript"] } }], "the transcript stub is pi's document as rows");
		assert.deepEqual(regions.layer, []);
		assert.deepEqual(
			regions.dock.map((node) => node.id),
			["kt", "ke", "kb"],
		);
		assert.equal(regions.dock[1].p?.mode, "NORMAL");
		assert.ok(attached[0].editor?.(), "the live editor is handed to the sink");
	});
});
