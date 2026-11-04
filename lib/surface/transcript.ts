/**
 * Transcript area (`main`): the session's messages, thinking and tool calls as semantic nodes.
 *
 * Saved items come from the session branch, read again on every repaint (ADR 0001, issue 8), so a
 * resumed session and a live one take the same path, and entries that fire no event still appear.
 * Session events only fill in what is not saved yet: the streaming reply and running tools.
 * Notices, and the rows of extension renderers, come from the `chatContainer` walk (ADR 0002).
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent, type TuiComponent } from "./host.ts";

export interface Transcript {
	/** The children of `main`. */
	describe(cols: number): SemanticNode[];
	/** True when the event was for a transcript node, such as a card `toggle`. */
	onEvent(event: TernEvent): boolean;
}

/** A content block of a saved or streaming message, read by shape. */
export interface ContentBlock {
	type: string;
	text?: string;
	thinking?: string;
	redacted?: boolean;
	id?: string;
	name?: string;
	arguments?: Record<string, unknown>;
	data?: string;
	mimeType?: string;
}

/** Any message pi saves or streams: user, assistant, toolResult, bashExecution, custom and the summaries. */
export interface MessageLike {
	role: string;
	content?: string | ContentBlock[];
	timestamp?: number;
	stopReason?: string;
	errorMessage?: string;
	toolCallId?: string;
	isError?: boolean;
	details?: Record<string, unknown>;
	command?: string;
	output?: string;
	exitCode?: number;
	cancelled?: boolean;
	customType?: string;
	display?: boolean;
	summary?: string;
	tokensBefore?: number;
}

/** A session entry as `getBranch()` returns it, read by shape. */
export interface SessionEntryLike {
	type: string;
	id: string;
	message?: MessageLike;
	customType?: string;
	content?: string | ContentBlock[];
	display?: boolean;
	summary?: string;
	tokensBefore?: number;
}

export type ToolStatus = "pending" | "running" | "done" | "error" | "cancelled";

/** A tool result or a partial one, as `toolResult` messages and `tool_execution_*` events carry it. */
export interface ToolResultLike {
	content?: string | ContentBlock[];
	details?: Record<string, unknown>;
	isError?: boolean;
}

/** A tool call as the transcript tracks it, from its `toolCall` block and its result. */
export interface ToolCallState {
	toolCallId: string;
	toolName: string;
	args: Record<string, unknown>;
	argsComplete: boolean;
	status: ToolStatus;
	partial?: ToolResultLike;
	result?: ToolResultLike;
	/** Why the call never got a result: the reply that made it was aborted or failed. */
	failure?: string;
}

/** What a tool describer gets, as issue 6 fixes it. */
export interface ToolDescribeInput {
	toolCallId: string;
	args: Record<string, unknown>;
	argsComplete: boolean;
	status: ToolStatus;
	partial?: ToolResultLike;
	result?: ToolResultLike;
	expanded: boolean;
}

/** A describer's content for the card the transcript owns. Body ids are prefixed with the card's id. */
export interface ToolDescription {
	head?: string;
	status?: ToolStatus;
	body: SemanticNode[];
}

/**
 * The seam for the describer registry (`describers.ts`). `tool` returns undefined for a tool with no
 * usable describer, and the transcript then draws its default card. Output checks, timing and
 * precedence belong to the registry, so a returned description is used as it is. `cardId` prefixes
 * the body ids, so the registry can tell which card a Tern event or rejection is about.
 */
export interface TranscriptDescribers {
	tool?(toolName: string, input: ToolDescribeInput, cardId: string): ToolDescription | undefined;
}

/**
 * The pi component class that draws each item in `chatContainer` (`addMessageToChat()` and
 * `renderSessionItems()` in pi 1.5.0). The walk matches components to items through these names.
 */
export const PI_COMPONENTS = {
	user: "UserMessageComponent",
	skill: "SkillInvocationMessageComponent",
	assistant: "AssistantMessageComponent",
	tool: "ToolExecutionComponent",
	bash: "BashExecutionComponent",
	customMessage: "CustomMessageComponent",
	customEntry: "CustomEntryComponent",
	compaction: "CompactionSummaryMessageComponent",
	branchSummary: "BranchSummaryMessageComponent",
} as const;

