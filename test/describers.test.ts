/**
 * The describer registry and the built-in pi-subagents describer (lib/surface/describers.ts and
 * lib/surface/subagents.ts), as issue 6 and ADR 0003 define them.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	checkToolDescription,
	connectDescribers,
	createDescriberRegistry,
	helloKinds,
	parseRegistration,
	SLOW_DESCRIBE_MS,
	type DescriberRegistry,
} from "../lib/surface/describers.ts";
import type { SemanticNode, SurfaceHost } from "../lib/surface/host.ts";
import { describeSubagent, subagentHead } from "../lib/surface/subagents.ts";
import { buildTranscriptItems, NO_CONTEXT, type SessionEntryLike, type ToolDescribeInput } from "../lib/surface/transcript.ts";

const KINDS = ["card", "md", "ansi", "agent", "row", "col", "badge"];

function input(overrides: Partial<ToolDescribeInput> = {}): ToolDescribeInput {
	return { toolCallId: "c1", args: { agent: "scout", task: "look" }, argsComplete: true, status: "done", expanded: false, ...overrides };
}

const body = (text: string): SemanticNode[] => [{ id: "n", k: "md", p: { text } }];

function registry(logs: string[] = [], now?: () => number): DescriberRegistry {
	return createDescriberRegistry({ kinds: KINDS, log: (message) => logs.push(message), now });
}

test("a registration needs a known kind and a key, and a missing source counts as author", () => {
	assert.deepEqual(parseRegistration({ kind: "tool", key: "x", describe: null }), { kind: "tool", key: "x", source: "author", describe: null });
	assert.match(String(parseRegistration({ kind: "widgets", key: "x", describe: null })), /kind must be/);
	assert.match(String(parseRegistration({ kind: "tool", key: "", describe: null })), /key/);
	assert.match(String(parseRegistration({ kind: "tool", key: "x", source: "me", describe: null })), /source/);
	assert.match(String(parseRegistration({ kind: "tool", key: "x" })), /describe must be/);
	assert.match(String(parseRegistration({ kind: "tool", key: "x", describe: () => ({}), onEvent: 1 })), /onEvent/);

	const logs: string[] = [];
	const describers = registry(logs);
	assert.equal(describers.register({ kind: "tool", key: "x" }), false);
	assert.deepEqual(describers.report().problems, [{ kind: "tool", key: "x", first: "registration refused: describe must be a function or null", count: 1 }]);
	assert.equal(logs.length, 1);
});

test("local beats author beats builtin, and within one source the latest registration wins", () => {
	const describers = registry();
	const named = (name: string) => () => ({ head: name, body: [] });
	describers.register({ kind: "tool", key: "t", source: "builtin", describe: named("builtin") });
	assert.equal(describers.tool("t", input(), "xt1")?.head, "builtin");
	describers.register({ kind: "tool", key: "t", describe: named("author") });
	assert.equal(describers.tool("t", input(), "xt1")?.head, "author", "no source is author");
	describers.register({ kind: "tool", key: "t", source: "local", describe: named("local 1") });
	describers.register({ kind: "tool", key: "t", source: "local", describe: named("local 2") });
	assert.equal(describers.tool("t", input(), "xt1")?.head, "local 2");
	describers.register({ kind: "tool", key: "t", source: "author", describe: named("author 2") });
	assert.equal(describers.tool("t", input(), "xt1")?.head, "local 2", "a later author registration does not beat local");
	assert.equal(describers.tool("other", input(), "xt1"), undefined, "no describer: the default card");
	assert.deepEqual(
		describers.report().registrations.map((entry) => [entry.source, entry.wins]),
		[["builtin", false], ["author", false], ["local", true]],
	);
	assert.deepEqual(describers.report().problems, [], "re-registering is silent");
});

test("describe: null opts a key out to the default, and a failing winner never cascades to a weaker source", () => {
	const describers = registry();
	describers.register({ kind: "tool", key: "t", source: "builtin", describe: () => ({ body: body("builtin") }) });
	describers.register({ kind: "tool", key: "t", source: "local", describe: null });
	assert.equal(describers.tool("t", input(), "xt1"), undefined);
	describers.register({
		kind: "tool",
		key: "t",
		source: "local",
		describe: () => {
			throw new Error("broken");
		},
	});
	assert.equal(describers.tool("t", input(), "xt1"), undefined, "the default card, not the builtin");
	assert.equal(describers.report().registrations.find((entry) => entry.source === "local")?.describe, "function");
});

test("output is checked before it is sent: an array of objects with string ids, announced kinds and unique ids", () => {
	const check = (output: unknown) => checkToolDescription(output, KINDS);
	assert.equal(check({ head: "h", status: "running", body: [{ id: "a", k: "card", c: [{ id: "b", k: "md", p: { text: "x" } }] }] }), undefined);
	assert.match(String(check(null)), /must return/);
	assert.match(String(check({ body: "text" })), /array/);
	assert.match(String(check({ body: ["text"] })), /object/);
	assert.match(String(check({ body: [{ k: "md" }] })), /string id/);
	assert.match(String(check({ body: [{ id: "a", k: "nope" }] })), /did not announce/);
	assert.match(String(check({ body: [{ id: "a", k: "md" }, { id: "b", k: "col", c: [{ id: "a", k: "md" }] }] })), /used twice/);
	assert.match(String(check({ body: [{ id: "a", k: "md", p: [] }] })), /props/);
	assert.match(String(check({ head: 1, body: [] })), /head/);
	assert.match(String(check({ status: "ok", body: [] })), /status/);
	assert.match(String(check(Promise.resolve({ body: [] }))), /synchronously/);
	assert.equal(checkToolDescription({ body: [{ id: "a", k: "anything" }] }, undefined), undefined, "no kinds in the hello: k is not checked");
});

test("the first error per key is logged and repeats are counted", () => {
	const logs: string[] = [];
	const describers = registry(logs);
	describers.register({ kind: "tool", key: "t", describe: () => ({ body: [{ id: "a", k: "nope" }] }) });
	for (const id of ["xt1", "xt2", "xt3"]) assert.equal(describers.tool("t", input(), id), undefined);
	assert.deepEqual(logs, ["describers: tool t: node a has kind nope, which Tern did not announce"]);
	assert.deepEqual(describers.report().problems, [{ kind: "tool", key: "t", first: "node a has kind nope, which Tern did not announce", count: 3 }]);
});

test("a failed item is tried again only when its input changes, or after an invalidate or a new registration", () => {
	const describers = registry();
	let calls = 0;
	let fail = true;
	const describe = () => {
		calls += 1;
		if (fail) throw new Error("not yet");
		return { body: body("ok") };
	};
	describers.register({ kind: "tool", key: "t", describe });
	const args = { task: "x" };
	assert.equal(describers.tool("t", input({ args }), "xt1"), undefined);
	assert.equal(describers.tool("t", input({ args }), "xt1"), undefined);
	assert.equal(calls, 1, "the same input is not described again");
	describers.tool("t", input({ args, expanded: true }), "xt1");
	assert.equal(calls, 2, "a changed input is");
	describers.retry();
	describers.tool("t", input({ args, expanded: true }), "xt1");
	assert.equal(calls, 3, "tern:invalidate retries");
	fail = false;
	describers.register({ kind: "tool", key: "t", describe });
	assert.deepEqual(describers.tool("t", input({ args, expanded: true }), "xt1")?.body, body("ok"), "so does a registration");
});

test("three describe calls over 50 ms turn a key off for the session", () => {
	const logs: string[] = [];
	let clock = 0;
	const describers = registry(logs, () => clock);
	let slow = true;
	describers.register({
		kind: "tool",
		key: "t",
		describe: () => {
			clock += slow ? SLOW_DESCRIBE_MS + 1 : 1;
			return { body: body("x") };
		},
	});
	assert.ok(describers.tool("t", input(), "xt1"), "a slow call still shows its output");
	slow = false;
	assert.ok(describers.tool("t", input(), "xt1"), "fast calls do not count");
	slow = true;
	assert.ok(describers.tool("t", input(), "xt1"));
	assert.ok(describers.tool("t", input(), "xt1"), "the third slow call is used");
	assert.equal(describers.tool("t", input(), "xt1"), undefined, "then the key is off");
	assert.deepEqual(describers.report().off, [{ kind: "tool", key: "t", reason: "3 describe calls over 50 ms" }]);
	assert.equal(describers.report().problems[0].count, 3);
	describers.resetSession();
	assert.ok(describers.tool("t", input(), "xt1"), "a new session starts over");
});

test("a Tern rejection of a described node turns its key off, and other cards are untouched", () => {
	const describers = registry();
	describers.register({ kind: "tool", key: "t", describe: () => ({ body: body("x") }) });
	describers.register({ kind: "tool", key: "u", describe: () => ({ body: body("y") }) });
	describers.tool("t", input(), "xt1");
	describers.tool("u", input(), "xt2");
	describers.rejected("xt10-zzz", "nothing owns this");
	describers.rejected("xuser-1", "not a described card");
	assert.deepEqual(describers.report().off, []);
	describers.rejected("xt1-n", "bad prop");
	assert.deepEqual(describers.report().off, [{ kind: "tool", key: "t", reason: "Tern rejected node xt1-n: bad prop" }]);
	assert.equal(describers.tool("t", input(), "xt1"), undefined);
	assert.ok(describers.tool("u", input(), "xt2"));
});

test("onEvent gets events inside its card with the ids it gave, and the same input as describe", async () => {
	const logs: string[] = [];
	const describers = registry(logs);
	const seen: unknown[] = [];
	describers.register({
		kind: "tool",
		key: "t",
		describe: () => ({ body: [{ id: "l", k: "md" }] }),
		onEvent: (event: Record<string, unknown>, given: ToolDescribeInput) => {
			seen.push([event.ev, event.id, event.item, given.toolCallId]);
			if (event.ev === "action") throw new Error("thrown");
			if (event.ev === "activate") return Promise.reject(new Error("rejected"));
			return undefined;
		},
	});
	describers.tool("t", input(), "xt1");
	assert.equal(describers.onEvent({ ev: "select", id: "xt1-l", item: "xt1-i2" }), true);
	assert.equal(describers.onEvent({ ev: "toggle", id: "xt1", collapsed: false }), false, "the surface owns collapse");
	assert.equal(describers.onEvent({ ev: "select", id: "xu1-l" }), false);
	assert.equal(describers.onEvent({ ev: "action", id: "xt1-l", act: "go" }), true);
	assert.equal(describers.onEvent({ ev: "activate", id: "xt1-l", item: "xt1-i2" }), true);
	await new Promise((resolve) => setImmediate(resolve));
	assert.deepEqual(seen, [
		["select", "l", "i2", "c1"],
		["action", "l", undefined, "c1"],
		["activate", "l", "i2", "c1"],
	]);
	assert.deepEqual(describers.report().problems, [{ kind: "tool", key: "t", first: "onEvent threw: thrown", count: 2 }]);
});

test("describers of kinds with no surface hook are kept and listed as such", () => {
	const describers = registry();
	describers.register({ kind: "widget", key: "w", describe: () => [] });
	assert.deepEqual(describers.report().registrations, [
		{ kind: "widget", key: "w", source: "author", describe: "function", wins: true, note: "no surface hook yet" },
	]);
});

test("the bus: tern:describe registers, tern:invalidate repaints, and tern:ready goes out at each session start", () => {
	const bus = new EventEmitter();
	const handlers = new Map<string, ((event: unknown, ctx: unknown) => void)[]>();
	const pi = {
		events: { emit: (channel: string, data: unknown) => bus.emit(channel, data), on: (channel: string, handler: (data: unknown) => void) => bus.on(channel, handler) },
		on: (name: string, handler: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), handler]),
	} as unknown as ExtensionAPI;
	let invalidated = 0;
	const host: SurfaceHost = { tui: () => null, invalidate: () => (invalidated += 1), log() {}, blob: () => undefined };
	const describers = registry();
	connectDescribers(pi, host, describers, KINDS);

	const ready: unknown[] = [];
	// An extension registers at load and again on tern:ready, as ADR 0003 tells it to.
	const register = () => bus.emit("tern:describe", { kind: "tool", key: "t", source: "local", describe: () => ({ head: "local", body: [] }) });
	bus.on("tern:ready", (payload) => {
		ready.push(payload);
		register();
	});
	register();
	assert.equal(describers.tool("t", input(), "xt1")?.head, "local");
	assert.equal(invalidated, 1);
	for (const handler of handlers.get("session_start") ?? []) handler({ reason: "reload" }, {});
	assert.deepEqual(ready, [{ kinds: KINDS }]);
	assert.equal(describers.report().registrations.length, 1);
	bus.emit("tern:invalidate", undefined);
	assert.equal(invalidated, 4, "registration, session start and invalidate each repaint");
	bus.emit("tern:describe", "junk");
	assert.equal(invalidated, 4, "a refused registration does not");
});

test("hello kinds come from the launcher's hello, and an empty list means unknown", () => {
	assert.deepEqual(helloKinds({ PI_TERN_HELLO: JSON.stringify({ kinds: ["md", "card"] }) }), ["md", "card"]);
	assert.equal(helloKinds({ PI_TERN_HELLO: "{}" }), undefined);
	assert.equal(helloKinds({ PI_TERN_HELLO: "not json" }), undefined);
	assert.equal(helloKinds({}), undefined);
});

// The pi-subagents describer.

/** A `details` as pi-subagents 0.84.0 sends it for one finished child. */
const singleDetails = {
	mode: "single",
	results: [
		{
			index: 0,
			agent: "scout",
			task: "[prompt redacted]",
			exitCode: 0,
			model: "claude-haiku-5-5",
			finalOutput: "Found it in `lib/config.ts`.",
			usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.01, turns: 2 },
			progressSummary: { toolCount: 3, tokens: 1200, durationMs: 4200 },
		},
	],
};

