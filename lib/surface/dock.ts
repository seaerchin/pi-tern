/**
 * Dock area (`dock`): the composer, framed by pi's pending, status, widget and footer containers.
 *
 * Built in #12: those containers as rows rendered by their own components, and a node for the
 * working indicator pi draws in the composer border. This stub is the prototype's dock: rows above
 * the composer, the composer's nodes, rows below. While a dialog holds the editor slot, the slot
 * shows as rows, unless the dialogs area mirrors it as an overlay.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent } from "./host.ts";

export interface Dock {
	/**
	 * The children of `dock`, with the composer's nodes placed where pi's editor slot is.
	 * `dialogShown` leaves the slot empty, because the overlay already shows the dialog there.
	 */
	describe(cols: number, composer: SemanticNode[], dialogShown?: boolean): SemanticNode[];
	/** True when the event was for a dock node. */
	onEvent(event: TernEvent): boolean;
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createDock(_pi: ExtensionAPI, host: SurfaceHost): Dock {
	return {
		describe(cols, composer, dialogShown = false) {
			const tui = host.tui();
			if (!tui) return [];
			const nodes: SemanticNode[] = [];
			const above = (["pending", "status", "widgetsAbove"] as const)
				.flatMap((slot) => renderRows(piSlot(tui, slot), cols))
				.filter((line) => line.trim() !== "");
			if (above.length > 0) nodes.push({ id: "kt", k: "rows", p: { cols, lines: above } });
			if (composer.length > 0) nodes.push(...composer);
			else if (!dialogShown) nodes.push({ id: "kx", k: "rows", p: { cols, lines: renderRows(piSlot(tui, "editor"), cols) } });
			const below = (["widgetsBelow", "footer"] as const).flatMap((slot) => renderRows(piSlot(tui, slot), cols));
			if (below.length > 0) nodes.push({ id: "kb", k: "rows", p: { cols, lines: below } });
			return nodes;
		},
		onEvent: () => false,
	};
}