type PiComponentName = (typeof PI_COMPONENTS)[keyof typeof PI_COMPONENTS];

/** Spacing pi puts between items. It has no meaning, so the walk skips it. */
const SPACER = "Spacer";
/** The component `notify()` and pi's own errors and warnings add, which shows as `md`. */
const THEMED_TEXT = "ThemedText";

/** One item in transcript order, with the pi component that draws the same item. */
export interface TranscriptItem {
	/** Stable across repaints and unique, because the tree diff keys on it. */
	id: string;
	component: PiComponentName;
	nodes: SemanticNode[];
}

const TOOL_PREVIEW_LINES = 12;
/** Argument names that say what a tool call acts on, in the order a card head prefers them. */
const MAIN_ARGUMENTS = ["path", "file_path", "command", "pattern", "query", "url", "name", "task"];
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n([\s\S]*?)\n<\/skill>(?:\n\n([\s\S]+))?$/;

const safeId = (raw: string) => raw.replace(/[^A-Za-z0-9_-]/g, "");

export function textOf(content: string | ContentBlock[] | undefined, separator = "\n"): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((block) => block?.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join(separator);
}

function imagesOf(content: string | ContentBlock[] | undefined): ContentBlock[] {
	if (!Array.isArray(content)) return [];
	return content.filter((block) => block?.type === "image" && typeof block.data === "string" && block.data.length > 0);
}

/** Live and saved copies of one message share this key, so its nodes keep their ids once pi saves it. */
export function messageKey(message: MessageLike): string | undefined {
	return typeof message.timestamp === "number" && Number.isFinite(message.timestamp)
		? `${message.role}-${message.timestamp}`
		: undefined;
}

function mainArgument(args: Record<string, unknown>): string {
	const named = MAIN_ARGUMENTS.map((key) => args[key]).find((value) => typeof value === "string" && value !== "");
	const value = named ?? Object.values(args).find((candidate) => typeof candidate === "string" && candidate !== "");
	return typeof value === "string" ? value.split("\n")[0].slice(0, 120) : "";
}

/** Card state the user changed with a `toggle`, by node id. */
export type CollapseOverrides = ReadonlyMap<string, boolean>;

/** What building nodes needs beyond the items themselves. */
export interface BuildContext {
	collapsed: CollapseOverrides;
	describers: TranscriptDescribers;
	/** Image bytes to a blob id, or undefined when the bytes cannot reach Tern. */
	blob(data: string, mime: string): string | undefined;
}

export const NO_CONTEXT: BuildContext = { collapsed: new Map(), describers: {}, blob: () => undefined };

function imageNodes(id: string, content: string | ContentBlock[] | undefined, context: BuildContext): SemanticNode[] {
	return imagesOf(content).flatMap((image, index) => {
		const blob = context.blob(image.data ?? "", image.mimeType ?? "image/png");
		return blob ? [{ id: `${id}-i${index}`, k: "image", p: { blob, alt: "tool result image" } }] : [];
	});
}

/** The default body: a diff for `edit`, code for `write`, else the text output and any images. */
export function defaultToolBody(id: string, tool: ToolCallState, context: BuildContext = NO_CONTEXT): SemanticNode[] {
	const outcome = tool.result ?? tool.partial;
	const path = typeof tool.args.path === "string" ? tool.args.path : undefined;
	const patch = tool.result?.details?.patch;
	if (tool.toolName === "edit" && typeof patch === "string" && !tool.result?.isError) {
		return [{ id: `${id}-d`, k: "diff", p: { text: patch, path, mode: "unified" } }];
	}
	const body: SemanticNode[] = [];
	if (tool.toolName === "write" && typeof tool.args.content === "string" && !tool.result?.isError) {
		body.push({ id: `${id}-c`, k: "code", p: { text: tool.args.content, path, numbers: true } });
	} else {
		const output = textOf(outcome?.content) || tool.failure || "";
		if (output) body.push({ id: `${id}-o`, k: "ansi", p: { text: output } });
	}
	body.push(...imageNodes(id, outcome?.content, context));
	return body;
}

