/**
 * Transcript area (`main`): the session's messages, thinking and tool calls as semantic nodes.
 *
 * Built in #10 from session events and stored entries (ADR 0001), with notices from the
 * `chatContainer` walk (ADR 0002) and describers from the event bus (ADR 0003).
 * Until then it is a row fallback: the tail of pi's document container, rendered by pi itself.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { piSlot, renderRows, type SemanticNode, type SurfaceHost, type TernEvent } from "./host.ts";

export interface Transcript {
	/** The children of `main`. */
	describe(cols: number): SemanticNode[];
	/** True when the event was for a transcript node, such as a card `toggle`. */
	onEvent(event: TernEvent): boolean;
}

/** Called once at extension load inside the native surface. Register `pi.on` handlers here. */
export function createTranscript(_pi: ExtensionAPI, host: SurfaceHost): Transcript {
	return {
		describe(cols) {
			// One screen of the newest lines, as pi's own viewport would show, so a frame stays small.
			const height = Math.max(5, process.stdout.rows || 24);
			const lines = renderRows(piSlot(host.tui(), "document"), cols).slice(-height);
			return lines.length > 0 ? [{ id: "xrows", k: "rows", p: { cols, lines } }] : [];
		},
		onEvent: () => false,
	};
}
