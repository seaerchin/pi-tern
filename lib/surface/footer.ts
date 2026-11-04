/**
 * Pi's footer as a native `status` bar, built from session data instead of the footer's rows.
 *
 * The layout follows OMP's native footer: path and branch, usage, cost and context on the left,
 * the model on the right, and extension statuses as one `text` line below. pi keeps the git branch,
 * the extension statuses and the provider count only in its footer's data provider, so those are
 * read from the built-in `FooterComponent` by shape. A custom footer from `setFooter` has no such
 * provider and stays rows, rendered by its own component.
 */
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SemanticNode, SurfaceHost, TuiComponent } from "./host.ts";

/** The status bar's node id. pi's footer rows used `kf`, so the dock order is unchanged. */
export const FOOTER_ID = "kf";
/** Extension statuses, one `text` line under the bar, as pi draws them under its stats line. */
export const STATUSES_ID = "kfx";

/** The part of pi's `FooterDataProvider` the native footer reads. */
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

/** Everything the bar shows, gathered so the node building is a pure function. */
export interface FooterState {
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
	statuses: ReadonlyMap<string, string>;
}

type Span = { t: string; s?: string };

function seg(key: string, props: Record<string, unknown>): SemanticNode {
	return { id: `${FOOTER_ID}-${key}`, k: "seg", p: { role: `pi.footer.${key}`, ...props } };
}

/**
 * The bar and the statuses line. Tern drops the lowest priority first when the bar is short of room:
 * the token counters, then the provider, the cost, the model, the path and the context last.
 */
export function footerNodes(state: FooterState): SemanticNode[] {
	const segs: SemanticNode[] = [];
	const path: Span[] = [{ t: state.cwd, s: "path dim" }];
	if (state.branch) path.push({ t: ` (${state.branch})`, s: "dim" });
	if (state.sessionName) path.push({ t: ` • ${state.sessionName}`, s: "dim" });
	segs.push(seg("path", { side: "left", priority: 5, icon: "folder", spans: path }));

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
	if (usage.cost > 0) segs.push(seg("cost", { side: "left", priority: 3, spans: [{ t: `$${usage.cost.toFixed(3)}`, s: "dim" }] }));

	const window = state.context?.contextWindow ?? state.contextWindow;
	const percent = state.context?.percent;
	const shown = percent === null || percent === undefined ? "?" : `${percent.toFixed(1)}%`;
	const level = (percent ?? 0) > 90 ? "error" : (percent ?? 0) > 70 ? "warning" : undefined;
	const context: Record<string, unknown> = {
		side: "left",
		priority: 6,
		icon: "context",
		spans: [{ t: `${shown}/${formatTokens(window)}${state.autoCompact ? " (auto)" : ""}`, s: level ?? "dim" }],
	};
	if (level) context.tone = level;
	segs.push(seg("context", context));

	const model = state.model;
	let label = model?.id || "no-model";
	if (model?.reasoning) label += state.thinkingLevel && state.thinkingLevel !== "off" ? ` • ${state.thinkingLevel}` : " • thinking off";
	// pi shows the provider only while it fits, so it is its own segment that Tern can drop.
	if (model && state.providerCount > 1) segs.push(seg("provider", { side: "right", priority: 2, spans: [{ t: `(${model.provider})`, s: "dim" }] }));
	segs.push(seg("model", { side: "right", priority: 4, icon: "model", spans: [{ t: label, s: "dim" }] }));

	const nodes: SemanticNode[] = [{ id: FOOTER_ID, k: "status", p: { role: "pi.footer" }, c: segs }];
	if (state.statuses.size > 0) {
		const text = Array.from(state.statuses.entries())
			.sort(([a], [b]) => a.localeCompare(b))
			.map(([, value]) => plainStatus(value))
			.filter((value) => value.length > 0)
			.join(" ");
		if (text) nodes.push({ id: STATUSES_ID, k: "text", p: { text, wrap: "none", truncate: "end", role: "pi.footer.statuses" } });
	}
	return nodes;
}

export interface Footer {
	/** The native footer, or null when pi's footer must stay rows. */
	describe(component: TuiComponent | undefined): SemanticNode[] | null;
}

/** Called once at extension load inside the native surface. */
export function createFooter(pi: ExtensionAPI, host: SurfaceHost): Footer {
	let ctx: ExtensionContext | null = null;
	let warned = false;
	// pi redraws its own footer after a turn, which repaints the surface. These changes may not.
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

	return {
		describe(component) {
			const internals = footerInternals(component);
			if (!internals || !ctx) {
				if (!internals && component && !warned) {
					warned = true;
					host.log("footer: pi's footer is not the built-in one, so it stays rows");
				}
				return null;
			}
			try {
				const sessionManager = ctx.sessionManager;
				const model = ctx.model as { id: string; provider: string; reasoning?: boolean; contextWindow?: number } | undefined;
				return footerNodes({
					cwd: formatCwd(sessionManager.getCwd(), process.env.HOME || process.env.USERPROFILE),
					branch: internals.data.getGitBranch(),
					sessionName: sessionManager.getSessionName(),
					usage: usageTotals(sessionManager.getEntries() as unknown as EntryLike[]),
					context: ctx.getContextUsage() as FooterState["context"],
					contextWindow: model?.contextWindow ?? 0,
					autoCompact: internals.autoCompact,
					model,
					thinkingLevel: pi.getThinkingLevel(),
					providerCount: internals.data.getAvailableProviderCount(),
					statuses: internals.data.getExtensionStatuses(),
				});
			} catch (error) {
				if (!warned) {
					warned = true;
					host.log(`footer: native footer failed, so it stays rows: ${error instanceof Error ? error.message : String(error)}`);
				}
				return null;
			}
		},
	};
}