function prefixIds(prefix: string, nodes: SemanticNode[]): SemanticNode[] {
	return nodes.map((node) => ({ ...node, id: `${prefix}-${node.id}`, ...(node.c ? { c: prefixIds(prefix, node.c) } : {}) }));
}

/** Every transcript card starts collapsed, as pi starts its tool output collapsed. A `toggle` overrides it. */
function collapsibleCard(id: string, props: Record<string, unknown>, body: SemanticNode[], collapsed: CollapseOverrides): SemanticNode {
	return { id, k: "card", p: { ...props, collapsible: true, collapsed: collapsed.get(id) ?? true }, c: body };
}

/** The verb Tern shows in a tool's head, as OMP names pi's built-in tools. */
const TOOL_TITLES: Record<string, string> = { bash: "Bash", read: "Read", edit: "Edit", write: "Write", grep: "Grep", find: "Find", ls: "List" };
const TARGET_KINDS: Record<string, string> = { bash: "command", read: "path", edit: "path", write: "path", ls: "path", grep: "pattern", find: "pattern" };
/** Tools whose body is reference output, drawn frameless with the body folded away as OMP does. */
const INLINE_TOOLS = new Set(["read", "grep", "find", "ls"]);

/** Head facts after the target: lines added and removed for `edit`, the line count for `write`. */
export function toolMeta(tool: ToolCallState): string[] | undefined {
	const patch = tool.result?.details?.patch;
	if (tool.toolName === "edit" && typeof patch === "string") {
		const lines = patch.split("\n");
		const added = lines.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length;
		const removed = lines.filter((line) => line.startsWith("-") && !line.startsWith("---")).length;
		return [`+${added} \u2212${removed}`];
	}
	if (tool.toolName === "write" && typeof tool.args.content === "string") {
		const content = tool.args.content;
		const count = content === "" ? 0 : content.replace(/\n$/, "").split("\n").length;
		return [`${count} ${count === 1 ? "line" : "lines"}`];
	}
	return undefined;
}

/** A tool call as Tern's `tool` kind, which draws OMP's head (verb, target, facts, status, time). */
export function toolCard(tool: ToolCallState, context: BuildContext = NO_CONTEXT): SemanticNode {
	const id = `xt${safeId(tool.toolCallId)}`;
	const isCollapsed = context.collapsed.get(id) ?? true;
	const described = context.describers.tool?.(
		tool.toolName,
		{
			toolCallId: tool.toolCallId,
			args: tool.args,
			argsComplete: tool.argsComplete,
			status: tool.status,
			partial: tool.partial,
			result: tool.result,
			expanded: !isCollapsed,
		},
		id,
	);
	const status = described?.status ?? tool.status;
	const body = described ? prefixIds(id, described.body) : defaultToolBody(id, tool, context);
	const name = tool.toolName;
	const target = described ? undefined : mainArgument(tool.args ?? {});
	const inline = !described && INLINE_TOOLS.has(name);
	const p: Record<string, unknown> = {
		role: `omp.tool.${safeId(name)}`,
		name,
		title: described?.head ?? TOOL_TITLES[name] ?? name,
		status,
		frame: inline ? "inline" : "card",
	};
	if (target) {
		p.target = target;
		if (TARGET_KINDS[name]) p.targetKind = TARGET_KINDS[name];
		if (name === "bash") p.lang = "bash";
	}
	const meta = described ? undefined : toolMeta(tool);
	if (meta) p.meta = meta;
	if (body.length > 0) {
		p.collapsible = true;
		p.collapsed = isCollapsed;
		p.preview = inline ? "none" : name === "bash" ? { tail: TOOL_PREVIEW_LINES } : { lines: TOOL_PREVIEW_LINES };
	}
	return { id, k: "tool", p, c: body };
}

/**
 * Text with a tone. Tern 0.9.10 accepts `tone` on `md` but draws no tone, so a `badge`, the one node
 * seen to draw it, carries the tone.
 */
