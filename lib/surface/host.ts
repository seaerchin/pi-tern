/**
 * Shared types and helpers for the full surface's areas.
 *
 * Each area (transcript, composer, dock, dialogs) is one module with one factory. The areas never
 * import each other or the sink. They get a `SurfaceHost` and return nodes from `describe`.
 */
import type { NativeHandle, SemanticNode } from "../../native/native.d.mts";

export type { SemanticNode };

/** A Tern event as the sink decoded it, such as `{ ev: "select", id, item }`. */
export type TernEvent = Record<string, unknown>;

/**
 * A pi-tui component as the areas read it. Only `children` and `render()` are used, as ADR 0002
 * allows. Anything else on a component is a pi internal and needs its own decision.
 */
export interface TuiComponent {
	render(width: number): string[];
	children?: TuiComponent[];
}

/** What every area gets from the surface. */
export interface SurfaceHost {
	/** pi's TUI root, or null before the session starts. */
	tui(): TuiComponent | null;
	/** Repaint soon. Call it when state changed that pi itself does not redraw. */
	invalidate(): void;
}

/**
 * Where interactive mode mounts its seven containers on the TUI root, in both the regular and the
 * fullscreen renderer (`InteractiveMode.init()` in pi 1.5.0).
 */
export const PI_SLOTS = {
	document: 0,
	pending: 1,
	status: 2,
	widgetsAbove: 3,
	editor: 4,
	widgetsBelow: 5,
	footer: 6,
} as const;

export function piSlot(tui: TuiComponent | null, slot: keyof typeof PI_SLOTS): TuiComponent | undefined {
	return tui?.children?.[PI_SLOTS[slot]];
}

/** A component's own rendering, for the row fallback. A throwing component renders nothing. */
export function renderRows(component: TuiComponent | undefined, cols: number): string[] {
	try {
		return component ? component.render(cols) : [];
	} catch {
		return [];
	}
}

/** The sink's handle, only in a pi started by the native launcher and still drawing a surface. */
export function nativeHandle(): NativeHandle | undefined {
	const handle = (globalThis as { __piTernNative?: NativeHandle }).__piTernNative;
	if (typeof handle?.attachSurface !== "function") return undefined;
	try {
		return handle.state().active ? handle : undefined;
	} catch {
		return undefined;
	}
}
