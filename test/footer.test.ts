/**
 * The native footer: pi's footer data read by shape, the usage totals and the `status` bar nodes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createDock } from "../lib/surface/dock.ts";
import {
	createFooter,
	FOOTER_ID,
	type FooterState,
	footerInternals,
	footerNodes,
	formatCwd,
	plainStatus,
	STATUSES_ID,
	usageTotals,
} from "../lib/surface/footer.ts";
import type { SemanticNode, SurfaceHost, TuiComponent } from "../lib/surface/host.ts";

function footerData(statuses: Record<string, string> = {}, providers = 1) {
	return {
		getGitBranch: () => "main",
		getExtensionStatuses: () => new Map(Object.entries(statuses)),
		getAvailableProviderCount: () => providers,
	};
}

/** pi's footer container holding its built-in `FooterComponent`. */
function builtInFooter(statuses: Record<string, string> = {}, providers = 1): TuiComponent {
	const footer = { footerData: footerData(statuses, providers), autoCompactEnabled: true, render: () => ["~/work (main)", "stats"] };
	return { render: () => footer.render(), children: [footer] };
}

function usage(input: number, output: number, cacheRead = 0, cacheWrite = 0, cost = 0) {
	return { input, output, cacheRead, cacheWrite, cost: { total: cost } };
}

function state(overrides: Partial<FooterState> = {}): FooterState {
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
		statuses: new Map(),
		...overrides,
	};
}

function segText(nodes: SemanticNode[], key: string): string | undefined {
	const seg = nodes[0].c?.find((node) => node.id === `${FOOTER_ID}-${key}`);
	return (seg?.p?.spans as { t: string }[] | undefined)?.map((span) => span.t).join("");
}