function tonedNode(id: string, label: string, tone: string, text: string, role?: string): SemanticNode {
	return {
		id,
		k: "row",
		p: { gap: "sm", align: "baseline", ...(role ? { role } : {}) },
		c: [
			{ id: `${id}b`, k: "badge", p: { text: label, tone } },
			{ id: `${id}m`, k: "md", p: { text, tone } },
		],
	};
}

/**
 * OMP's thinking section: open with a live "Thinking…" head while it streams, then folded under
 * "Thought". pi saves no thinking duration, so the head names none.
 */
function thinkingSection(id: string, thinking: string, live: boolean, collapsed: CollapseOverrides): SemanticNode {
	const head: SemanticNode = live
		? {
				id: `${id}h`,
				k: "row",
				p: { gap: "sm" },
				c: [
					{ id: `${id}hs`, k: "spinner", p: { style: "starburst", role: "omp.thinking.spin" } },
					{ id: `${id}ht`, k: "text", p: { spans: [{ t: "Thinking\u2026", s: "muted" }] } },
				],
			}
		: { id: `${id}h`, k: "text", p: { spans: [{ t: "Thought", s: "muted" }] } };
	return {
		id,
		k: "section",
		p: { role: live ? "omp.thinking.live" : "omp.thinking", collapsible: true, collapsed: collapsed.get(id) ?? !live },
		c: [head, { id: `${id}m`, k: "md", p: { text: thinking, stream: live } }],
	};
}

function assistantNodes(id: string, message: MessageLike, streaming: boolean, collapsed: CollapseOverrides): SemanticNode[] {
	const blocks = Array.isArray(message.content) ? message.content : [];
	const lastText = blocks.map((block) => block?.type).lastIndexOf("text");
	const children: SemanticNode[] = [];
	blocks.forEach((block, index) => {
		const blockId = `${id}b${index}`;
		if (block?.type === "text" && block.text) {
			children.push({ id: blockId, k: "md", p: { text: block.text, stream: streaming && index === lastText } });
		} else if (block?.type === "thinking" && block.thinking && !block.redacted) {
			children.push(thinkingSection(blockId, block.thinking, streaming && index === blocks.length - 1, collapsed));
		}
	});
	if (message.stopReason === "aborted") {
		// pi shows a custom reason in place of its generic one, as `AssistantMessageComponent` does.
		const reason = message.errorMessage && message.errorMessage !== "Request was aborted" ? message.errorMessage : "Operation aborted";
		children.push({ id: `${id}err`, k: "text", p: { spans: [{ t: reason, s: "error" }], wrap: "word", role: "omp.assistant.abort" } });
	}
	if (message.stopReason === "error") {
		const text = message.errorMessage || "Error";
		children.push({ id: `${id}err`, k: "card", p: { role: "omp.error", tone: "error" }, c: [{ id: `${id}errm`, k: "md", p: { text, role: "omp.error.message" } }] });
	}
	return children.length > 0 ? [{ id, k: "col", p: { role: "omp.assistant" }, c: children }] : [];
}

function userItems(id: string, message: MessageLike, collapsed: CollapseOverrides): TranscriptItem[] {
	const text = textOf(message.content, "");
	if (!text) return [];
	const userCard = (userId: string, userText: string): TranscriptItem => ({
		id: userId,
		component: PI_COMPONENTS.user,
		nodes: [{ id: userId, k: "card", p: { role: "omp.user", tone: "user" }, c: [{ id: `${userId}m`, k: "md", p: { text: userText } }] }],
	});
	const skill = text.match(SKILL_BLOCK);
	if (!skill) return [userCard(id, text)];
	const skillId = `${id}s`;
	const items: TranscriptItem[] = [
		{
			id: skillId,
			component: PI_COMPONENTS.skill,
			nodes: [collapsibleCard(skillId, { head: `Skill ${skill[1]}`, role: "pi.skill" }, [{ id: `${skillId}m`, k: "md", p: { text: skill[3] } }], collapsed)],
		},
	];
	const rest = skill[4]?.trim();
	if (rest) items.push(userCard(id, rest));
	return items;
}

