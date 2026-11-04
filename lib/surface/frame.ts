/**
 * The composer's frame: OMP's native composer, carrying what pi's footer shows.
 *
 * Tern styles OMP's composer by its roles (`omp.editor`, `omp.composer.*`), so the surface sends the
 * same shape: a `col` with the context meter along its top edge, the input line, then a bar with the
 * model and effort chips, the path and usage facts, the cost, and send or Stop. In native mode OMP
 * has no separate status line, so pi's built-in footer is folded into the bar. pi keeps the git
 * branch, the extension statuses and the provider count only in its footer's data provider, so
 * those are read from the built-in `FooterComponent` by shape. A custom footer from `setFooter` has
 * no such provider and stays rows, rendered by its own component.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SemanticNode, SurfaceHost, TernEvent, TuiComponent } from "./host.ts";

export const FRAME_ID = "kc";
/** Extension statuses, one `text` line under the composer, as pi draws them under its stats line. */
export const STATUSES_ID = "kfx";
export const WORKING_ID = "kw";

/** The part of pi's `FooterDataProvider` the frame reads. */
export interface FooterData {
	getGitBranch(): string | null | undefined;
	getExtensionStatuses(): ReadonlyMap<string, string>;
	getAvailableProviderCount(): number;
}

/** What the built-in footer component holds that the session API does not expose. */
export interface FooterInternals {
	data: FooterData;
	autoCompact: boolean;
}

/** The footer data of pi's built-in footer, or null for a custom footer or an unknown shape. */
export function footerInternals(component: TuiComponent | undefined): FooterInternals | null {
	const footer = component?.children?.length === 1 ? component.children[0] : undefined;
	const candidate = footer as { footerData?: Partial<FooterData>; autoCompactEnabled?: unknown } | undefined;
	const data = candidate?.footerData;
	if (
		typeof data?.getGitBranch !== "function" ||
		typeof data.getExtensionStatuses !== "function" ||
		typeof data.getAvailableProviderCount !== "function"
	) {
		return null;
	}
	return { data: data as FooterData, autoCompact: candidate?.autoCompactEnabled !== false };
}

/** Matches `formatTokens` in pi 1.5.0's footer, so the numbers read the same as in the terminal. */
export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1000000) return `${Math.round(count / 1000)}k`;
	if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
	return `${Math.round(count / 1000000)}M`;
}

export function formatCwd(cwd: string, home: string | undefined): string {
	if (!home) return cwd;
	const fromHome = relative(resolve(home), resolve(cwd));
	const inside = fromHome === "" || (fromHome !== ".." && !fromHome.startsWith(`..${sep}`) && !isAbsolute(fromHome));
	if (!inside) return cwd;
	return fromHome === "" ? "~" : `~${sep}${fromHome}`;
}

interface Usage {
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
	cost?: { total?: number } | number;
}

interface EntryLike {
	type?: string;
	usage?: Usage;
	message?: { role?: string; usage?: Usage };
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	/** Cache hits as a share of the latest reply's prompt, in percent. */
	cacheHit?: number;
}

/** Totals over every saved entry, as pi's footer counts them, so compaction does not reset them. */
export function usageTotals(entries: readonly EntryLike[]): UsageTotals {
	const totals: UsageTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };
	const add = (usage: Usage | undefined) => {
		if (!usage) return;
		totals.input += usage.input ?? 0;
		totals.output += usage.output ?? 0;
		totals.cacheRead += usage.cacheRead ?? 0;
		totals.cacheWrite += usage.cacheWrite ?? 0;
		totals.cost += typeof usage.cost === "number" ? usage.cost : (usage.cost?.total ?? 0);
	};
	for (const entry of entries) {
		if (entry.type === "usage") add(entry.usage);
		else if (entry.type === "message" && entry.message?.role === "assistant") {
			const usage = entry.message.usage;
			add(usage);
			const prompt = (usage?.input ?? 0) + (usage?.cacheRead ?? 0) + (usage?.cacheWrite ?? 0);
			totals.cacheHit = prompt > 0 ? ((usage?.cacheRead ?? 0) / prompt) * 100 : undefined;
		} else if (entry.type === "message" && entry.message?.role === "toolResult") add(entry.message.usage);
		else if (entry.type === "branch_summary" || entry.type === "compaction") add(entry.usage);
	}
	return totals;
}

