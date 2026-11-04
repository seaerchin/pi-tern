/**
 * The composer frame: pi's footer data read by shape, the usage totals, OMP's composer nodes and
 * the clicks on its controls.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDock } from "../lib/surface/dock.ts";
import {
	createFrame,
	FRAME_ID,
	type FrameState,
	footerInternals,
	formatCwd,
	frameNode,
	plainStatus,
	STATUSES_ID,
	statusesNode,
	usageTotals,
	WORKING_ID,
	workingRow,
} from "../lib/surface/frame.ts";
import type { SemanticNode, SurfaceHost, TuiComponent } from "../lib/surface/host.ts";

function footerData(statuses: Record<string, string> = {}, providers = 1) {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		getAvailableProviderCount: () => providers,
	};
}

/** pi's footer container holding its built-in `FooterComponent`. */
function builtInFooter(statuses: Record<string, string> = {}): TuiComponent {
	const footer = { footerData: footerData(statuses), autoCompactEnabled: true, render: () => ["~/work (main)", "stats"] };
	return { render: () => footer.render(), children: [footer] };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function state(overrides: Partial<FrameState> = {}): FrameState {
	return {
		cwd: "~/work",
		branch: "main",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 },
		context: { percent: 12.5, contextWindow: 200000 },
		contextWindow: 200000,
		autoCompact: true,
		model: { id: "claude-opus-5-5", provider: "claude-bridge", reasoning: true },
		thinkingLevel: "medium",
		providerCount: 1,
		running: false,
		...overrides,
	};
}

const EDITOR: SemanticNode = { id: "ke", k: "editor", p: { text: "" } };

/** Every node in a tree by id. */
function byId(node: SemanticNode, found = new Map<string, SemanticNode>()): Map<string, SemanticNode> {
	found.set(node.id, node);
	for (const child of node.c ?? []) byId(child, found);
	return found;
}

function spanText(node: SemanticNode | undefined): string | undefined {
	return (node?.p?.spans as { t: string }[] | undefined)?.map((span) => span.t).join("");
}

test("the built-in footer's data is read by shape, and a custom footer gives null", () => {
	assert.equal(footerInternals(builtInFooter())?.autoCompact, true);
	assert.equal(footerInternals({ render: () => [], children: [{ render: () => ["custom"] }] }), null, "setFooter's component");
	assert.equal(footerInternals({ render: () => [], children: [] }), null);
	assert.equal(footerInternals(undefined), null);
	const partial = { render: () => [], children: [{ render: () => [], footerData: { getGitBranch: () => "x" } }] };
	assert.equal(footerInternals(partial as unknown as TuiComponent), null, "a changed provider shape");
});

test("usage totals count every entry pi's footer counts, and the cache hit comes from the latest reply", () => {
	const totals = usageTotals([
		{ type: "message", message: { role: "assistant", usage: usage(100, 20, 0, 50, 0.01) } },
		{ type: "message", message: { role: "user" } },
		{ type: "message", message: { role: "toolResult", usage: usage(5, 5, 0, 0, 0.001) } },
		{ type: "usage", usage: usage(10, 1) },
		{ type: "compaction", usage: usage(7, 3) },
		{ type: "message", message: { role: "assistant", usage: usage(10, 30, 90, 0, 0.02) } },
	]);
	assert.deepEqual(
		{ ...totals, cost: Number(totals.cost.toFixed(3)) },
		{ input: 132, output: 59, cacheRead: 90, cacheWrite: 50, cost: 0.031, cacheHit: 90 },
	);
});