function bashItem(id: string, message: MessageLike, collapsed: CollapseOverrides): TranscriptItem {
	const status: ToolStatus = message.cancelled ? "cancelled" : message.exitCode === 0 || message.exitCode === undefined ? "done" : "error";
	const body: SemanticNode[] = message.output ? [{ id: `${id}o`, k: "ansi", p: { text: message.output } }] : [];
	const p: Record<string, unknown> = {
		role: "omp.tool.bash",
		name: "bash",
		title: "Bash",
		target: message.command ?? "",
		targetKind: "command",
		lang: "bash",
		status,
		badges: [{ text: "you", title: "Run with ! in the composer" }],
		frame: "card",
	};
	if (typeof message.exitCode === "number" && message.exitCode !== 0) p.exit = message.exitCode;
	if (body.length > 0) Object.assign(p, { collapsible: true, collapsed: collapsed.get(id) ?? true, preview: { tail: TOOL_PREVIEW_LINES } });
	return { id, component: PI_COMPONENTS.bash, nodes: [{ id, k: "tool", p, c: body }] };
}

function customMessageItem(id: string, message: MessageLike): TranscriptItem[] {
	if (!message.display) return [];
	const text = textOf(message.content);
	return [{ id, component: PI_COMPONENTS.customMessage, nodes: text ? [{ id, k: "md", p: { text, role: `pi.custom.${safeId(message.customType ?? "")}` } }] : [] }];
}

function summaryItem(id: string, component: PiComponentName, head: string, summary: string, collapsed: CollapseOverrides): TranscriptItem {
	const role = component === PI_COMPONENTS.compaction ? "omp.compaction" : "pi.summary";
	return { id, component, nodes: [collapsibleCard(id, { head, role }, [{ id: `${id}m`, k: "md", p: { text: summary } }], collapsed)] };
}

/** A message to transcript items, without its tool calls, which `buildTranscriptItems` adds. */
function messageItems(id: string, message: MessageLike, streaming: boolean, collapsed: CollapseOverrides): TranscriptItem[] {
	switch (message.role) {
		case "user":
			return userItems(id, message, collapsed);
		case "assistant":
			return [{ id, component: PI_COMPONENTS.assistant, nodes: assistantNodes(id, message, streaming, collapsed) }];
		case "bashExecution":
			return [bashItem(id, message, collapsed)];
		case "custom":
			return customMessageItem(id, message);
		case "compactionSummary":
			return [summaryItem(id, PI_COMPONENTS.compaction, compactionHead(message.tokensBefore), message.summary ?? "", collapsed)];
		case "branchSummary":
			return [summaryItem(id, PI_COMPONENTS.branchSummary, "Branch summary", message.summary ?? "", collapsed)];
		default:
			return [];
	}
}

function compactionHead(tokensBefore: number | undefined): string {
	return typeof tokensBefore === "number" ? `Compacted from ${tokensBefore.toLocaleString("en-US")} tokens` : "Compaction";
}

/** An entry as the message pi shows for it, as `sessionEntryToContextMessages()` maps it, or null. */
function entryMessage(entry: SessionEntryLike): MessageLike | null {
	switch (entry.type) {
		case "message":
			return entry.message ?? null;
		case "custom_message":
			return { role: "custom", customType: entry.customType, content: entry.content, display: entry.display };
		case "compaction":
			return { role: "compactionSummary", summary: entry.summary, tokensBefore: entry.tokensBefore };
		case "branch_summary":
			return entry.summary ? { role: "branchSummary", summary: entry.summary } : null;
		default:
			return null;
	}
}

/** A tool call's progress from `tool_execution_*` events. */
export interface LiveTool {
	status: ToolStatus;
	partial?: ToolResultLike;
	result?: ToolResultLike;
}

/** What the session events add on top of the saved branch. */
export interface LiveState {
	/** Messages from `message_*` events, oldest first, until the branch holds them. */
	messages: MessageLike[];
	/** Messages still streaming, by `messageKey`. */
	streaming: ReadonlySet<string>;
	/** Running tools from `tool_execution_*` events, by tool call id. */
	tools: ReadonlyMap<string, LiveTool>;
}

