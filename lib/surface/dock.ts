/**
 * Dock area (`dock`): the composer in OMP's frame, with pi's pending, status and widget containers.
 *
 * Each container is rendered by its own components as one `rows` node, in pi's dock order. The
 * composer sits in OMP's `omp.editor` frame (`frame.ts`), whose bar carries pi's built-in footer, so
 * the footer gets no rows of its own. pi draws its working indicator in the composer's top border,
 * which the `editor` node replaces, so the working state shows as OMP's working row in the status
 * container's place. While a dialog holds the editor slot, the slot shows as rows, unless the dialogs
 * area mirrors it as an overlay.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createFrame, workingRow } from "./frame.ts";
import { PI_SLOTS, piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent, type TuiComponent } from "./host.ts";

export { WORKING_TEXT } from "./frame.ts";

export interface Dock {
	/**
	 * The children of `dock`, with the composer's nodes placed where pi's editor slot is.
	 * `dialogShown` leaves the slot empty, because the overlay already shows the dialog there.
	 */
	describe(cols: number, composer: SemanticNode[], dialogShown?: boolean): SemanticNode[];
	/** True when the event was for a dock node. */
	onEvent(event: TernEvent): boolean;
}

/** Node ids for pi's dock containers. They stay stable so the tree diff sends only `set` ops. */
const ROWS_ID = {
	pending: "kp",
	status: "ks",
	widgetsAbove: "kwa",
	widgetsBelow: "kwb",
	footer: "kf",
} as const satisfies Partial<Record<keyof typeof PI_SLOTS, string>>;

/**
 * A container's rows without its blank edges. pi pads idle and loader rows with blank lines that
 * only spaced the terminal layout, and an all-blank container gets no node.
 */
export function containerRows(component: TuiComponent | undefined, cols: number): string[] {
	const lines = renderRows(component, cols);
	const blank = (line: string) => line.replace(/\x1b\[[0-9;]*m/g, "").trim() === "";
	let start = 0;
	let end = lines.length;
	while (start < end && blank(lines[start])) start += 1;
	while (end > start && blank(lines[end - 1])) end -= 1;
	return lines.slice(start, end);
}

/** Called once at extension load inside the native surface. `submit` sends the composer's draft. */
export function createDock(pi: ExtensionAPI, host: SurfaceHost, submit: () => void = () => {}): Dock {
	// Session events are the supported signal for a run. pi's indicator object is an editor internal.
	let startedAt: number | null = null;
	const setWorking = (next: boolean) => {
		if ((startedAt !== null) === next) return;
		startedAt = next ? Date.now() : null;
		host.invalidate();
	};
	pi.on("agent_start", () => setWorking(true));
	pi.on("turn_start", () => setWorking(true));
	pi.on("agent_end", () => setWorking(false));
	const frame = createFrame(pi, host, submit);

	return {
		describe(cols, composer, dialogShown = false) {
			const tui = host.tui();
			if (!tui) return [];
			const nodes: SemanticNode[] = [];
			const pushRows = (slot: keyof typeof ROWS_ID) => {
				const lines = containerRows(piSlot(tui, slot), cols);
				if (lines.length > 0) nodes.push({ id: ROWS_ID[slot], k: "rows", p: { cols, lines } });
			};
			pushRows("pending");
			const statusCount = nodes.length;
			pushRows("status");
			// An editor that does not embed the indicator leaves pi's own loader in the status container.
			if (startedAt !== null && nodes.length === statusCount) nodes.push(workingRow(startedAt, Date.now()));
			pushRows("widgetsAbove");
			const framed = frame.describe(composer, piSlot(tui, "footer"), startedAt !== null);
			if (composer.length > 0) nodes.push(...framed.nodes);
			else if (!dialogShown) nodes.push({ id: "kx", k: "rows", p: { cols, lines: renderRows(piSlot(tui, "editor"), cols) } });
			pushRows("widgetsBelow");
			if (framed.footerRows) pushRows("footer");
			return nodes;
		},
		onEvent: (event) => frame.onEvent(event),
	};
}
