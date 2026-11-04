/**
 * The transcript area in lib/surface/transcript.ts: items from the session branch and live events,
 * and the chatContainer walk for notices and extension renderer rows.
 *
 * pi's components are faked by class name, because the walk reads only `children`, class names and
 * `render()`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticNode, SurfaceHost, TuiComponent } from "../lib/surface/host.ts";
import {
	buildTranscriptItems,
	createTranscript,
	NO_CONTEXT,
	walkChat,
	type MessageLike,
	type SessionEntryLike,
	type TranscriptItem,
} from "../lib/surface/transcript.ts";
import type { FrameOp } from "../native/native.d.mts";
import { diffChildren } from "../native/tree-diff.mjs";

let entrySeq = 0;
const entry = (message: MessageLike): SessionEntryLike => ({ type: "message", id: `e${(entrySeq += 1)}`, message });
const user = (text: string, timestamp: number): SessionEntryLike => entry({ role: "user", content: [{ type: "text", text }], timestamp });
const toolCall = (id: string, name: string, args: Record<string, unknown>) => ({ type: "toolCall", id, name, arguments: args });
const assistant = (timestamp: number, ...content: MessageLike["content"] & unknown[]): SessionEntryLike =>
	entry({ role: "assistant", content, timestamp, stopReason: "stop" });
const toolResult = (toolCallId: string, text: string, extra: Partial<MessageLike> = {}): SessionEntryLike =>
	entry({ role: "toolResult", toolCallId, content: [{ type: "text", text }], timestamp: 0, ...extra });

/** A fake pi component: its class name is what the walk matches on. */
function component(name: string, lines: string[] = [], children?: TuiComponent[]): TuiComponent {
	const Named = { [name]: class {} }[name];
	return Object.assign(new Named(), { render: () => lines, ...(children ? { children } : {}) });
}

const ids = (items: TranscriptItem[]) => items.map((item) => item.id);
const nodeOf = (items: TranscriptItem[], id: string) => items.find((item) => item.id === id)?.nodes[0];

test("saved messages become a user card, an assistant column, and one card per tool call after it", () => {
	const branch = [
		user("hello", 1),
		assistant(2, { type: "thinking", thinking: "hmm" }, { type: "text", text: "sure" }, toolCall("c1", "read", { path: "a.ts" })),
		toolResult("c1", "file text"),
	];
	const items = buildTranscriptItems(branch);
	assert.deepEqual(ids(items), ["xuser-1", "xassistant-2", "xtc1"]);
	assert.deepEqual(items.map((item) => item.component), ["UserMessageComponent", "AssistantMessageComponent", "ToolExecutionComponent"]);
	assert.deepEqual(nodeOf(items, "xuser-1"), {
		id: "xuser-1",
		k: "card",
		p: { head: "You", variant: "bare", role: "pi.user" },
		c: [{ id: "xuser-1m", k: "md", p: { text: "hello" } }],
	});
	const reply = nodeOf(items, "xassistant-2");
	assert.equal(reply?.k, "col");
	assert.deepEqual(reply?.c?.map((node) => [node.k, node.p?.head ?? node.p?.text]), [["card", "Thinking"], ["md", "sure"]]);
	assert.equal(reply?.c?.[0].p?.collapsed, true, "thinking starts collapsed");
	const card = nodeOf(items, "xtc1");
	assert.deepEqual(card?.p, { head: "read a.ts", status: "done", preview: { lines: 12 }, collapsible: true, collapsed: true });
	assert.deepEqual(card?.c, [{ id: "xtc1-o", k: "ansi", p: { text: "file text" } }]);
});