const EMPTY_LIVE: LiveState = { messages: [], streaming: new Set(), tools: new Map() };

/**
 * The transcript items for a branch plus what is not saved yet, in branch order.
 *
 * Tool calls pair with their results by id, as pi's `renderSessionItems()` does. Each tool card is an
 * item of its own after its reply, because pi draws a tool call as its own component there.
 */
export function buildTranscriptItems(
	branch: readonly SessionEntryLike[],
	live: LiveState = EMPTY_LIVE,
	context: BuildContext = NO_CONTEXT,
): TranscriptItem[] {
	const { collapsed } = context;
	const saved = new Set<string>();
	const sequence: { id: string; message: MessageLike | null; entry: SessionEntryLike }[] = [];
	const ids = new Set<string>();
	const uniqueId = (raw: string) => {
		let id = `x${safeId(raw)}`;
		for (let n = 2; ids.has(id); n += 1) id = `x${safeId(raw)}_${n}`;
		ids.add(id);
		return id;
	};
	for (const entry of branch) {
		if (!entry || typeof entry !== "object") continue;
		const message = entryMessage(entry);
		const key = message && entry.type === "message" ? messageKey(message) : undefined;
		if (key) saved.add(key);
		sequence.push({ id: uniqueId(key ?? entry.id ?? ""), message, entry });
	}
	for (const message of live.messages) {
		const key = messageKey(message);
		if (key && saved.has(key)) continue;
		sequence.push({ id: uniqueId(key ?? `live-${message.role}`), message, entry: { type: "message", id: "" } });
	}

	const results = new Map<string, ToolResultLike>();
	for (const { message } of sequence) {
		if (message?.role === "toolResult" && message.toolCallId) results.set(message.toolCallId, message);
	}

	const items: TranscriptItem[] = [];
	for (const { id, message, entry } of sequence) {
		if (entry.type === "custom") {
			// pi draws a custom entry only through its extension's renderer, so the walk supplies its rows.
			items.push({ id, component: PI_COMPONENTS.customEntry, nodes: [] });
			continue;
		}
		if (!message) continue;
		const key = messageKey(message);
		const streaming = key !== undefined && live.streaming.has(key);
		items.push(...messageItems(id, message, streaming, collapsed));
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const block of message.content) {
			if (block?.type !== "toolCall" || typeof block.id !== "string") continue;
			const tool = toolState(block, message, streaming, results.get(block.id), live.tools.get(block.id));
			const card = toolCard(tool, context);
			// A repeated tool call id would give Tern two nodes with one id, and it rejects the frame.
			if (ids.has(card.id)) continue;
			ids.add(card.id);
			items.push({ id: card.id, component: PI_COMPONENTS.tool, nodes: [card] });
		}
	}
	return items;
}

function toolState(
	block: ContentBlock,
	message: MessageLike,
	streaming: boolean,
	result: ToolResultLike | undefined,
	running: LiveTool | undefined,
): ToolCallState {
	const base = {
		toolCallId: block.id ?? "",
		toolName: block.name ?? "tool",
		args: block.arguments && typeof block.arguments === "object" ? block.arguments : {},
		argsComplete: !streaming,
	};
	const settled = result ?? running?.result;
	if (settled) return { ...base, status: settled.isError ? "error" : "done", result: settled };
	if (running) return { ...base, status: running.status, partial: running.partial };
	if (message.stopReason === "aborted") return { ...base, status: "error", failure: "Operation aborted" };
	if (message.stopReason === "error") return { ...base, status: "error", failure: message.errorMessage || "Error" };
	return { ...base, status: "pending" };
}

// The chatContainer walk (ADR 0002): only `children`, class names and `render()`.

const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;

const className = (component: TuiComponent): string => (component as { constructor?: { name?: string } }).constructor?.name ?? "";

function plainText(lines: string[]): string {
	return lines
		.map((line) => line.replace(ANSI, "").trim())
		.filter((line) => line !== "")
		.join("\n");
}

/** The prefixes `showError()` and `showWarning()` put on a notice, and the tone each one gets. */
const NOTICE_TONES: [prefix: string, tone: string, label: string][] = [
	["Error: ", "error", "Error"],
	["Warning: ", "warning", "Warning"],
];

