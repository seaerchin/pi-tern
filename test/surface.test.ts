/**
 * The full surface in lib/surface/: when it activates, and the composer and dock it describes.
 *
 * pi's TUI is faked with the seven containers interactive mode mounts, because the areas read only
 * `children` and `render()`.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
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
	const dock = createDock(fakePi().pi, { tui: () => tui, invalidate() {}, log() {}, blob: () => undefined });
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

test("while the agent runs, OMP's working row stands in for the indicator pi draws in the composer border", () => {
	const editor = fakeEditor("", { line: 0, col: 0 });
	const tui = box(rows("transcript"), rows("queued: next"), rows("", ""), rows(), box(editor), rows(), rows("~/work"));
	const { pi, emit } = fakePi();
	let invalidated = 0;
	const dock = createDock(pi, { tui: () => tui, invalidate: () => (invalidated += 1), log() {}, blob: () => undefined });
	const ids = () => dock.describe(80, [editorNode(editor)]).map((node) => node.id);
	assert.deepEqual(ids(), ["kp", "ke", "kf"]);
	emit("agent_start", {}, {});
	emit("turn_start", {}, {});
	assert.equal(invalidated, 1, "only a change of state repaints");
	const nodes = dock.describe(80, [editorNode(editor)]);
	assert.deepEqual([nodes[1].id, nodes[1].k, nodes[1].p?.role], ["kw", "row", "omp.working"], "after pending, where pi's status container sits");
	assert.equal(nodes[1].c?.find((node) => node.k === "shimmer")?.p?.text, WORKING_TEXT);
	emit("agent_end", {}, {});
	assert.equal(invalidated, 2);
	assert.deepEqual(ids(), ["kp", "ke", "kf"]);
});

test("when pi draws its loader in the status container, those rows show and no shimmer is added", () => {
	const editor = fakeEditor("", { line: 0, col: 0 });
	const { pi, emit } = fakePi();
	const dock = createDock(pi, { tui: () => fakeTui(box(editor)), invalidate() {}, log() {}, blob: () => undefined });
	emit("agent_start", {}, {});
	const ids = dock.describe(80, [editorNode(editor)]).map((node) => node.id);
	assert.deepEqual(ids, ["ks", "kwa", "ke", "kf"]);
});

test("while a dialog holds the editor slot, the slot shows as rows", () => {
	const tui = fakeTui(box(rows("Pick one", "> a", "  b")));
	assert.equal(findEditor(tui), null);
	const nodes = createDock(fakePi().pi, { tui: () => tui, invalidate() {}, log() {}, blob: () => undefined }).describe(80, []);
	assert.deepEqual(nodes[2], { id: "kx", k: "rows", p: { cols: 80, lines: ["Pick one", "> a", "  b"] } });
});

test("while the dialogs area shows the dialog as an overlay, the editor slot stays empty", () => {
	const tui = fakeTui(box(rows("Pick one", "> a", "  b")));
	const nodes = createDock(fakePi().pi, { tui: () => tui, invalidate() {}, log() {}, blob: () => undefined }).describe(80, [], true);
	assert.deepEqual(
		nodes.map((node) => node.id),
		["ks", "kwa", "kf"],
	);
});

/** A pi whose handlers and widgets the test can drive. */
function fakePi() {
	type Handler = (event: unknown, ctx: unknown) => void;
	const handlers = new Map<string, Handler[]>();
	const bus = new EventEmitter();
	const events = { emit: (channel: string, data: unknown) => bus.emit(channel, data), on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler) };
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]), events };
	const emit = (name: string, event: unknown, ctx: unknown) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi: pi as unknown as ExtensionAPI, handlers, emit, events };
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
		blob: () => undefined,
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
		const { pi, emit } = fakePi();
		registerNativeSurface(pi);
		const tui = fakeTui(box(fakeEditor("", { line: 0, col: 0 }, { mode: "normal" })));
		let placement: unknown;
		const branch = [{ type: "message", id: "e1", message: { role: "user", content: "hi", timestamp: 1 } }];
		emit(
			"session_start",
			{},
			{
				hasUI: true,
				sessionManager: { getBranch: () => branch },
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
		assert.deepEqual(
			regions.main.map((node) => [node.id, node.k, node.p?.role]),
			[["xuser-1", "card", "omp.user"]],
			"the transcript is built from the session branch",
		);
		assert.deepEqual(regions.layer, []);
		assert.deepEqual(
			regions.dock.map((node) => node.id),
			["ks", "kwa", "ke", "kf"],
		);
		assert.equal(regions.dock[2].p?.mode, "NORMAL");
		assert.equal(regions.focus, "ke", "the composer holds Tern's focus while no dialog does");
		assert.ok(attached[0].editor?.(), "the live editor is handed to the sink");
	});
});