/** Strips control characters and SGR codes, because a span draws its text literally. */
export function plainStatus(text: string): string {
	return text
		.replace(/\x1b\[[0-9;]*m/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}

/** Everything the frame shows, gathered so the node building is a pure function. */
export interface FrameState {
	cwd: string;
	branch?: string | null;
	sessionName?: string;
	usage: UsageTotals;
	context?: { percent: number | null; contextWindow: number } | null;
	contextWindow: number;
	autoCompact: boolean;
	model?: { id: string; provider: string; reasoning?: boolean };
	thinkingLevel?: string;
	providerCount: number;
	running: boolean;
}

function seg(key: string, props: Record<string, unknown>): SemanticNode {
	return { id: `${FRAME_ID}-${key}`, k: "seg", p: { role: `pi.footer.${key}`, ...props } };
}

/** The bar's flexible facts. Tern drops the lowest priority first: the counters, then the session name and the branch. */
function extras(state: FrameState): SemanticNode {
	const segs: SemanticNode[] = [];
	// Tern draws the pane's directory itself beside the bar (its place chip), so only the branch and the session name are sent.
	if (state.branch) segs.push(seg("branch", { side: "left", priority: 5, icon: "branch", spans: [{ t: state.branch, s: "dim" }] }));
	if (state.sessionName) segs.push(seg("session", { side: "left", priority: 4, spans: [{ t: state.sessionName, s: "dim" }] }));
	const { usage } = state;
	const counters: [string, string, number][] = [
		["input", "↑", usage.input],
		["output", "↓", usage.output],
		["cache-read", "R", usage.cacheRead],
		["cache-write", "W", usage.cacheWrite],
	];
	for (const [key, glyph, amount] of counters) {
		if (amount) segs.push(seg(key, { side: "left", priority: 1, spans: [{ t: `${glyph}${formatTokens(amount)}`, s: "dim" }] }));
	}
	if ((usage.cacheRead > 0 || usage.cacheWrite > 0) && usage.cacheHit !== undefined) {
		segs.push(seg("cache-hit", { side: "left", priority: 1, spans: [{ t: `CH${usage.cacheHit.toFixed(1)}%`, s: "dim" }] }));
	}
	return { id: `${FRAME_ID}-extras`, k: "status", p: { role: "omp.composer.extras", grow: 1 }, c: segs };
}

/** The context meter along the composer's top edge, with pi's 70% and 90% warning points. */
function contextMeter(state: FrameState): SemanticNode {
	const window = state.context?.contextWindow ?? state.contextWindow;
	const percent = state.context?.percent;
	const known = percent !== null && percent !== undefined;
	const shown = known ? `${percent.toFixed(1)}%` : "?";
	const p: Record<string, unknown> = {
		role: "omp.composer.context",
		value: known ? Math.min(1, percent / 100) : null,
		style: "bar",
		thresholds: { warn: 0.7, bad: 0.9 },
		title: `Context ${shown} of ${formatTokens(window)}${state.autoCompact ? " · auto-compact on" : ""}`,
	};
	if (known) p.label = `${Math.round(percent)}%`;
	if (window > 0) p.total = formatTokens(window);
	return { id: `${FRAME_ID}-context`, k: "meter", p };
}

function modelChip(state: FrameState): SemanticNode {
	const model = state.model;
	const title = model ? `${model.provider}/${model.id} · switch model` : "Switch model";
	return {
		id: `${FRAME_ID}-model`,
		k: "row",
		p: { role: "omp.composer.model", gap: "xs", align: "center", title, actions: { click: "status.model" } },
		c: [
			{ id: `${FRAME_ID}-model-icon`, k: "icon", p: { name: "model" } },
			{ id: `${FRAME_ID}-model-name`, k: "text", p: { text: model?.id || "no-model", wrap: "none" } },
			{ id: `${FRAME_ID}-model-chev`, k: "icon", p: { name: "chev" } },
		],
	};
}

function effortChip(level: string): SemanticNode {
	return {
		id: `${FRAME_ID}-effort`,
		k: "row",
		p: { role: "omp.composer.effort", gap: "xs", align: "center", title: "Thinking effort · cycle", actions: { click: "thinking.cycle" } },
		c: [
			{ id: `${FRAME_ID}-effort-glyph`, k: "effort", p: { level } },
			{ id: `${FRAME_ID}-effort-level`, k: "text", p: { text: level, wrap: "none" } },
		],
	};
}

function submitControl(running: boolean): SemanticNode {
	return running
		? { id: `${FRAME_ID}-stop`, k: "text", p: { role: "omp.composer.stop", text: "Stop", tone: "error", title: "Stop  Esc", actions: { click: "interrupt" } } }
		: { id: `${FRAME_ID}-send`, k: "kbd", p: { role: "omp.composer.send", keys: ["enter"], title: "Send  Enter", actions: { click: "submit" } } };
}

/** OMP's composer around the editor's nodes. */
export function frameNode(state: FrameState, editor: SemanticNode[]): SemanticNode {
	const bar: SemanticNode[] = [modelChip(state)];
	if (state.model?.reasoning) bar.push(effortChip(state.thinkingLevel || "off"));
	bar.push(extras(state));
	if (state.usage.cost > 0) {
		bar.push({ id: `${FRAME_ID}-usage`, k: "text", p: { role: "omp.composer.usage", text: `$${state.usage.cost.toFixed(3)}`, wrap: "none" } });
	}
	bar.push(submitControl(state.running));
	return {
		id: FRAME_ID,
		k: "col",
		p: state.running ? { role: "omp.editor", tone: "pending" } : { role: "omp.editor" },
		c: [
			contextMeter(state),
			{ id: `${FRAME_ID}-line`, k: "row", p: { role: "omp.composer.line", align: "start", gap: "sm" }, c: editor },
			{ id: `${FRAME_ID}-bar`, k: "row", p: { role: "omp.composer.bar", gap: "sm", align: "center" }, c: bar },
		],
	};
}

/** Extension statuses as one plain line, sorted by key as pi sorts them. */
export function statusesNode(statuses: ReadonlyMap<string, string>): SemanticNode | null {
	const text = Array.from(statuses.entries())
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, value]) => plainStatus(value))
		.filter((value) => value.length > 0)
		.join(" ");
	return text ? { id: STATUSES_ID, k: "text", p: { text, wrap: "none", truncate: "end", role: "pi.footer.statuses" } } : null;
}