/** A notice as `md`, or as toned text when pi prefixed it as an error or a warning. */
function noticeNode(id: string, text: string): SemanticNode {
	const toned = NOTICE_TONES.find(([prefix]) => text.startsWith(prefix));
	if (!toned) return { id, k: "md", p: { text, role: "pi.notice" } };
	const [prefix, tone, label] = toned;
	return tonedNode(id, label, tone, text.slice(prefix.length), "pi.notice");
}

/** pi's own rendering of a custom message with no renderer: a `Box` of label, spacer and Markdown. */
function isDefaultCustomMessage(component: TuiComponent): boolean {
	const box = component.children?.find((child) => className(child) !== SPACER);
	return className(box ?? ({} as TuiComponent)) === "Box" && (box?.children ?? []).map(className).join(",") === "Text,Spacer,Markdown";
}

/** What the walk found: notices by the id of the item they follow ("" for the top), and renderer rows by item id. */
export interface ChatWalk {
	notices: Map<string, SemanticNode[]>;
	rows: Map<string, SemanticNode[]>;
}

/** Items match pi's components by order within a class, and only while the two counts agree. */
const ROW_CLASSES: PiComponentName[] = [PI_COMPONENTS.customEntry, PI_COMPONENTS.customMessage];
const KNOWN_CLASSES = new Set<string>(Object.values(PI_COMPONENTS));

/**
 * Walk pi's `chatContainer` for the components with no session counterpart, and for the rows of
 * extension renderers. Throws when the container has no `children`, so the caller can log it.
 */