test("the frame is OMP's composer: context meter, the input line, then the bar", () => {
	const frame = frameNode(state({ usage: { input: 2, output: 584, cacheRead: 118000, cacheWrite: 2800, cost: 0.5, cacheHit: 97.7 } }), [EDITOR]);
	assert.deepEqual(frame.p, { role: "omp.editor" });
	assert.deepEqual(
		frame.c?.map((node) => [node.k, node.p?.role]),
		[
			["meter", "omp.composer.context"],
			["row", "omp.composer.line"],
			["row", "omp.composer.bar"],
		],
	);
	assert.deepEqual(frame.c?.[1].c, [EDITOR]);
	assert.deepEqual(
		frame.c?.[2].c?.map((node) => node.p?.role),
		["omp.composer.model", "omp.composer.effort", "omp.composer.extras", "omp.composer.usage", "omp.composer.send"],
	);
	const nodes = byId(frame);
	assert.equal(nodes.get(`${FRAME_ID}-model-name`)?.p?.text, "claude-opus-5-5");
	assert.equal(nodes.get(`${FRAME_ID}-effort-glyph`)?.p?.level, "medium");
	assert.equal(spanText(nodes.get(`${FRAME_ID}-branch`)), "main");
	assert.equal(nodes.has(`${FRAME_ID}-path`), false, "Tern draws the directory itself");
	assert.equal(spanText(nodes.get(`${FRAME_ID}-cache-read`)), "R118k");
	assert.equal(spanText(nodes.get(`${FRAME_ID}-cache-hit`)), "CH97.7%");
	assert.equal(nodes.get(`${FRAME_ID}-usage`)?.p?.text, "$0.500");
	assert.deepEqual(nodes.get(`${FRAME_ID}-context`)?.p, {
		role: "omp.composer.context",
		value: 0.125,
		style: "bar",
		thresholds: { warn: 0.7, bad: 0.9 },
		title: "Context 12.5% of 200k · auto-compact on",
		label: "13%",
		total: "200k",
	});
});

test("while a turn runs the frame is pending and Stop replaces send", () => {
	const frame = frameNode(state({ running: true }), [EDITOR]);
	assert.equal(frame.p?.tone, "pending");
	const bar = frame.c?.[2].c ?? [];
	assert.deepEqual(bar.at(-1)?.p, { role: "omp.composer.stop", text: "Stop", tone: "error", title: "Stop  Esc", actions: { click: "interrupt" } });
});

test("a model without reasoning has no effort chip, and unknown context reads ?", () => {
	const frame = frameNode(state({ model: { id: "plain", provider: "p" }, context: { percent: null, contextWindow: 1000 }, autoCompact: false }), [EDITOR]);
	const nodes = byId(frame);
	assert.equal(nodes.has(`${FRAME_ID}-effort`), false);
	assert.equal(nodes.get(`${FRAME_ID}-context`)?.p?.value, null);
	assert.equal(nodes.get(`${FRAME_ID}-context`)?.p?.title, "Context ? of 1.0k");
	assert.equal(nodes.has(`${FRAME_ID}-usage`), false, "no cost, no usage text");
});

test("extension statuses are one plain text line, sorted by key", () => {
	assert.deepEqual(statusesNode(new Map([["zz", "\x1b[32mlast\x1b[0m"], ["aa", "first\nline"]])), {
		id: STATUSES_ID,
		k: "text",
		p: { text: "first line last", wrap: "none", truncate: "end", role: "pi.footer.statuses" },
	});
	assert.equal(statusesNode(new Map()), null);
	assert.equal(plainStatus("  a\t b  "), "a b");
});

test("the working row is OMP's: spinner, whole seconds elapsed, the label, then Stop", () => {
	const row = workingRow(1000, 3500);
	assert.equal(row.p?.role, "omp.working");
	assert.deepEqual(
		row.c?.map((node) => node.k),
		["spinner", "elapsed", "text", "shimmer", "row", "row"],
	);
	assert.equal(row.c?.[1].p?.age, 2000);
	assert.deepEqual(row.c?.[5].p?.actions, { click: "interrupt" });
});

test("the home directory reads as ~", () => {
	assert.equal(formatCwd("/home/me/work", "/home/me"), "~/work");
	assert.equal(formatCwd("/home/me", "/home/me"), "~");
	assert.equal(formatCwd("/srv/work", "/home/me"), "/srv/work");
});

function fakePi(levels: string[] = ["off", "minimal", "low", "medium", "high"]) {
	type Handler = (event: unknown, ctx: unknown) => void;
	const handlers = new Map<string, Handler[]>();
	let level = "medium";
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getThinkingLevel: () => level,
		// pi clamps an unsupported level to the highest one the model has.
		setThinkingLevel: (next: string) => (level = levels.includes(next) ? next : levels.at(-1) ?? "off"),
	};
	const emit = (name: string, ctx: unknown) => {
		for (const handler of handlers.get(name) ?? []) handler({}, ctx);
	};
	return { pi: pi as unknown as ExtensionAPI, emit, level: () => level };
}

