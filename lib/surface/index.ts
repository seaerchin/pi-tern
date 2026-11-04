/**
 * The full surface: pi's session as semantic nodes in a native surface.
 *
 * It loads with the pi-tern extension and stays inert unless pi was started by the native
 * launcher in semantic mode. Each area is its own module, so the areas can change independently:
 *
 *   transcript.ts  `main`   messages, thinking and tool calls (#10)
 *   composer.ts    `dock`   the `editor` node, and its autocomplete overlay in `layer` (#11)
 *   dock.ts        `dock`   pi's other dock containers around the composer (#12)
 *   frame.ts       `dock`   OMP's composer frame, carrying pi's footer
 *   dialogs.ts     `layer`  built-in dialogs as overlays (#16)
 *   describers.ts           the describer registry on pi's event bus (#17, ADR 0003)
 *   subagents.ts            the built-in describer for pi-subagents' `subagent` tool (#17)
 *
 * The sink in `native/backend.mjs` owns the surface, the frames and the tree diff. This module only
 * assembles the areas into one `SemanticSurface` and attaches it.
 */
import { appendFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SemanticSurface } from "../../native/native.d.mts";
import { createComposer } from "./composer.ts";
import { connectDescribers, createDescriberRegistry, helloKinds, type DescriberReport } from "./describers.ts";
import { createDialogs } from "./dialogs.ts";
import { createDock } from "./dock.ts";
import { nativeHandle, type SurfaceHost, type TuiComponent } from "./host.ts";
import { describeSubagent, SUBAGENT_TOOL } from "./subagents.ts";
import { createTranscript } from "./transcript.ts";

/** Areas log to the sink's frame record, so a render check shows them next to the frames. */
function recordSurfaceLog(message: string): void {
	const recordPath = process.env.PI_TERN_TSP_RECORD;
	if (!recordPath) return;
	try {
		appendFileSync(recordPath, `${JSON.stringify({ t: Date.now(), dir: "log", verb: "surface-log", params: {}, body: message })}\n`);
	} catch {
		/* logging is best effort */
	}
}

/** An empty widget whose factory is the supported way to receive pi's TUI root. */
const TUI_WIDGET = "pi-tern-surface";

/** What the full surface offers the rest of the extension, such as `/tern diagnose`. */
export interface NativeSurface {
	describers(): DescriberReport;
}

export function registerNativeSurface(pi: ExtensionAPI): NativeSurface | undefined {
	const handle = nativeHandle();
	if (!handle?.state().semantic) return undefined;

	let tui: TuiComponent | null = null;
	const host: SurfaceHost = {
		tui: () => tui,
		invalidate: () => handle.invalidate(),
		log: recordSurfaceLog,
		blob: (data, mime) => (typeof handle.blob === "function" ? handle.blob(data, mime) : undefined),
	};
	const kinds = helloKinds();
	const describers = createDescriberRegistry({ kinds, log: recordSurfaceLog });
	describers.register({ kind: "tool", key: SUBAGENT_TOOL, source: "builtin", describe: describeSubagent });
	connectDescribers(pi, host, describers, kinds);
	const transcript = createTranscript(pi, host, describers);
	const composer = createComposer(pi, host);
	const dock = createDock(pi, host, () => composer.submit());
	const dialogs = createDialogs(pi, host);

	const surface: SemanticSurface = {
		describe(cols) {
			const layer = dialogs.describe(cols);
			const composerNodes = composer.describe(cols);
			return {
				main: transcript.describe(cols),
				dock: dock.describe(cols, composerNodes, layer.length > 0),
				// Dialogs last: a modal dialog sits above the autocomplete list.
				layer: [...composer.overlays(cols), ...layer],
				focus: dialogs.focus?.() ?? composer.focus(),
			};
		},
		editor: () => composer.editor(),
		// Dialogs first: an open modal dialog owns the keys.
		onEvent: (event) =>
			dialogs.onEvent(event) || composer.onEvent(event) || describers.onEvent(event) || transcript.onEvent(event) || dock.onEvent(event),
		rejected: (nodeId, message) => describers.rejected(nodeId, message),
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
	return { describers: () => describers.report() };
}
