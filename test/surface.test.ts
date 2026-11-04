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
import { containerRows, createDock, WORKING_TEXT } from "../lib/surface/dock.ts";
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

test("the dock is one rows node per pi container, in pi's dock order around the composer", () => {
	const editor = fakeEditor("hi", { line: 0, col: 2 });
	const tui = fakeTui(box(editor));
	assert.equal(findEditor(tui), editor);
	const dock = createDock(fakePi().pi, { tui: () => tui, invalidate() {} });
	const nodes = dock.describe(80, [editorNode(editor)]);
	assert.deepEqual(
		nodes.map((node) => [node.id, node.k]),
		[["ks", "rows"], ["kwa", "rows"], ["ke", "editor"], ["kf", "rows"]],
		"the empty pending and below-widget containers get no node",
	);
	assert.deepEqual(nodes[0].p?.lines, ["Working..."]);
	assert.deepEqual(nodes[1].p?.lines, ["widget above"]);
	assert.deepEqual(nodes[3].p?.lines, ["~/work", "model"]);
});

test("a container's blank edges are dropped, and an all-blank container shows nothing", () => {
	assert.deepEqual(containerRows(rows("", "\x1b[2m  \x1b[0m", "a", "", "b", " "), 80), ["a", "", "b"]);
	assert.deepEqual(containerRows(rows("   ", ""), 80), [], "pi's idle status is two blank rows");
	assert.deepEqual(containerRows(undefined, 80), []);
});

test("while the agent runs, a shimmer stands in for the indicator pi draws in the composer border", () => {
	const editor = fakeEditor("", { line: 0, col: 0 });
	const tui = box(rows("transcript"), rows("queued: next"), rows("", ""), rows(), box(editor), rows(), rows("~/work"));
	const { pi, handlers } = fakePi();
	let invalidated = 0;
	const dock = createDock(pi, { tui: () => tui, invalidate: () => (invalidated += 1) });
	const ids = () => dock.describe(80, [editorNode(editor)]).map((node) => node.id);
	assert.deepEqual(ids(), ["kp", "ke", "kf"]);
	handlers.get("agent_start")?.({}, {});
	handlers.get("turn_start")?.({}, {});
	assert.equal(invalidated, 1, "only a change of state repaints");
	const nodes = dock.describe(80, [editorNode(editor)]);
	assert.deepEqual(nodes[1], { id: "kw", k: "shimmer", p: { text: WORKING_TEXT } }, "after pending, where pi's status container sits");
	handlers.get("agent_end")?.({}, {});
	assert.equal(invalidated, 2);
	assert.deepEqual(ids(), ["kp", "ke", "kf"]);
});

test("when pi draws its loader in the status container, those rows show and no shimmer is added", () => {
	const editor = fakeEditor("", { line: 0, col: 0 });
	const { pi, handlers } = fakePi();
	const dock = createDock(pi, { tui: () => fakeTui(box(editor)), invalidate() {} });
	handlers.get("agent_start")?.({}, {});
	const ids = dock.describe(80, [editorNode(editor)]).map((node) => node.id);
	assert.deepEqual(ids, ["ks", "kwa", "ke", "kf"]);
});

test("while a dialog holds the editor slot, the slot shows as rows", () => {
	const tui = fakeTui(box(rows("Pick one", "> a", "  b")));
	assert.equal(findEditor(tui), null);
	const nodes = createDock(fakePi().pi, { tui: () => tui, invalidate() {} }).describe(80, []);
	assert.deepEqual(nodes[2], { id: "kx", k: "rows", p: { cols: 80, lines: ["Pick one", "> a", "  b"] } });
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
			["ks", "kwa", "ke", "kf"],
		);
		assert.equal(regions.dock[2].p?.mode, "NORMAL");
		assert.ok(attached[0].editor?.(), "the live editor is handed to the sink");
	});
});
