/**
 * The built-in describer for pi-subagents' `subagent` tool (issue 6, point 4).
 *
 * Its input is the tool's arguments and the `details` pi-subagents puts on partial and final results
 * (`Details` in pi-subagents 0.84.0 `src/shared/types.d.ts`). Each child run becomes an `agent` node,
 * the TSP kind for one subagent as live data, with its output as `md` inside.
 */
import type { SemanticNode } from "./host.ts";
import { textOf, type ContentBlock, type ToolDescribeInput, type ToolDescription } from "./transcript.ts";

export const SUBAGENT_TOOL = "subagent";

/** A child's `progress`, read by shape. */
interface SubagentProgress {
	status?: string;
	currentTool?: string;
	currentToolArgs?: string;
	toolCount?: number;
	tokens?: number;
	durationMs?: number;
	model?: string;
	thinking?: string;
}

/** One child run in `details.results`, read by shape. */
interface SubagentResult {
	index?: number;
	agent?: string;
	task?: string;
	exitCode?: number;
	interrupted?: boolean;
	stopped?: boolean;
	detached?: boolean;
	error?: string;
	model?: string;
	thinking?: string;
	finalOutput?: string;
	messages?: { role?: string; content?: string | ContentBlock[] }[];
	usage?: { cost?: number; turns?: number };
	progress?: SubagentProgress;
	progressSummary?: SubagentProgress;
}

interface SubagentDetails {
	mode?: string;
	results?: SubagentResult[];
}

type AgentStatus = "pending" | "running" | "done" | "failed" | "aborted" | "parked";

const PROGRESS_STATUS: Record<string, AgentStatus> = {
	pending: "pending",
	running: "running",
	completed: "done",
	failed: "failed",
	detached: "parked",
};

const oneLine = (text: string, max = 160) => {
	const line = text.split("\n").find((part) => part.trim() !== "")?.trim() ?? "";
	return line.length > max ? `${line.slice(0, max - 1)}…` : line;
};

const asRecord = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

function childStatus(result: SubagentResult): AgentStatus {
	const progress = result.progress?.status;
	if (progress === "running" || progress === "pending") return progress;
	if (result.detached) return "parked";
	if (result.interrupted || result.stopped) return "aborted";
	if (typeof result.exitCode === "number") return result.exitCode === 0 ? "done" : "failed";
	return PROGRESS_STATUS[progress ?? ""] ?? "pending";
}

/** What a child said last: its final output, else the text of its last assistant message. */
function childOutput(result: SubagentResult): string {
	if (typeof result.finalOutput === "string") return result.finalOutput;
	const replies = (result.messages ?? []).filter((message) => message?.role === "assistant");
	for (let i = replies.length - 1; i >= 0; i -= 1) {
		const text = textOf(replies[i].content);
		if (text.trim()) return text;
	}
	return "";
}

function agentNode(result: SubagentResult, id: string): SemanticNode {
	const status = childStatus(result);
	const progress = result.progress ?? result.progressSummary;
	const stats: Record<string, number> = {};
	if (typeof progress?.toolCount === "number") stats.tools = progress.toolCount;
	if (typeof progress?.tokens === "number") stats.tokens = progress.tokens;
	if (typeof result.usage?.cost === "number" && result.usage.cost > 0) stats.cost = result.usage.cost;
	if (typeof progress?.durationMs === "number") stats[status === "running" ? "age" : "took"] = progress.durationMs;
	const output = status === "failed" && result.error ? `${childOutput(result)}\n\n${result.error}`.trim() : childOutput(result);
	return {
		id,
		k: "agent",
		p: {
			name: result.agent || "subagent",
			task: oneLine(result.task ?? ""),
			status,
			...(result.model || progress?.model ? { model: result.model || progress?.model } : {}),
			...(result.thinking || progress?.thinking ? { thinking: result.thinking || progress?.thinking } : {}),
			...(status === "running" && progress?.currentTool ? { tool: { name: progress.currentTool, intent: oneLine(progress.currentToolArgs ?? "") } } : {}),
			...(Object.keys(stats).length > 0 ? { stats } : {}),
		},
		...(output ? { c: [{ id: `${id}o`, k: "md", p: { text: output } }] } : {}),
	};
}

/** The children the arguments ask for, before any result names them. */
function plannedChildren(args: Record<string, unknown>): SubagentResult[] {
	const steps = Array.isArray(args.tasks) ? args.tasks : Array.isArray(args.chain) ? args.chain : [];
	if (steps.length > 0) return steps.map((step, index) => ({ index, agent: String(asRecord(step).agent ?? ""), task: String(asRecord(step).task ?? "") }));
	return typeof args.agent === "string" && typeof args.task === "string" ? [{ index: 0, agent: args.agent, task: args.task }] : [];
}

export function subagentHead(args: Record<string, unknown>): string {
	if (typeof args.action === "string") return [SUBAGENT_TOOL, args.action, typeof args.agent === "string" ? args.agent : ""].filter(Boolean).join(" ");
	if (args.workflow !== undefined) return `${SUBAGENT_TOOL} workflow`;
	if (Array.isArray(args.tasks)) return `${SUBAGENT_TOOL} parallel · ${args.tasks.length} agents`;
	if (Array.isArray(args.chain)) return `${SUBAGENT_TOOL} chain · ${args.chain.length} steps`;
	return typeof args.agent === "string" ? `${SUBAGENT_TOOL} ${args.agent}` : SUBAGENT_TOOL;
}

/** Agent nodes keyed by each child's launch index, which stays put between partial and final results. */
function agentNodes(results: SubagentResult[]): SemanticNode[] {
	const used = new Set<string>();
	return results.map((result, position) => {
		let id = `a${typeof result.index === "number" ? result.index : position}`;
		if (used.has(id)) id = `a${position}p`;
		used.add(id);
		return agentNode(result, id);
	});
}

export function describeSubagent(input: ToolDescribeInput): ToolDescription {
	const outcome = input.result ?? input.partial;
	const details = asRecord(outcome?.details) as SubagentDetails;
	const results = Array.isArray(details.results) ? details.results : [];
	const head = subagentHead(input.args);
	if (results.length > 0) {
		// pi-subagents saves the task as "[prompt redacted]", so the arguments name it where they can.
		const planned = plannedChildren(input.args);
		const nodes = agentNodes(results.map((result, position) => ({ ...result, task: planned[result.index ?? position]?.task || result.task })));
		// pi-subagents reports a failed child in a result that is not an error, so the card would say Done.
		const failed = input.status === "done" && nodes.some((node) => node.p?.status === "failed");
		return { head, ...(failed ? { status: "error" as const } : {}), body: nodes };
	}
	// Management actions and runs that only answer in text, such as a background launch.
	const text = textOf(outcome?.content);
	if (text) return { head, body: [{ id: "o", k: "ansi", p: { text } }] };
	return { head, body: agentNodes(plannedChildren(input.args)) };
}
