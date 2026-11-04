// PROTOTYPE, throwaway. Hybrid native surface for issue #5.
// Transcript: semantic nodes built from session state. Composer: an `editor` node.
// Everything else in the dock: rows rendered from Pi's own components.
// Also logs transcript items that have no session-state counterpart (the "gap").
import { appendFileSync } from "node:fs";

type Node = { id: string; k: string; p?: Record<string, unknown>; c?: Node[] };
type Block = { type: "text" | "thinking"; text: string } | { type: "tool"; id: string };
type Tool = { name: string; args: any; status: string; output: string; details: any; isError: boolean };
type Item =
	| { kind: "user"; id: string; text: string }
	| { kind: "assistant"; id: string; blocks: Block[]; streaming: boolean; error?: string }
	| { kind: "other"; id: string; text: string };

const VIM = Symbol.for("pi-vim-editor");
const GAP_LOG = process.env.PI_TERN_GAP_LOG;
const MODE_LABEL: Record<string, string | undefined> = {
	normal: "NORMAL",
	visual: "VISUAL",
	"visual-line": "VISUAL",
	"visual-block": "VISUAL",
	replace: "REPLACE",
};

const items: Item[] = [];
const tools = new Map<string, Tool>();
let seq = 0;
let live: Extract<Item, { kind: "assistant" }> | null = null;
let tui: any = null;

const safeId = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");
const invalidate = () => (globalThis as any).__piTernSink?.invalidate?.();

function textOf(content: any): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((b) => b?.type === "text")
		.map((b) => b.text)
		.join("\n");
}

function toolOutput(result: any): string {
	return textOf(result?.content);
}

function applyAssistant(item: Extract<Item, { kind: "assistant" }>, message: any) {
	const blocks: Block[] = [];
	for (const b of message?.content ?? []) {
		if (b?.type === "text") blocks.push({ type: "text", text: b.text ?? "" });
		else if (b?.type === "thinking" && b.thinking) blocks.push({ type: "thinking", text: b.thinking });
		else if (b?.type === "toolCall") {
			blocks.push({ type: "tool", id: b.id });
			const known = tools.get(b.id);
			if (known) known.args = b.arguments ?? known.args;
			else
				tools.set(b.id, { name: b.name, args: b.arguments ?? {}, status: "pending", output: "", details: null, isError: false });
		}
	}
	item.blocks = blocks;
	if (message?.stopReason === "error" || message?.stopReason === "aborted")
		item.error = message.errorMessage ?? message.stopReason;
}

function applyToolResult(message: any) {
	const tool = tools.get(message.toolCallId);
	if (!tool) return;
	tool.output = toolOutput(message);
	tool.details = message.details ?? null;
	tool.isError = Boolean(message.isError);
	tool.status = tool.isError ? "error" : "done";
}

function addMessage(message: any, streaming = false) {
	switch (message?.role) {
		case "user":
			items.push({ kind: "user", id: `u${++seq}`, text: textOf(message.content) });
			break;
		case "assistant": {
			const item = { kind: "assistant" as const, id: `a${++seq}`, blocks: [], streaming };
			applyAssistant(item, message);
			items.push(item);
			return item;
		}
		case "toolResult":
			applyToolResult(message);
			break;
		case "bashExecution":
			items.push({ kind: "other", id: `o${++seq}`, text: `\`$ ${message.command ?? ""}\`\n\n${message.output ?? ""}` });
			break;
		default: {
			const text = textOf(message?.content) || message?.summary;
			if (message?.display !== false && text) items.push({ kind: "other", id: `o${++seq}`, text: String(text) });
		}
	}
	return null;
}

function rebuild(ctx: any) {
	items.length = 0;
	tools.clear();
	live = null;
	for (const entry of ctx.sessionManager?.getBranch?.() ?? []) {
		if (entry?.type === "message" && entry.message) addMessage(entry.message);
	}
}

// ---------- nodes ----------

function toolHead(tool: Tool): string {
	const a = tool.args ?? {};
	const target = a.path ?? a.file_path ?? a.command ?? a.pattern ?? "";
	return `${tool.name}${target ? ` ${String(target).split("\n")[0].slice(0, 80)}` : ""}`;
}