/** pi's message for its working indicator (`defaultWorkingMessage` in pi 1.5.0). */
export const WORKING_TEXT = "Working";

/** OMP's working row. Tern ticks `elapsed` itself, so `age` only moves in whole seconds. */
export function workingRow(startedAt: number, now: number): SemanticNode {
	const age = Math.max(0, Math.floor((now - startedAt) / 1000) * 1000);
	return {
		id: WORKING_ID,
		k: "row",
		p: { role: "omp.working", align: "center", gap: "sm" },
		c: [
			{ id: `${WORKING_ID}-spin`, k: "spinner", p: { style: "starburst", tone: "accent" } },
			{ id: `${WORKING_ID}-age`, k: "elapsed", p: { age } },
			{ id: `${WORKING_ID}-sep`, k: "text", p: { text: "·", role: "omp.working.sep" } },
			{ id: `${WORKING_ID}-label`, k: "shimmer", p: { text: WORKING_TEXT, role: "omp.working.label" } },
			{ id: `${WORKING_ID}-fill`, k: "row", p: { grow: 1 } },
			{
				id: `${WORKING_ID}-stop`,
				k: "row",
				p: { role: "omp.working.stop", gap: "xs", align: "center", title: "Stop  Esc", actions: { click: "interrupt" } },
				c: [
					{ id: `${WORKING_ID}-stop-key`, k: "kbd", p: { keys: ["escape"] } },
					{ id: `${WORKING_ID}-stop-text`, k: "text", p: { text: "Stop" } },
				],
			},
		],
	};
}

/** pi's thinking levels in cycle order. pi clamps each to what the model supports. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export interface Frame {
	/** The framed composer, the statuses line, and whether pi's footer rows are still needed. */
	describe(editor: SemanticNode[], footer: TuiComponent | undefined, running: boolean): { nodes: SemanticNode[]; footerRows: boolean };
	/** True when the event was a click on the frame or the working row. */
	onEvent(event: TernEvent): boolean;
}