test("an open dialog fills layer, empties the editor slot and takes the focus from the composer", () => {
	const attached: SemanticSurface[] = [];
	withHandle(fakeHandle(true, attached), () => {
		const { pi, emit } = fakePi();
		registerNativeSurface(pi);
		const selector = { baseTitle: "Pick", options: ["a", "b"], selectedIndex: 0, render: () => ["Pick"], handleInput() {} };
		const slot = box(fakeEditor("", { line: 0, col: 0 }));
		const tui = fakeTui(slot);
		emit("session_start", {}, { hasUI: true, ui: { setWidget: (_key: string, factory: (root: unknown) => unknown) => factory(tui) } });
		assert.equal(attached[0].describe(80).focus, "ke");
		slot.children = [selector];
		const regions = attached[0].describe(80);
		assert.deepEqual(regions.layer.map((node) => [node.id, node.k]), [["dlg1", "overlay"]]);
		assert.deepEqual(regions.dock.map((node) => node.id), ["ks", "kwa", "kf"]);
		assert.equal(regions.focus, "dlg1l");
	});
});

test("tool cards go through the describer registry: the built-in subagent describer, a local override over the bus, and a throwing one's fallback", () => {
	const attached: SemanticSurface[] = [];
	withHandle(fakeHandle(true, attached), () => {
		const { pi, emit, events } = fakePi();
		const diagnostics = registerNativeSurface(pi);
		const branch = [
			{ type: "message", id: "e1", message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "s1", name: "subagent", arguments: { agent: "scout", task: "look" } }] } },
			{ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "s1", timestamp: 2, content: [{ type: "text", text: "found" }], details: { mode: "single", results: [{ index: 0, agent: "scout", task: "look", exitCode: 0, finalOutput: "found" }] } } },
		];
		const tui = fakeTui(box(fakeEditor("", { line: 0, col: 0 })));
		emit("session_start", {}, { hasUI: true, sessionManager: { getBranch: () => branch }, ui: { setWidget: (_key: string, factory: (root: unknown) => unknown) => factory(tui) } });
		const card = () => attached[0].describe(80).main.find((node) => node.id === "xts1");
		assert.deepEqual(card()?.c?.map((node) => node.k), ["agent"], "the built-in describer");

		events.emit("tern:describe", { kind: "tool", key: "subagent", source: "local", describe: () => ({ head: "mine", body: [{ id: "m", k: "md", p: { text: "local" } }] }) });
		assert.deepEqual([card()?.p?.title, card()?.c?.[0].id], ["mine", "xts1-m"], "a local describer wins");

		events.emit("tern:describe", {
			kind: "tool",
			key: "subagent",
			source: "local",
			describe: () => {
				throw new Error("broken");
			},
		});
		assert.deepEqual(card()?.c?.map((node) => [node.id, node.k]), [["xts1-o", "ansi"]], "the generic card");
		assert.equal(diagnostics?.describers().problems[0]?.first, "describe threw: broken");
	});
});