test("a finished subagent call is one agent node per child, with its output as md and its task from the arguments", () => {
	const described = describeSubagent(input({ args: { agent: "scout", task: "Find the config loader\nand report" }, result: { content: [{ type: "text", text: "ignored" }], details: singleDetails } }));
	assert.equal(described.head, "subagent scout");
	assert.equal(described.status, undefined, "the surface's status stands");
	assert.deepEqual(described.body, [
		{
			id: "a0",
			k: "agent",
			p: { name: "scout", task: "Find the config loader", status: "done", model: "claude-haiku-5-5", stats: { tools: 3, tokens: 1200, cost: 0.01, took: 4200 } },
			c: [{ id: "a0o", k: "md", p: { text: "Found it in `lib/config.ts`." } }],
		},
	]);
	assert.equal(checkToolDescription(described, KINDS), undefined);
});

test("a running child shows its current tool, and a failed child marks the card as an error", () => {
	const running = describeSubagent(
		input({
			status: "running",
			args: { tasks: [{ agent: "a", task: "one" }, { agent: "b", task: "two" }] },
			partial: {
				details: {
					mode: "parallel",
					results: [
						{ index: 0, agent: "a", task: "one", exitCode: 0, progress: { status: "running", currentTool: "read", currentToolArgs: "lib/x.ts", toolCount: 1, tokens: 10, durationMs: 900 } },
						{ index: 1, agent: "b", task: "two", exitCode: 1, error: "model refused", messages: [{ role: "assistant", content: [{ type: "text", text: "partial work" }] }] },
					],
				},
			},
		}),
	);
	assert.equal(running.head, "subagent parallel · 2 agents");
	assert.deepEqual(running.body[0].p?.tool, { name: "read", intent: "lib/x.ts" });
	assert.deepEqual(running.body[0].p?.stats, { tools: 1, tokens: 10, age: 900 });
	assert.equal(running.body[1].p?.status, "failed");
	assert.equal(running.body[1].c?.[0].p?.text, "partial work\n\nmodel refused");
	assert.equal(running.status, undefined, "still running");
	const done = describeSubagent(input({ status: "done", args: {}, result: { details: { mode: "parallel", results: [{ index: 0, agent: "b", task: "t", exitCode: 1 }] } } }));
	assert.equal(done.status, "error");
});

