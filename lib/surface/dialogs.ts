/**
 * Dialogs area (`layer`): pi's built-in `select`, `confirm`, `input` and `editor` dialogs as modal
 * overlays.
 *
 * Built in #16: read the dialog in pi's editor slot by shape and answer it through its
 * `handleInput()` (ADR 0002, extended). Until then dialogs show as rows in the dock's editor slot.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticNode, SurfaceHost, TernEvent } from "./host.ts";

export interface Dialogs {
	/** The children of `layer`. Empty while no dialog is open. */
	describe(cols: number): SemanticNode[];
	/** True when the event answered or cancelled a dialog. Dialogs see events before the other areas. */
	onEvent(event: TernEvent): boolean;
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createDialogs(_pi: ExtensionAPI, _host: SurfaceHost): Dialogs {
	return {
		describe: () => [],
		onEvent: () => false,
	};
}