export function walkChat(chat: TuiComponent | undefined, items: readonly TranscriptItem[], cols: number, log: (message: string) => void): ChatWalk {
	const children = chat?.children;
	if (!Array.isArray(children)) throw new Error("chatContainer has no children array");
	const walk: ChatWalk = { notices: new Map(), rows: new Map() };

	for (const cls of ROW_CLASSES) {
		const components = children.filter((child) => className(child) === cls);
		const matching = items.filter((item) => item.component === cls);
		if (components.length !== matching.length) {
			log(`${cls} count differs from the saved items, so their renderer rows are not shown`);
			continue;
		}
		components.forEach((component, index) => {
			if (cls === PI_COMPONENTS.customMessage && isDefaultCustomMessage(component)) return;
			const lines = renderRows(component, cols);
			const first = lines.findIndex((line) => line.trim() !== "");
			const id = matching[index].id;
			walk.rows.set(id, first === -1 ? [] : [{ id: `${id}r`, k: "rows", p: { cols, lines: lines.slice(first) } }]);
		});
	}

	// A notice follows the nearest item before it. Counting from the end keeps that right when the
	// branch holds older items than pi's container, as after a compaction.
	const remaining = new Map<string, number>();
	for (const child of children) {
		const cls = className(child);
		if (KNOWN_CLASSES.has(cls)) remaining.set(cls, (remaining.get(cls) ?? 0) + 1);
	}
	let anchor = "";
	let pendingRows: string[] = [];
	const counts = new Map<string, number>();
	const push = (node: SemanticNode) => {
		const list = walk.notices.get(anchor) ?? [];
		list.push(node);
		walk.notices.set(anchor, list);
	};
	const nextId = () => {
		const n = counts.get(anchor) ?? 0;
		counts.set(anchor, n + 1);
		return `xn${anchor}-${n}`;
	};
	const flushRows = () => {
		if (pendingRows.length > 0) push({ id: nextId(), k: "rows", p: { cols, lines: pendingRows } });
		pendingRows = [];
	};
	for (const child of children) {
		const cls = className(child);
		if (cls === SPACER) continue;
		if (KNOWN_CLASSES.has(cls)) {
			flushRows();
			const fromEnd = (remaining.get(cls) ?? 1) - 1;
			remaining.set(cls, fromEnd);
			const sameClass = items.filter((item) => item.component === cls);
			anchor = sameClass[sameClass.length - 1 - fromEnd]?.id ?? items[items.length - 1]?.id ?? "";
			continue;
		}
		const lines = renderRows(child, cols);
		if (cls === THEMED_TEXT) {
			flushRows();
			const text = plainText(lines);
			if (text) push(noticeNode(nextId(), text));
		} else {
			pendingRows.push(...lines.filter((line) => line.replace(ANSI, "").trim() !== ""));
		}
	}
	flushRows();
	return walk;
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createTranscript(pi: ExtensionAPI, host: SurfaceHost, describers: TranscriptDescribers = {}): Transcript {
	let branch: () => readonly SessionEntryLike[] = () => [];
	let liveMessages: MessageLike[] = [];
	const streaming = new Set<string>();
	const tools = new Map<string, LiveTool>();
	const collapsed = new Map<string, boolean>();
	const logged = new Set<string>();
	const logOnce = (message: string) => {
		if (logged.has(message)) return;
		logged.add(message);
		host.log(`transcript: ${message}`);
	};

	const track = (message: MessageLike | undefined, isStreaming: boolean) => {
		if (!message || typeof message.role !== "string") return;
		const key = messageKey(message);
		const index = key ? liveMessages.findIndex((known) => messageKey(known) === key) : -1;
		if (index === -1) liveMessages.push(message);
		else liveMessages[index] = message;
		if (key && isStreaming) streaming.add(key);
		else if (key) streaming.delete(key);
		host.invalidate();
	};
	const settleTool = (id: string, change: LiveTool) => {
		tools.set(id, { ...tools.get(id), ...change });
		host.invalidate();
	};

	pi.on("session_start", (_event, ctx) => {
		const sessionManager = ctx.sessionManager;
		branch = () => sessionManager.getBranch() as unknown as SessionEntryLike[];
		liveMessages = [];
		streaming.clear();
		tools.clear();
		collapsed.clear();
		host.invalidate();
	});
	pi.on("message_start", (event) => track(event.message as MessageLike, true));
	pi.on("message_update", (event) => track(event.message as MessageLike, true));
	pi.on("message_end", (event) => track(event.message as MessageLike, false));
	pi.on("tool_execution_start", (event) => settleTool(event.toolCallId, { status: "running" }));
	pi.on("tool_execution_update", (event) => settleTool(event.toolCallId, { status: "running", partial: event.partialResult as ToolResultLike }));
	pi.on("tool_execution_end", (event) =>
		settleTool(event.toolCallId, { status: event.isError ? "error" : "done", result: { ...(event.result as ToolResultLike), isError: event.isError } }),
	);

	return {
		describe(cols) {
			let entries: readonly SessionEntryLike[] = [];
			try {
				entries = branch();
			} catch (error) {
				logOnce(`the session branch could not be read: ${String((error as Error)?.message ?? error)}`);
			}
			const saved = new Set(entries.map((entry) => (entry?.type === "message" && entry.message ? messageKey(entry.message) : undefined)));
			// Once pi saves a live message, the branch is its source.
			liveMessages = liveMessages.filter((message) => {
				const key = messageKey(message);
				return key === undefined || !saved.has(key);
			});
			const items = buildTranscriptItems(entries, { messages: liveMessages, streaming, tools }, { collapsed, describers, blob: host.blob });

			let walk: ChatWalk = { notices: new Map(), rows: new Map() };
			try {
				const tui = host.tui();
				if (tui) walk = walkChat(piSlot(tui, "document")?.children?.at(-1), items, cols, logOnce);
			} catch (error) {
				logOnce(`the chatContainer walk failed, so notices are not shown: ${String((error as Error)?.message ?? error)}`);
			}
			const nodes: SemanticNode[] = [...(walk.notices.get("") ?? [])];
			for (const item of items) {
				nodes.push(...(walk.rows.get(item.id) ?? item.nodes));
				nodes.push(...(walk.notices.get(item.id) ?? []));
			}
			return nodes;
		},
		onEvent(event) {
			if (event.ev !== "toggle" || typeof event.id !== "string" || !event.id.startsWith("x")) return false;
			collapsed.set(event.id, event.collapsed === true);
			return true;
		},
	};
}
