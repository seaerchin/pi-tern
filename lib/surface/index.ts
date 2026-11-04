/**
 * The full surface: pi's session as semantic nodes in a native surface.
 *
 * It loads with the pi-tern extension and stays inert unless pi was started by the native
 * launcher in semantic mode. Each area is its own module, so the areas can change independently:
 *
 *   transcript.ts  `main`   messages, thinking and tool calls (#10)
 *   composer.ts    `dock`   the `editor` node, and its autocomplete overlay in `layer` (#11)
 *   dock.ts        `dock`   pi's other dock containers around the composer (#12)
 *   dialogs.ts     `layer`  built-in dialogs as overlays (#16)
 *
 * The sink in `native/backend.mjs` owns the surface, the frames and the tree diff. This module only
 * assembles the areas into one `SemanticSurface` and attaches it.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticSurface } from "../../native/native.d.mts";
import { createComposer } from "./composer.ts";
import { createDialogs } from "./dialogs.ts";
import { createDock } from "./dock.ts";
import { nativeHandle, type SurfaceHost, type TuiComponent } from "./host.ts";
import { createTranscript } from "./transcript.ts";

/** #16 gives dialogs a `focus()`, so an open modal dialog takes the keys ahead of the composer. */
type FocusOwner = { focus?(): string | null };

/** An empty widget whose factory is the supported way to receive pi's TUI root. */
const TUI_WIDGET = "pi-tern-surface";

export function registerNativeSurface(pi: ExtensionAPI): void {
	const handle = nativeHandle();
	if (!handle?.state().semantic) return;

	let tui: TuiComponent | null = null;
	const host: SurfaceHost = { tui: () => tui, invalidate: () => handle.invalidate() };
	const transcript = createTranscript(pi, host);
	const composer = createComposer(pi, host);
	const dock = createDock(pi, host);
	const dialogs = createDialogs(pi, host);

	const surface: SemanticSurface = {
		describe: (cols) => ({
			main: transcript.describe(cols),
			dock: dock.describe(cols, composer.describe(cols)),
			// Dialogs last: a modal dialog sits above the autocomplete list.
			layer: [...composer.overlays(cols), ...dialogs.describe(cols)],
			focus: (dialogs as FocusOwner).focus?.() ?? composer.focus(),
		}),
		editor: () => composer.editor(),
		// Dialogs first: an open modal dialog owns the keys.
		onEvent: (event) => dialogs.onEvent(event) || composer.onEvent(event) || transcript.onEvent(event) || dock.onEvent(event),
	};

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			TUI_WIDGET,
			(root) => {
				tui = root as unknown as TuiComponent;
				handle.attachSurface(surface);
				return { render: () => [], invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
	});
}