/** Called once at extension load inside the native surface. `submit` sends the composer's draft. */
export function createFrame(pi: ExtensionAPI, host: SurfaceHost, submit: () => void): Frame {
	let ctx: ExtensionContext | null = null;
	let warned = false;
	const logOnce = (message: string) => {
		if (warned) return;
		warned = true;
		host.log(message);
	};
	// pi redraws after a turn, which repaints the surface. These changes may not.
	const repaint = (_event: unknown, next: ExtensionContext) => {
		ctx = next;
		host.invalidate();
	};
	const track = (_event: unknown, next: ExtensionContext) => {
		ctx = next;
	};
	pi.on("session_start", repaint);
	pi.on("session_info_changed", repaint);
	pi.on("session_compact", repaint);
	pi.on("model_select", repaint);
	pi.on("thinking_level_select", repaint);
	pi.on("turn_end", track);
	pi.on("agent_end", track);

	const cycleThinking = () => {
		const current = pi.getThinkingLevel();
		const at = THINKING_LEVELS.indexOf(current as (typeof THINKING_LEVELS)[number]);
		for (const next of [...THINKING_LEVELS.slice(at + 1), ...THINKING_LEVELS.slice(0, Math.max(0, at))]) {
			pi.setThinkingLevel(next);
			// A level the model does not support clamps back, so keep going until it moves.
			if (pi.getThinkingLevel() !== current) return;
		}
	};

	const pickModel = async () => {
		const context = ctx;
		if (!context?.hasUI) return;
		const scoped = context.scopedModels?.map((entry) => entry.model) ?? [];
		const models = scoped.length > 0 ? scoped : await Promise.resolve(context.modelRegistry.getAvailable());
		if (models.length === 0) return;
		const label = (model: { provider: string; id: string }) => `${model.provider}/${model.id}`;
		const choice = await context.ui.select("Switch model", models.map(label));
		const model = models.find((candidate) => label(candidate) === choice);
		if (model && !(await pi.setModel(model))) context.ui.notify(`No credentials for ${label(model)}`, "error");
	};

	return {
		describe(editor, footer, running) {
			const internals = footerInternals(footer);
			if (!internals) logOnce("frame: pi's footer is not the built-in one, so it stays rows");
			if (editor.length === 0 || !ctx) return { nodes: editor, footerRows: true };
			try {
				const sessionManager = ctx.sessionManager;
				const model = ctx.model as { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
				const frame = frameNode(
					{
						cwd: formatCwd(sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
						branch: internals?.data.getGitBranch(),
						sessionName: sessionManager.getSessionName(),
						usage: usageTotals(sessionManager.getEntries() as unknown as EntryLike[]),
						context: ctx.getContextUsage() as FrameState["context"],
						contextWindow: model?.contextWindow ?? 0,
						autoCompact: internals?.autoCompact ?? true,
						model,
						thinkingLevel: pi.getThinkingLevel(),
						providerCount: internals?.data.getAvailableProviderCount() ?? 1,
						running,
					},
					editor,
				);
				const statuses = internals ? statusesNode(internals.data.getExtensionStatuses()) : null;
				return { nodes: statuses ? [frame, statuses] : [frame], footerRows: !internals };
			} catch (error) {
				logOnce(`frame: the composer frame failed, so pi's footer stays rows: ${error instanceof Error ? error.message : String(error)}`);
				return { nodes: editor, footerRows: true };
			}
		},
		onEvent(event) {
			if (event.ev !== "action" || typeof event.id !== "string") return false;
			if (!event.id.startsWith(`${FRAME_ID}-`) && !event.id.startsWith(`${WORKING_ID}-`)) return false;
			switch (event.act) {
				case "submit":
					submit();
					break;
				case "interrupt":
					ctx?.abort();
					break;
				case "thinking.cycle":
					cycleThinking();
					break;
				case "status.model":
					pickModel().catch((error) => host.log(`frame: model switch failed: ${error instanceof Error ? error.message : String(error)}`));
					break;
				default:
					return false;
			}
			return true;
		},
	};
}
