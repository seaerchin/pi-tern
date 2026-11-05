/**
 * Loader transform (native mode only).
 *  - pi-tui terminal.js: wrap ProcessTerminal.write into the TSP sink and
 *    filter TSP `e` events out of pty input.
 *  - pi-tui editor.js / pi custom-editor.js: register the editor classes so the
 *    sink can capture the live composer and publish a native `editor` node.
 * Fail-open: any sink error falls back to the original ANSI write.
 *
 * Only the launched release's own packages are patched. Extensions such as pi-subagents import a
 * second copy of pi-tui from ~/.pi/agent/npm, and patching that copy created a second sink. It
 * opened a second surface and took over the global handle, so semantic repaints went to a sink
 * pi never draws through.
 */
const backendUrl = new URL("./backend.mjs", import.meta.url).href;

const TERMINAL_PATCH = `
import { createNativeSink as __createNativeSink } from ${JSON.stringify(backendUrl)};
// The handle is the process-wide singleton: a second copy of this module must not open a second surface.
if (process.env.PI_TERN_NATIVE === "1" && typeof ProcessTerminal === "function" && !globalThis.__piTernNative) {
  const __hello = (() => { try { return JSON.parse(process.env.PI_TERN_HELLO || "{}"); } catch { return {}; } })();
  const __sink = __createNativeSink({
    hello: __hello,
    recordPath: process.env.PI_TERN_TSP_RECORD,
    adopt: process.env.PI_TERN_ADOPT === "1",
    surfaceId: process.env.PI_TERN_SURFACE_ID || undefined,
  });
  const __origWrite = ProcessTerminal.prototype.write;
  ProcessTerminal.prototype.write = function (data) {
    // 'active === false' means the surface was handed back (wrong block kind, or a sink failure):
    // pi's own ANSI must reach the grid again, or the pane stays blank forever.
    if (__sink.active === false) return __origWrite.call(this, data);
    try {
      __sink.feed(String(data));
    } catch {
      __sink.active = false;
      return __origWrite.call(this, data);
    }
  };
  const __origStart = ProcessTerminal.prototype.start;
  ProcessTerminal.prototype.start = function (onInput, onResize) {
    const wrapped = (data) => {
      if (typeof data !== "string" || __sink.active === false) return onInput(data);
      let rest = data;
      try { rest = __sink.handleInput(data); } catch { rest = data; }
      if (rest) onInput(rest);
    };
    return __origStart.call(this, wrapped, onResize);
  };
  globalThis.__piTernNative = {
    state: () => __sink.nativeState(),
    suspend: () => __sink.suspend(),
    resume: () => __sink.resume(),
    // The full surface in lib/surface/ reaches the sink through these three only.
    attachSurface: (surface) => __sink.active !== false && __sink.attachSurface(surface),
    invalidate: () => __sink.invalidate(),
    blob: (data, mime) => (__sink.active !== false ? __sink.blob(data, mime) : undefined),
    // index.ts and other extensions show panels in Tern's right-edge sheet through these.
    aside: (input) => (__sink.active !== false ? __sink.aside(input) : { ok: false, reason: "native surface is inactive" }),
    showAside: () => (__sink.active !== false ? __sink.showAside() : { ok: false, reason: "native surface is inactive" }),
    hideAside: () => (__sink.active !== false ? __sink.hideAside() : { ok: false, reason: "native surface is inactive" }),
    /**
     * Give the pane back to pi's own TUI and stop drawing a surface.
     *
     * This is the escape hatch for the one case that used to fail silently: Tern only DISPLAYS a TSP
     * surface in an *agent* block. In a shell block the frames are accepted and the surface
     * materialises, but nothing is ever drawn — so the pane goes blank with no error anywhere. The
     * extension detects that (via the plugin's pane kind) and calls this, which puts pi's ANSI back
     * on the grid so the session is usable and the warning is readable.
     */
    fallback: (reason) => {
      try { __sink.close(); } catch {}
      __sink.active = false;
      globalThis.__piTernNativeFellBack = reason || "native surfaces are not displayed here";
      return true;
    },
  };
  process.once("exit", () => { try { __sink.close(); } catch {} });
}
`;

const EDITOR_CAPTURE = `
try { globalThis.__piTernEditorBase = Editor; } catch {}
`;

const CUSTOM_EDITOR_CAPTURE = `
try { globalThis.__piTernEditorClass = CustomEditor; } catch {}
`;

/** URL prefix of the release's `node_modules`, set by `register-hook.mjs`. Empty patches every copy. */
let scope = "";

export function initialize(data) {
	scope = typeof data?.scope === "string" ? data.scope : "";
}

/** The patched source for `url`, or null when the module is left alone. */
export function transformSource(url, source, releaseScope = scope) {
	if (releaseScope && !url.startsWith(releaseScope)) return null;
	if (url.includes("/@earendil-works/pi-tui/dist/terminal.js")) return `${source}\n${TERMINAL_PATCH}`;
	if (url.includes("/@earendil-works/pi-tui/dist/components/editor.js")) return `${source}\n${EDITOR_CAPTURE}`;
	if (url.includes("/pi-coding-agent/dist/modes/interactive/components/custom-editor.js")) {
		return `${source}\n${CUSTOM_EDITOR_CAPTURE}`;
	}
	return null;
}

export async function load(url, context, next) {
	const result = await next(url, context);
	if (result.format !== "module") return result;
	const patched = transformSource(url, String(result.source));
	return patched === null ? result : { ...result, source: patched };
}