function toolBody(id: string, tool: Tool): Node[] {
	const d = tool.details;
	const path = tool.args?.path ?? tool.args?.file_path;
	const patch = typeof d?.patch === "string" ? d.patch : typeof d?.diff === "string" ? d.diff : null;
	if (tool.name === "edit" && patch) return [{ id: `${id}d`, k: "diff", p: { text: patch, path, mode: "unified" } }];
	if (tool.name === "write" && typeof tool.args?.content === "string")
		return [{ id: `${id}w`, k: "code", p: { text: tool.args.content, path, numbers: true } }];
	if (!tool.output) return [];
	return [{ id: `${id}o`, k: "ansi", p: { text: tool.output, preview: { lines: 12 } } }];
}

function itemNode(item: Item): Node {
	if (item.kind === "user")
		return { id: `x${item.id}`, k: "card", p: { head: "You", variant: "bare", role: "pi.user" }, c: [{ id: `x${item.id}m`, k: "md", p: { text: item.text, stream: false } }] };
	if (item.kind === "other") return { id: `x${item.id}`, k: "md", p: { text: item.text, stream: false, role: "pi.notice" } };
	const children: Node[] = item.blocks.map((b, i): Node => {
		const bid = `x${item.id}b${i}`;
		if (b.type === "text") return { id: bid, k: "md", p: { text: b.text, stream: item.streaming && i === item.blocks.length - 1 } };
		if (b.type === "thinking")
			return { id: bid, k: "card", p: { head: "Thinking", collapsible: true, collapsed: true }, c: [{ id: `${bid}m`, k: "md", p: { text: b.text, stream: false } }] };
		const tool = tools.get(b.id);
		const tid = `xt${safeId(b.id)}`;
		if (!tool) return { id: tid, k: "card", p: { head: "tool", status: "pending" } };
		return {
			id: tid,
			k: "card",
			p: { head: toolHead(tool), status: tool.status, collapsible: true, collapsed: false, preview: { lines: 14 } },
			c: toolBody(tid, tool),
		};
	});
	if (item.error) children.push({ id: `x${item.id}err`, k: "md", p: { text: `**Error:** ${item.error}`, stream: false } });
	return { id: `x${item.id}`, k: "col", p: { role: "pi.assistant" }, c: children };
}

// ---------- dock ----------

const renderLines = (c: any, cols: number): string[] => {
	try {
		return c ? (c.render(cols) as string[]) : [];
	} catch {
		return [];
	}
};

function findEditor(): any {
	const box = tui?.children?.[4];
	return box?.children?.find((c: any) => typeof c?.getText === "function") ?? null;
}

function editorNode(editor: any): Node | null {
	if (!editor) return null;
	const text = String(editor.getText?.() ?? "");
	const cur = editor.getCursor?.() ?? { line: 0, col: 0 };
	const lines = text.split("\n");
	let cursor = 0;
	for (let i = 0; i < cur.line && i < lines.length; i++) cursor += lines[i].length + 1;
	cursor += Math.min(cur.col ?? 0, lines[cur.line]?.length ?? 0);
	const vim = editor[VIM]?.status?.();
	const mode = vim ? MODE_LABEL[vim.mode] : undefined;
	const p: Record<string, unknown> = { text, cursor, sendable: true, placeholder: "Message pi" };
	if (mode) p.mode = vim.pending ? `${mode} ${vim.pending}` : mode;
	return { id: "ke", k: "editor", p };
}

function describeDock(cols: number): Node[] {
	if (!tui) return [];
	const [, pending, status, above, edBox, below, footer] = tui.children ?? [];
	const editor = findEditor();
	(globalThis as any).__piTernSink?.attachEditor?.(editor);
	const nodes: Node[] = [];
	const top = [pending, status, above].flatMap((c) => renderLines(c, cols)).filter((l) => l.trim() !== "");
	if (top.length) nodes.push({ id: "kt", k: "rows", p: { cols, lines: top } });
	if (editor?.autocompleteState && editor.autocompleteList)
		nodes.push({ id: "ka", k: "rows", p: { cols, lines: renderLines(editor.autocompleteList, cols) } });
	const en = editorNode(editor);
	if (en) nodes.push(en);
	else nodes.push({ id: "kx", k: "rows", p: { cols, lines: renderLines(edBox, cols) } });
	const bottom = [below, footer].flatMap((c) => renderLines(c, cols));
	if (bottom.length) nodes.push({ id: "kb", k: "rows", p: { cols, lines: bottom } });
	return nodes;
}