test("before any result the arguments name the children, and text-only results show as ansi", () => {
	const pending = describeSubagent(input({ status: "pending", argsComplete: false, args: { chain: [{ agent: "plan", task: "p" }, { agent: "build" }] } }));
	assert.equal(pending.head, "subagent chain · 2 steps");
	assert.deepEqual(pending.body.map((node) => [node.id, node.p?.name, node.p?.status]), [["a0", "plan", "pending"], ["a1", "build", "pending"]]);
	const management = describeSubagent(input({ args: { action: "list" }, result: { content: [{ type: "text", text: "scout\nworker" }], details: { mode: "management", results: [] } } }));
	assert.deepEqual(management, { head: "subagent list", body: [{ id: "o", k: "ansi", p: { text: "scout\nworker" } }] });
	assert.equal(subagentHead({ workflow: true }), "subagent workflow");
	assert.equal(subagentHead({ action: "status", agent: "scout" }), "subagent status scout");
	const repeated = describeSubagent(input({ args: {}, result: { details: { results: [{ index: 0, agent: "a" }, { index: 0, agent: "b" }] } } }));
	assert.deepEqual(repeated.body.map((node) => node.id), ["a0", "a1p"], "a repeated index still gets a unique id");
});

test("through the transcript, the registry's description fills the card and a throwing one leaves the generic card", () => {
	const branch: SessionEntryLike[] = [
		{
			type: "message",
			id: "e1",
			message: { role: "assistant", timestamp: 1, content: [{ type: "toolCall", id: "s1", name: "subagent", arguments: { agent: "scout", task: "look" } }] },
		},
		{ type: "message", id: "e2", message: { role: "toolResult", toolCallId: "s1", timestamp: 2, content: [{ type: "text", text: "found" }], details: singleDetails } },
	];
	const describers = registry();
	describers.register({ kind: "tool", key: "subagent", source: "builtin", describe: describeSubagent });
	const card = () => buildTranscriptItems(branch, undefined, { ...NO_CONTEXT, describers }).find((item) => item.id === "xts1")?.nodes[0];
	assert.equal(card()?.p?.head, "subagent scout");
	assert.deepEqual(card()?.c?.map((node) => [node.id, node.k]), [["xts1-a0", "agent"]]);
	describers.register({
		kind: "tool",
		key: "subagent",
		source: "local",
		describe: () => {
			throw new Error("local is broken");
		},
	});
	assert.equal(card()?.p?.head, "subagent look", "the generic head names the tool and its main argument");
	assert.deepEqual(card()?.c?.map((node) => [node.id, node.k]), [["xts1-o", "ansi"]]);
});