test("edit shows the saved patch as a diff and write shows its content as code", () => {
	const branch = [
		assistant(1, toolCall("e1", "edit", { path: "a.txt" }), toolCall("w1", "write", { path: "b.txt", content: "hi\n" })),
		toolResult("e1", "Successfully replaced 1 block(s) in a.txt.", { details: { patch: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hi\n+hello\n" } }),
		toolResult("w1", "Wrote b.txt"),
	];
	const items = buildTranscriptItems(branch);
	assert.deepEqual(nodeOf(items, "xte1")?.c, [{ id: "xte1-d", k: "diff", p: { text: "--- a.txt\n+++ a.txt\n@@ -1 +1 @@\n-hi\n+hello\n", path: "a.txt", mode: "unified" } }]);
	assert.deepEqual(nodeOf(items, "xtw1")?.c, [{ id: "xtw1-c", k: "code", p: { text: "hi\n", path: "b.txt", numbers: true } }]);
});

test("tool result images become image nodes that name the blob the host sent", () => {
	const branch = [
		assistant(1, toolCall("r1", "read", { path: "dot.png" })),
		entry({ role: "toolResult", toolCallId: "r1", timestamp: 0, content: [{ type: "text", text: "Read image file" }, { type: "image", data: "AAAA", mimeType: "image/png" }] }),
	];
	const sent: string[] = [];
	const items = buildTranscriptItems(branch, undefined, { ...NO_CONTEXT, blob: (data, mime) => (sent.push(`${mime}:${data}`), "sha-1") });
	assert.deepEqual(sent, ["image/png:AAAA"]);
	assert.deepEqual(nodeOf(items, "xtr1")?.c?.[1], { id: "xtr1-i0", k: "image", p: { blob: "sha-1", alt: "tool result image" } });
	assert.equal(nodeOf(buildTranscriptItems(branch), "xtr1")?.c?.length, 1, "no blob, no image node");
});

test("a tool call without a result is pending, or failed when its reply was aborted", () => {
	const pending = buildTranscriptItems([assistant(1, toolCall("p1", "bash", { command: "ls -la\nmore" }))]);
	assert.deepEqual([nodeOf(pending, "xtp1")?.p?.head, nodeOf(pending, "xtp1")?.p?.status], ["bash ls -la", "pending"]);
	const aborted = buildTranscriptItems([entry({ role: "assistant", content: [toolCall("p2", "bash", { command: "sleep 9" })], timestamp: 2, stopReason: "aborted" })]);
	assert.equal(nodeOf(aborted, "xtp2")?.p?.status, "error");
	assert.deepEqual(nodeOf(aborted, "xtp2")?.c, [{ id: "xtp2-o", k: "ansi", p: { text: "Operation aborted" } }]);
	const reply = nodeOf(aborted, "xassistant-2");
	assert.deepEqual(reply?.c?.at(-1), {
		id: "xassistant-2err",
		k: "row",
		p: { gap: "sm", align: "baseline" },
		c: [
			{ id: "xassistant-2errb", k: "badge", p: { text: "Aborted", tone: "warning" } },
			{ id: "xassistant-2errm", k: "md", p: { text: "Operation aborted", tone: "warning" } },
		],
	});
});

test("an aborted reply shows pi's own reason when it has one, and a failed reply its error", () => {
	const marker = (message: Partial<MessageLike>) =>
		buildTranscriptItems([entry({ role: "assistant", content: [{ type: "text", text: "a" }], timestamp: 3, ...message })])[0].nodes[0].c?.at(-1);
	assert.equal(marker({ stopReason: "aborted", errorMessage: "Request was aborted" })?.c?.[1].p?.text, "Operation aborted");
	assert.equal(marker({ stopReason: "aborted", errorMessage: "Stopped by the hook" })?.c?.[1].p?.text, "Stopped by the hook");
	assert.deepEqual(
		marker({ stopReason: "error", errorMessage: "overloaded" })?.c?.map((node) => node.p),
		[{ text: "Error", tone: "error" }, { text: "overloaded", tone: "error" }],
	);
});

test("! output is a card with the command as head and the output as ansi", () => {
	const items = buildTranscriptItems([entry({ role: "bashExecution", command: "echo hi", output: "hi\n", exitCode: 0, cancelled: false, timestamp: 5 })]);
	assert.deepEqual(items[0].component, "BashExecutionComponent");
	assert.deepEqual(items[0].nodes, [
		{
			id: "xbashExecution-5",
			k: "card",
			p: { head: "$ echo hi", status: "done", preview: { lines: 12 }, role: "pi.bash", collapsible: true, collapsed: true },
			c: [{ id: "xbashExecution-5o", k: "ansi", p: { text: "hi\n" } }],
		},
	]);
	const failed = buildTranscriptItems([entry({ role: "bashExecution", command: "false", output: "", exitCode: 1, cancelled: false, timestamp: 6 })]);
	assert.equal(failed[0].nodes[0].p?.status, "error");
});

test("custom messages are md, custom entries wait for their renderer rows, and hidden messages are skipped", () => {
	const branch: SessionEntryLike[] = [
		{ type: "custom_message", id: "m1", customType: "note", content: "**hi**", display: true },
		{ type: "custom_message", id: "m2", customType: "note", content: "secret", display: false },
		{ type: "custom", id: "c1", customType: "state" },
		{ type: "model_change", id: "mc" },
	];
	const items = buildTranscriptItems(branch);
	assert.deepEqual(
		items.map((item) => [item.id, item.component, item.nodes.map((node) => node.k)]),
		[
			["xm1", "CustomMessageComponent", ["md"]],
			["xc1", "CustomEntryComponent", []],
		],
	);
	assert.equal(items[0].nodes[0].p?.text, "**hi**");
});

test("compaction and branch summaries are collapsed cards from their saved entries", () => {
	const branch: SessionEntryLike[] = [
		{ type: "compaction", id: "k1", summary: "## Goal\nship it", tokensBefore: 244853 },
		{ type: "branch_summary", id: "b1", summary: "tried a thing" },
	];
	const items = buildTranscriptItems(branch);
	assert.deepEqual(
		items.map((item) => [item.component, item.nodes[0].p?.head, item.nodes[0].p?.collapsed, item.nodes[0].c?.[0].p?.text]),
		[
			["CompactionSummaryMessageComponent", "Compacted from 244,853 tokens", true, "## Goal\nship it"],
			["BranchSummaryMessageComponent", "Branch summary", true, "tried a thing"],
		],
	);
});

test("a skill invocation is a collapsed skill card, then the user's own text", () => {
	const text = '<skill name="tdd" location="/s/tdd/SKILL.md">\nred green\n</skill>\n\nfix the bug';
	const items = buildTranscriptItems([user(text, 3)]);
	assert.deepEqual(
		items.map((item) => [item.id, item.component, item.nodes[0].p?.head]),
		[
			["xuser-3s", "SkillInvocationMessageComponent", "Skill tdd"],
			["xuser-3", "UserMessageComponent", "You"],
		],
	);
	assert.equal(items[1].nodes[0].c?.[0].p?.text, "fix the bug");
});

test("a live message keeps its node ids once pi saves it, and is not shown twice", () => {
	const live = { role: "assistant", content: [{ type: "text", text: "partial" }], timestamp: 9 };
	const streaming = buildTranscriptItems([user("q", 8)], { messages: [live], streaming: new Set(["assistant-9"]), tools: new Map() });
	assert.deepEqual(ids(streaming), ["xuser-8", "xassistant-9"]);
	assert.equal(streaming[1].nodes[0].c?.[0].p?.stream, true, "the streaming text block says so");
	const saved = buildTranscriptItems([user("q", 8), entry({ ...live, content: [{ type: "text", text: "done" }] })], {
		messages: [live],
		streaming: new Set(),
		tools: new Map(),
	});
	assert.deepEqual(ids(saved), ["xuser-8", "xassistant-9"]);
	assert.equal(saved[1].nodes[0].c?.[0].p?.text, "done", "the saved copy wins");
});

test("a running tool shows its partial output until the result is saved", () => {
	const branch = [assistant(1, toolCall("t1", "bash", { command: "make" }))];
	const tools = new Map([["t1", { status: "running" as const, partial: { content: [{ type: "text", text: "building" }] } }]]);
	const items = buildTranscriptItems(branch, { messages: [], streaming: new Set(), tools });
	assert.equal(nodeOf(items, "xtt1")?.p?.status, "running");
	assert.equal(nodeOf(items, "xtt1")?.c?.[0].p?.text, "building");
});

test("a tool describer replaces the default card content, with its body ids prefixed by the card id", () => {
	const branch = [assistant(1, toolCall("s1", "subagent", { task: "look" })), toolResult("s1", "found")];
	const seen: unknown[] = [];
	const items = buildTranscriptItems(branch, undefined, {
		...NO_CONTEXT,
		describers: {
			tool: (name, input) => {
				seen.push([name, input.status, input.argsComplete, input.expanded]);
				return name === "subagent" ? { head: "Subagent", body: [{ id: "n", k: "md", p: { text: "ran" } }] } : undefined;
			},
		},
	});
	assert.deepEqual(seen, [["subagent", "done", true, false]]);
	assert.deepEqual([nodeOf(items, "xts1")?.p?.head, nodeOf(items, "xts1")?.c], ["Subagent", [{ id: "xts1-n", k: "md", p: { text: "ran" } }]]);
	const fallback = buildTranscriptItems(branch, undefined, { ...NO_CONTEXT, describers: { tool: () => undefined } });
	assert.deepEqual(nodeOf(fallback, "xts1")?.p?.head, "subagent look", "no describer: the generic card");
});

// The chatContainer walk.

test("notices follow the item before them: ThemedText as md, with a badge for errors and warnings, anything else as rows", () => {
	const items = buildTranscriptItems([user("q", 1), assistant(2, { type: "text", text: "a" })]);
	const chat = component("Container", [], [
		component("DynamicBorder", ["\x1b[33m────\x1b[0m"]),
		component("ThemedText", [" \x1b[2mPackage Updates\x1b[0m  "]),
		component("UserMessageComponent"),
		component("Spacer", [""]),
		component("AssistantMessageComponent"),
		component("Spacer", [""]),
		component("ThemedText", ["\x1b[31mError: Compaction failed\x1b[0m"]),
		component("ThemedText", ["Session compacted 1 time"]),
	]);
	const walk = walkChat(chat, items, 80, () => {});
	assert.deepEqual(walk.notices.get(""), [
		{ id: "xn-0", k: "rows", p: { cols: 80, lines: ["\x1b[33m────\x1b[0m"] } },
		{ id: "xn-1", k: "md", p: { text: "Package Updates", role: "pi.notice" } },
	]);
	assert.deepEqual(walk.notices.get("xassistant-2"), [
		{
			id: "xnxassistant-2-0",
			k: "row",
			p: { gap: "sm", align: "baseline", role: "pi.notice" },
			c: [
				{ id: "xnxassistant-2-0b", k: "badge", p: { text: "Error", tone: "error" } },
				{ id: "xnxassistant-2-0m", k: "md", p: { text: "Compaction failed", tone: "error" } },
			],
		},
		{ id: "xnxassistant-2-1", k: "md", p: { text: "Session compacted 1 time", role: "pi.notice" } },
	]);
	assert.equal(walk.notices.has("xuser-1"), false);
});

test("a notice anchors by counting from the end, so older branch items than pi shows do not shift it", () => {
	const items = buildTranscriptItems([user("old", 1), user("kept", 2), user("new", 3)]);
	// After a compaction pi's container holds only the newer items.
	const chat = component("Container", [], [component("UserMessageComponent"), component("ThemedText", ["Warning: careful"]), component("UserMessageComponent")]);
	const walk = walkChat(chat, items, 80, () => {});
	assert.deepEqual([...walk.notices.keys()], ["xuser-2"]);
});

test("renderer rows replace the default for custom entries and rendered custom messages, matched by order", () => {
	const items = buildTranscriptItems([
		{ type: "custom", id: "c1", customType: "card" },
		{ type: "custom_message", id: "m1", customType: "plain", content: "plain text", display: true },
		{ type: "custom_message", id: "m2", customType: "rendered", content: "x", display: true },
	]);
	const defaultBox = component("Box", [], [component("Text"), component("Spacer"), component("Markdown")]);
	const chat = component("Container", [], [
		component("CustomEntryComponent", ["", "[card renderer]"], [component("Spacer"), component("Text")]),
		component("CustomMessageComponent", ["", "[plain]", "plain text"], [component("Spacer"), defaultBox]),
		component("CustomMessageComponent", ["", "[rendered renderer]"], [component("Spacer"), component("Text")]),
	]);
	const walk = walkChat(chat, items, 80, () => {});
	assert.deepEqual(walk.rows.get("xc1"), [{ id: "xc1r", k: "rows", p: { cols: 80, lines: ["[card renderer]"] } }]);
	assert.equal(walk.rows.has("xm1"), false, "pi's own default rendering keeps the md");
	assert.deepEqual(walk.rows.get("xm2"), [{ id: "xm2r", k: "rows", p: { cols: 80, lines: ["[rendered renderer]"] } }]);
	assert.equal(walk.notices.size, 0);
});

test("when a class's component count differs from its saved items, no renderer rows are shown for it and it is logged", () => {
	// Two saved custom entries, but only one had a renderer, so pi drew one component.
	const items = buildTranscriptItems([
		{ type: "custom", id: "c1", customType: "state" },
		{ type: "custom", id: "c2", customType: "card" },
	]);
	const chat = component("Container", [], [component("CustomEntryComponent", ["[card renderer]"])]);
	const logs: string[] = [];
	const walk = walkChat(chat, items, 80, (message) => logs.push(message));
	assert.equal(walk.rows.size, 0);
	assert.deepEqual(logs, ["CustomEntryComponent count differs from the saved items, so their renderer rows are not shown"]);
});

test("a chatContainer without children throws, so the caller can log it", () => {
	assert.throws(() => walkChat(component("Container"), [], 80, () => {}), /no children/);
});

// The area.

function fakePi() {
	type Handler = (event: unknown, ctx: unknown) => void;
	const handlers = new Map<string, Handler[]>();
	const pi = { on: (name: string, handler: Handler) => handlers.set(name, [...(handlers.get(name) ?? []), handler]) };
	const emit = (name: string, event: unknown, ctx: unknown = {}) => {
		for (const handler of handlers.get(name) ?? []) handler(event, ctx);
	};
	return { pi: pi as unknown as ExtensionAPI, emit };
}

function fakeHost(chat: TuiComponent | undefined, logs: string[] = []): SurfaceHost {
	const document = component("Container", [], chat ? [component("Container"), component("Container"), chat] : []);
	const tui = component("TUI", [], [document]);
	return { tui: () => tui, invalidate() {}, log: (message) => logs.push(message), blob: () => undefined };
}

test("the area reads the branch on every describe, so saved items with no event still appear", () => {
	const { pi, emit } = fakePi();
	const branch: SessionEntryLike[] = [user("q", 1)];
	const transcript = createTranscript(pi, fakeHost(component("Container", [], [])));
	emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
	assert.deepEqual(transcript.describe(80).map((node) => node.id), ["xuser-1"]);
	branch.push({ type: "custom_message", id: "m1", customType: "note", content: "appended", display: true });
	assert.deepEqual(transcript.describe(80).map((node) => node.id), ["xuser-1", "xm1"]);
});

test("the area shows a streaming reply from events until pi saves it", () => {
	const { pi, emit } = fakePi();
	const branch: SessionEntryLike[] = [user("q", 1)];
	const transcript = createTranscript(pi, fakeHost(component("Container", [], [])));
	emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
	const message = { role: "assistant", content: [{ type: "text", text: "par" }], timestamp: 2 };
	emit("message_start", { message });
	emit("message_update", { message: { ...message, content: [{ type: "text", text: "partial" }] } });
	const live = transcript.describe(80);
	assert.deepEqual(live.map((node) => node.id), ["xuser-1", "xassistant-2"]);
	assert.deepEqual(live[1].c?.[0].p, { text: "partial", stream: true });
	emit("message_end", { message: { ...message, content: [{ type: "text", text: "partial done" }] } });
	branch.push(entry({ ...message, content: [{ type: "text", text: "partial done" }] }));
	const saved = transcript.describe(80);
	assert.deepEqual(saved.map((node) => node.id), ["xuser-1", "xassistant-2"]);
	assert.deepEqual(saved[1].c?.[0].p, { text: "partial done", stream: false });
});

test("an interrupted streaming reply keeps its nodes, stops streaming and gains the aborted marker", () => {
	const { pi, emit } = fakePi();
	const branch: SessionEntryLike[] = [user("q", 1)];
	const transcript = createTranscript(pi, fakeHost(component("Container", [], [])));
	emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
	const message = { role: "assistant", content: [{ type: "text", text: "1. one\n2. tw" }], timestamp: 2 };
	emit("message_start", { message });
	emit("message_update", { message });
	const streaming = transcript.describe(80);
	const aborted = { ...message, stopReason: "aborted", errorMessage: "Request was aborted" };
	emit("message_end", { message: aborted });
	branch.push(entry(aborted));
	const ops: FrameOp[] = [];
	diffChildren("main", streaming, transcript.describe(80), ops);
	assert.deepEqual(ops, [
		["set", "xassistant-2b0", { stream: false }],
		[
			"add",
			"xassistant-2err",
			"xassistant-2",
			null,
			{
				id: "xassistant-2err",
				k: "row",
				p: { gap: "sm", align: "baseline" },
				c: [
					{ id: "xassistant-2errb", k: "badge", p: { text: "Aborted", tone: "warning" } },
					{ id: "xassistant-2errm", k: "md", p: { text: "Operation aborted", tone: "warning" } },
				],
			},
		],
	]);
});

test("a toggle on a transcript card is consumed and kept across repaints", () => {
	const { pi, emit } = fakePi();
	const transcript = createTranscript(pi, fakeHost(component("Container", [], [])));
	emit("session_start", {}, { sessionManager: { getBranch: () => [assistant(1, toolCall("t1", "ls", {}))] } });
	assert.equal(transcript.onEvent({ ev: "toggle", id: "xtt1", collapsed: false }), true);
	assert.equal(transcript.describe(80).find((node) => node.id === "xtt1")?.p?.collapsed, false);
	assert.equal(transcript.onEvent({ ev: "toggle", id: "ke", collapsed: true }), false, "dock ids are not the transcript's");
});

test("when pi's structure changes, the walk is logged once and the transcript still shows", () => {
	const { pi, emit } = fakePi();
	const logs: string[] = [];
	const transcript = createTranscript(pi, fakeHost(undefined, logs));
	emit("session_start", {}, { sessionManager: { getBranch: () => [user("q", 1)] } });
	transcript.describe(80);
	assert.deepEqual(transcript.describe(80).map((node) => node.id), ["xuser-1"]);
	assert.deepEqual(logs, ["transcript: the chatContainer walk failed, so notices are not shown: chatContainer has no children array"]);
});

test("a repaint of a long session stays cheap: build plus tree diff for 600 entries", () => {
	const branch: SessionEntryLike[] = [];
	for (let turn = 0; turn < 150; turn += 1) {
		branch.push(user(`question ${turn}`, turn * 10));
		branch.push(assistant(turn * 10 + 1, { type: "thinking", thinking: "thinking ".repeat(40) }, { type: "text", text: "answer ".repeat(80) }, toolCall(`c${turn}`, "read", { path: `f${turn}.ts` })));
		branch.push(toolResult(`c${turn}`, "line\n".repeat(200)));
		branch.push(entry({ role: "bashExecution", command: "ls", output: "a\nb\n", exitCode: 0, timestamp: turn * 10 + 2 }));
	}
	const { pi, emit } = fakePi();
	const transcript = createTranscript(pi, fakeHost(component("Container", [], [])));
	emit("session_start", {}, { sessionManager: { getBranch: () => branch } });
	let previous: SemanticNode[] = transcript.describe(80);
	const runs = 20;
	const started = performance.now();
	for (let run = 0; run < runs; run += 1) {
		const next = transcript.describe(80);
		diffChildren("main", previous, next, []);
		previous = next;
	}
	const perRepaint = (performance.now() - started) / runs;
	assert.equal(previous.length, 600);
	// The sink repaints at most every 100 ms. Print the measured cost for the #13 scrolling work.
	console.log(`transcript repaint, 600 entries: ${perRepaint.toFixed(1)} ms`);
	assert.ok(perRepaint < 100, `a repaint took ${perRepaint.toFixed(1)} ms`);
});