function fakeCtx(aborted: string[] = []) {
	return {
		hasUI: true,
		sessionManager: {
			getCwd: () => "/tmp/work",
			getSessionName: () => undefined,
			getEntries: () => [{ type: "message", message: { role: "assistant", usage: usage(1200, 34) } }],
		},
		model: { id: "m1", provider: "p1", reasoning: true, contextWindow: 1000 },
		getContextUsage: () => ({ percent: 3.4, contextWindow: 1000 }),
		abort: () => aborted.push("abort"),
	};
}

function fakeHost(logs: string[] = []): SurfaceHost {
	return { tui: () => null, invalidate() {}, log: (message) => logs.push(message), blob: () => undefined };
}

test("the frame waits for the session, and a custom footer keeps its rows with one log", () => {
	const { pi, emit } = fakePi();
	const logs: string[] = [];
	const frame = createFrame(pi, fakeHost(logs), () => {});
	assert.deepEqual(frame.describe([EDITOR], builtInFooter(), false), { nodes: [EDITOR], footerRows: true }, "no session context yet");
	emit("session_start", fakeCtx());
	const framed = frame.describe([EDITOR], builtInFooter({ ext: "busy" }), false);
	assert.deepEqual(framed.nodes.map((node) => node.id), [FRAME_ID, STATUSES_ID]);
	assert.equal(framed.footerRows, false);
	const custom: TuiComponent = { render: () => ["mine"], children: [{ render: () => ["mine"] }] };
	assert.equal(frame.describe([EDITOR], custom, false).footerRows, true);
	frame.describe([EDITOR], custom, false);
	assert.equal(logs.length, 1);
	assert.deepEqual(frame.describe([], builtInFooter(), false), { nodes: [], footerRows: true }, "a dialog holds the slot");
});

test("clicks on send, Stop and the effort chip reach pi", () => {
	const { pi, emit, level } = fakePi();
	const aborted: string[] = [];
	let sent = 0;
	const frame = createFrame(pi, fakeHost(), () => (sent += 1));
	emit("session_start", fakeCtx(aborted));
	assert.equal(frame.onEvent({ ev: "action", id: `${FRAME_ID}-send`, act: "submit" }), true);
	assert.equal(sent, 1);
	assert.equal(frame.onEvent({ ev: "action", id: `${WORKING_ID}-stop`, act: "interrupt" }), true);
	assert.deepEqual(aborted, ["abort"]);
	frame.onEvent({ ev: "action", id: `${FRAME_ID}-effort`, act: "thinking.cycle" });
	assert.equal(level(), "high");
	frame.onEvent({ ev: "action", id: `${FRAME_ID}-effort`, act: "thinking.cycle" });
	assert.equal(level(), "off", "past the model's highest level the cycle wraps");
	assert.equal(frame.onEvent({ ev: "action", id: "xt1", act: "submit" }), false, "another area's node");
	assert.equal(frame.onEvent({ ev: "toggle", id: `${FRAME_ID}-send` }), false);
});

test("in the dock, the composer is framed and the built-in footer gets no rows", () => {
	const rows = (...lines: string[]): TuiComponent => ({ render: () => lines });
	const box = (...children: TuiComponent[]): TuiComponent => ({ render: () => children.flatMap((child) => child.render(80)), children });
	const dockWith = (footerSlot: TuiComponent) => {
		const tui = box(rows(), rows(), rows(), rows(), box(rows("editor")), rows(), footerSlot);
		const { pi, emit } = fakePi();
		const dock = createDock(pi, { ...fakeHost(), tui: () => tui });
		emit("session_start", fakeCtx());
		return dock.describe(80, [EDITOR]).map((node) => [node.id, node.k]);
	};
	assert.deepEqual(dockWith(builtInFooter()), [[FRAME_ID, "col"]]);
	assert.deepEqual(dockWith(box(rows("custom footer"))), [[FRAME_ID, "col"], ["kf", "rows"]]);
});