// ---------- gap measurement ----------

const KNOWN: Record<string, string> = {
	UserMessageComponent: "user",
	AssistantMessageComponent: "assistant",
	ToolExecutionComponent: "tool",
	BashExecutionComponent: "other",
	CustomMessageComponent: "other",
	CompactionSummaryMessageComponent: "other",
	BranchSummaryMessageComponent: "other",
	SkillInvocationMessageComponent: "user",
	Spacer: "ignore",
};
const logged = new Set<string>();
let gapTimer: ReturnType<typeof setTimeout> | null = null;

function measureGap() {
	if (!GAP_LOG || !tui || gapTimer) return;
	gapTimer = setTimeout(() => {
		gapTimer = null;
		const chat = tui.children?.[0]?.children?.at(-1);
		const counts: Record<string, number> = {};
		for (const child of chat?.children ?? []) {
			const name = child?.constructor?.name ?? "?";
			const cls = KNOWN[name] ?? "gap";
			counts[cls] = (counts[cls] ?? 0) + 1;
			if (cls !== "gap") continue;
			const sample = renderLines(child, 100)
				.join(" ")
				.replace(/\x1b\[[0-9;]*m/g, "")
				.replace(/\s+/g, " ")
				.trim()
				.slice(0, 120);
			const key = `${name}|${sample}`;
			if (logged.has(key)) continue;
			logged.add(key);
			appendFileSync(GAP_LOG, `${JSON.stringify({ t: Date.now(), gap: name, sample })}\n`);
		}
		const model = {
			user: items.filter((i) => i.kind === "user").length,
			assistant: items.filter((i) => i.kind === "assistant").length,
			tool: tools.size,
			other: items.filter((i) => i.kind === "other").length,
		};
		appendFileSync(GAP_LOG, `${JSON.stringify({ t: Date.now(), components: counts, model })}\n`);
	}, 1000);
}

// ---------- wiring ----------

(globalThis as any).__piTernSemantic = {
	get ready() {
		return tui !== null;
	},
	describeMain: (): Node[] => items.map(itemNode),
	describeDock,
	measureGap,
};

export default function (pi: any) {
	pi.on("session_start", (_e: any, ctx: any) => {
		if (!ctx.hasUI) return;
		rebuild(ctx);
		// A widget factory is the supported way to receive the live TUI object.
		ctx.ui.setWidget(
			"pi-tern-hybrid",
			(t: any) => {
				tui = t;
				invalidate();
				// The gap can grow without any semantic change, so measure on a timer too.
				if (GAP_LOG) setInterval(measureGap, 2000).unref?.();
				return { render: () => [], invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
	});
	pi.on("message_start", (e: any) => {
		const item = addMessage(e.message, true);
		if (item) live = item;
		invalidate();
	});
	pi.on("message_update", (e: any) => {
		if (live && e.message?.role === "assistant") applyAssistant(live, e.message);
		invalidate();
	});
	pi.on("message_end", (e: any) => {
		if (live && e.message?.role === "assistant") {
			applyAssistant(live, e.message);
			live.streaming = false;
			live = null;
		}
		invalidate();
	});
	pi.on("tool_execution_start", (e: any) => {
		const t = tools.get(e.toolCallId);
		if (t) t.status = "running";
		else tools.set(e.toolCallId, { name: e.toolName, args: e.args ?? {}, status: "running", output: "", details: null, isError: false });
		invalidate();
	});
	pi.on("tool_execution_update", (e: any) => {
		const t = tools.get(e.toolCallId);
		if (t) t.output = toolOutput(e.partialResult);
		invalidate();
	});
	pi.on("tool_execution_end", (e: any) => {
		const t = tools.get(e.toolCallId);
		if (t) {
			t.output = toolOutput(e.result);
			t.details = e.result?.details ?? t.details;
			t.isError = Boolean(e.isError);
			t.status = t.isError ? "error" : "done";
		}
		invalidate();
	});
}