test("the built-in footer's data is read by shape, and a custom footer gives null", () => {
	assert.ok(footerInternals(builtInFooter()));
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

test("the bar has path, usage, context and model segments with pi's numbers", () => {
	const nodes = footerNodes(
		state({ sessionName: "fix", usage: { input: 2, output: 584, cacheRead: 118000, cacheWrite: 2800, cost: 0, cacheHit: 97.7 } }),
	);
	assert.equal(nodes.length, 1);
	assert.equal(nodes[0].k, "status");
	assert.deepEqual(
		nodes[0].c?.map((node) => [node.id, node.p?.side]),
		[
			["kf-path", "left"],
			["kf-input", "left"],
			["kf-output", "left"],
			["kf-cache-read", "left"],
			["kf-cache-write", "left"],
			["kf-cache-hit", "left"],
			["kf-context", "left"],
			["kf-model", "right"],
		],
	);
	assert.equal(segText(nodes, "path"), "~/work (main) • fix");
	assert.equal(segText(nodes, "cache-read"), "R118k");
	assert.equal(segText(nodes, "cache-hit"), "CH97.7%");
	assert.equal(segText(nodes, "context"), "12.5%/200k (auto)");
	assert.equal(segText(nodes, "model"), "claude-opus-5-5 • medium");
});

test("context turns warning above 70% and error above 90%, and unknown usage reads ?", () => {
	const tone = (percent: number | null) => footerNodes(state({ context: { percent, contextWindow: 1000000 } }))[0].c?.find((n) => n.id === "kf-context")?.p?.tone;
	assert.equal(tone(70), undefined);
	assert.equal(tone(71), "warning");
	assert.equal(tone(91), "error");
	assert.equal(segText(footerNodes(state({ context: { percent: null, contextWindow: 1000000 }, autoCompact: false })), "context"), "?/1.0M");
});

test("the provider is its own droppable segment with several providers, and a reasoning model at off says so", () => {
	const several = footerNodes(state({ providerCount: 2 }));
	assert.equal(segText(several, "provider"), "(claude-bridge)");
	assert.equal(segText(several, "model"), "claude-opus-5-5 • medium");
	assert.equal(segText(footerNodes(state()), "provider"), undefined);
	const priority = (key: string) => several[0].c?.find((n) => n.id === `kf-${key}`)?.p?.priority as number;
	assert.ok(priority("provider") < priority("model") && priority("model") < priority("path") && priority("path") < priority("context"));
	assert.equal(segText(footerNodes(state({ thinkingLevel: "off" })), "model"), "claude-opus-5-5 • thinking off");
	assert.equal(segText(footerNodes(state({ model: { id: "plain", provider: "p" } })), "model"), "plain");
	assert.equal(segText(footerNodes(state({ usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.1234 } })), "cost"), "$0.123");
});

test("extension statuses are one plain text line, sorted by key", () => {
	const nodes = footerNodes(state({ statuses: new Map([["zz", "\x1b[32mlast\x1b[0m"], ["aa", "first\nline"]]) }));
	assert.deepEqual(nodes[1], {
		id: STATUSES_ID,
		k: "text",
		p: { text: "first line last", wrap: "none", truncate: "end", role: "pi.footer.statuses" },
	});
	assert.equal(plainStatus("  a\t b  "), "a b");
});

test("the home directory reads as ~", () => {
	assert.equal(formatCwd("/home/me/work", "/home/me"), "~/work");
	assert.equal(formatCwd("/home/me", "/home/me"), "~");
	assert.equal(formatCwd("/srv/work", "/home/me"), "/srv/work");
});

function fakePi(thinkingLevel = "medium") {
	type Handler = (event: unknown, ctx: unknown) => void;
	const handlers = new Map<string, Handler[]>();
	const pi = {
		on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
		getThinkingLevel: () => thinkingLevel,
	};
	const emit = (name: string, ctx: unknown) => {
		for (const handler of handlers.get(name) ?? []) handler({}, ctx);
	};
	return { pi: pi as unknown as ExtensionAPI, emit };
}

function fakeCtx() {
	return {
		sessionManager: {
			getCwd: () => "/tmp/work",
			getSessionName: () => undefined,
			getEntries: () => [{ type: "message", message: { role: "assistant", usage: usage(1200, 34) } }],
		},
		model: { id: "m1", provider: "p1", reasoning: false, contextWindow: 1000 },
		getContextUsage: () => ({ percent: 3.4, contextWindow: 1000 }),
	};
}

function fakeHost(logs: string[] = []): SurfaceHost {
	return { tui: () => null, invalidate() {}, log: (message) => logs.push(message), blob: () => undefined };
}

test("the footer is native once the session starts, and a custom footer stays rows with one log", () => {
	const { pi, emit } = fakePi();
	const logs: string[] = [];
	const footer = createFooter(pi, fakeHost(logs));
	assert.equal(footer.describe(builtInFooter()), null, "no session context yet");
	emit("session_start", fakeCtx());
	const nodes = footer.describe(builtInFooter({ ext: "busy" }));
	assert.deepEqual(nodes?.map((node) => [node.id, node.k]), [["kf", "status"], ["kfx", "text"]]);
	assert.equal(segText(nodes ?? [], "input"), "↑1.2k");
	assert.equal(segText(nodes ?? [], "context"), "3.4%/1.0k (auto)");
	const custom: TuiComponent = { render: () => ["mine"], children: [{ render: () => ["mine"] }] };
	assert.equal(footer.describe(custom), null);
	assert.equal(footer.describe(custom), null);
	assert.equal(logs.length, 1);
});

test("in the dock, the built-in footer is a status bar and a custom footer is rows", () => {
	const rows = (...lines: string[]): TuiComponent => ({ render: () => lines });
	const box = (...children: TuiComponent[]): TuiComponent => ({ render: () => children.flatMap((child) => child.render(80)), children });
	const dockWith = (footerSlot: TuiComponent) => {
		const tui = box(rows(), rows(), rows(), rows(), box(rows("editor")), rows(), footerSlot);
		const { pi, emit } = fakePi();
		const dock = createDock(pi, { ...fakeHost(), tui: () => tui });
		emit("session_start", fakeCtx());
		return dock.describe(80, [{ id: "ke", k: "editor", p: {} }]).map((node) => [node.id, node.k]);
	};
	assert.deepEqual(dockWith(builtInFooter()), [["ke", "editor"], ["kf", "status"]]);
	assert.deepEqual(dockWith(box(rows("custom footer"))), [["ke", "editor"], ["kf", "rows"]]);
});
