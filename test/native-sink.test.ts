/**
 * Frame-ops test for the native sink.
 *
 * This drives the real sink with a fake stdout and asserts the exact wire shapes, so the
 * encodings verified against Tern (`docs/TSP-ENCODINGS.md`) cannot silently regress — in
 * particular the `blob` op, which Tern rejects with `unknown op blob` and 1.1.0 shipped.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createNativeSink } from "../native/backend.mjs";
import { nodeOf } from "../native/tsp.mjs";
import type { FrameNode, FrameOp, SemanticRegions, SemanticSurface } from "../native/native.d.mts";

/** One decoded frame as captured off the pty. */
type CapturedFrame = { verb: string; body?: unknown };

const HELLO = {
	cols: 80,
	rows: 24,
	kinds: ["col", "row", "rows", "md", "image", "chart", "editor", "input", "status"],
	features: ["blobs", "aside", "settle", "scroll", "dock"],
};

/** Capture every frame the sink writes and parse the JSON body of each. */
function capture(): { frames: CapturedFrame[]; restore: () => void } {
	const frames: CapturedFrame[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk) => {
		const text = String(chunk);
		const prefix = "\x1b_tsp;";
		let index = text.indexOf(prefix);
		while (index !== -1) {
			const end = text.indexOf("\x1b\\", index);
			if (end === -1) break;
			const inner = text.slice(index + prefix.length, end);
			const semi = inner.indexOf(";");
			const verb = semi === -1 ? inner : inner.slice(0, semi);
			const brace = inner.indexOf("{", semi + 1);
			if (brace !== -1) {
				try {
					frames.push({ verb, body: JSON.parse(inner.slice(brace)) });
				} catch {
					/* ignore */
				}
			}
			index = text.indexOf(prefix, end + 2);
		}
		return true;
	}) as typeof process.stdout.write;
	return {
		frames,
		restore: () => {
			process.stdout.write = original;
		},
	};
}

function ops(frames: CapturedFrame[]): FrameOp[] {
	return frames.flatMap((frame) => {
		if (frame.verb !== "f") return [];
		const body = frame.body as { ops?: FrameOp[] } | undefined;
		return body?.ops ?? [];
	});
}

test("the sink opens one inline surface and adds region roots under the surface id", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.markdown({ text: "# hello" });
		const open = cap.frames.find((frame) => frame.verb === "o");
		assert.ok(open, "an open frame was sent");
		const body = open.body as { id?: string; mode?: string; listen?: boolean };
		assert.equal(body.id, "test1");
		assert.equal(body.mode, "inline");
		assert.equal(body.listen, true, "semantic mode listens, or Tern sends no clicks");
		const adds = ops(cap.frames).filter((op) => op[0] === "add");
		assert.ok(
			adds.some((op) => op[1] === "main" && op[2] === "test1"),
			"the main region is added under the surface id (the M1 addressing bug)",
		);
	} finally {
		cap.restore();
	}
});

test("markdown emits an md node, never a blob op", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const result = sink.markdown({ text: "**bold**", id: "x1" });
		assert.equal(result.ok, true);
		const all = ops(cap.frames);
		assert.equal(all.filter((op) => op[0] === "blob").length, 0, "blob is not a frame op");
		const add = all.find((op) => op[0] === "add" && nodeOf(op)?.k === "md");
		assert.ok(add, "an md node was added");
		const node = nodeOf(add);
		assert.equal(node?.p?.text, "**bold**");
	} finally {
		cap.restore();
	}
});

test("figure is opt-in and, when enabled, carries inline image bytes", () => {
	const cap = capture();
	const previous = process.env.PI_TERN_INLINE_IMAGES;
	try {
		delete process.env.PI_TERN_INLINE_IMAGES;
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const refused = sink.figure({ data: "AAAA" });
		assert.equal(refused.ok, false);
		process.env.PI_TERN_INLINE_IMAGES = "1";
		const allowed = sink.figure({ data: "AAAA", mime: "image/png" });
		assert.equal(allowed.ok, true);
		const all = ops(cap.frames);
		assert.equal(all.filter((op) => op[0] === "blob").length, 0, "still no blob op");
		const image = all.find((op) => nodeOf(op)?.k === "image");
		assert.ok(image, "an image node was added");
		assert.equal(nodeOf(image)?.p?.data, "AAAA");
		assert.equal(nodeOf(image)?.p?.mime, "image/png");
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_INLINE_IMAGES;
		else process.env.PI_TERN_INLINE_IMAGES = previous;
		cap.restore();
	}
});

test("chart refuses when the kind is not advertised and sends bars when it is", () => {
	const cap = capture();
	try {
		const withoutChart = createNativeSink({ hello: { ...HELLO, kinds: ["md"] }, surfaceId: "test1" });
		assert.equal(withoutChart.chart({ series: [{ label: "a", value: 1 }] }).ok, false);
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const sent = sink.chart({ series: [{ label: "a", value: 1 }], title: "T" });
		assert.equal(sent.ok, true);
		const node = ops(cap.frames).find((op) => nodeOf(op)?.k === "chart");
		assert.ok(node, "a chart node was added");
		assert.equal(nodeOf(node)?.p?.kind, "bars");
		assert.deepEqual(nodeOf(node)?.p?.bars, [{ label: "a", value: 1 }]);
		assert.equal(nodeOf(node)?.p?.title, "T");
	} finally {
		cap.restore();
	}
});

test("the aside region is a root under the surface, carrying an md node", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const result = sink.aside({ markdown: "body", title: "T", link: "file:///tmp/a.md" });
		assert.equal(result.ok, true);
		const root = ops(cap.frames).find((op) => op[0] === "add" && op[1] === "aside");
		assert.ok(root, "the aside root was added");
		assert.equal(root[2], "test1", "under the surface id");
		assert.equal(nodeOf(root)?.k, "col");
		const children = (nodeOf(root)?.c ?? []) as FrameNode[];
		assert.equal(children[0]?.k, "md");
		assert.ok(
			String(children[0]?.p?.text).includes("[Open in split](file:///tmp/a.md)"),
			"the button is a link",
		);
	} finally {
		cap.restore();
	}
});

test("aside refuses when the feature is not advertised", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: { ...HELLO, features: ["blobs"] }, surfaceId: "test1" });
		assert.equal(sink.aside({ markdown: "x" }).ok, false);
	} finally {
		cap.restore();
	}
});

test("transcript markdown is bounded, and switching modes removes the rows node", () => {
	const cap = capture();
	const previous = process.env.PI_TERN_MD_TRANSCRIPT_KEEP;
	try {
		process.env.PI_TERN_MD_TRANSCRIPT_KEEP = "2";
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.appendMarkdown({ text: "one", id: "t1", transcript: true });
		sink.appendMarkdown({ text: "two", id: "t2", transcript: true });
		const third = sink.appendMarkdown({ text: "three", id: "t3", transcript: true });
		assert.equal(third.kept, 2, "only two transcript blocks are kept");
		const dels = ops(cap.frames).filter((op) => op[0] === "del");
		assert.deepEqual(dels.map((op) => op[1]), ["t1"], "the oldest is deleted");
		sink.transcript("md");
		sink.flush();
		const delRows = ops(cap.frames).filter((op) => op[0] === "del" && op[1] === "m");
		assert.ok(delRows.length >= 1, "the rows node is removed in md mode");
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_MD_TRANSCRIPT_KEEP;
		else process.env.PI_TERN_MD_TRANSCRIPT_KEEP = previous;
		cap.restore();
	}
});

test("suspend and resume are single frame ops", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.markdown({ text: "x" });
		assert.equal(sink.suspend(), true);
		assert.equal(sink.suspend(), false, "suspending twice is a no-op");
		assert.equal(sink.resume(), true);
		const all = ops(cap.frames);
		assert.ok(all.some((op) => op[0] === "suspend"));
		assert.ok(all.some((op) => op[0] === "resume"));
	} finally {
		cap.restore();
	}
});

/** A semantic surface whose regions the test sets directly. */
function fakeSurface(regions: SemanticRegions) {
	const events: Array<Record<string, unknown>> = [];
	const surface: SemanticSurface & { regions: SemanticRegions; events: typeof events } = {
		regions,
		events,
		describe: () => structuredClone(surface.regions),
		onEvent: (event) => {
			events.push(event);
			return event.ev === "select";
		},
	};
	return surface;
}

const tspEvent = (body: Record<string, unknown>) => `\x1b_tsp;e;${JSON.stringify(body)}\x1b\\`;

test("semantic mode replaces the row copy with the surface's trees, then sends only changes", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.feed("transcript line\r\n");
		sink.flush();
		const editor = { id: "ke", k: "editor", p: { text: "", cursor: 0, mode: "NORMAL" } };
		const surface = fakeSurface({ main: [{ id: "u1", k: "md", p: { text: "hi" } }], dock: [editor], layer: [] });
		assert.equal(sink.attachSurface(surface), true);
		const before = ops(cap.frames).length;
		sink.flush();
		const switched = ops(cap.frames).slice(before);
		assert.deepEqual(switched[0], ["del", "main"], "the row copy is removed once");
		assert.deepEqual(switched.slice(1, 3), [
			["add", "main", "test1", null, { id: "main", k: "col" }],
			["add", "dock", "test1", null, { id: "dock", k: "col" }],
		]);
		assert.deepEqual(switched.slice(3), [
			["add", "u1", "main", null, { id: "u1", k: "md", p: { text: "hi" } }],
			["add", "ke", "dock", null, editor],
		]);
		assert.equal(sink.nativeState().surfaceAttached, true);

		surface.regions.dock = [{ id: "ke", k: "editor", p: { text: "x", cursor: 1 } }];
		sink.invalidate();
		const next = ops(cap.frames).length;
		sink.flush();
		assert.deepEqual(ops(cap.frames).slice(next), [["set", "ke", { text: "x", cursor: 1, mode: null }]]);
		sink.close();
	} finally {
		cap.restore();
	}
});

test("the sink sends a focus op only when the surface's focus target changes", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const editor = { id: "ke", k: "editor", p: { text: "" } };
		const surface = fakeSurface({ main: [], dock: [editor], layer: [], focus: "ke" });
		sink.attachSurface(surface);
		sink.flush();
		const focusOps = () => ops(cap.frames).filter((op) => op[0] === "focus");
		assert.deepEqual(focusOps(), [["focus", "ke"]]);

		surface.regions = { main: [], dock: [], layer: [{ id: "dlg1", k: "overlay", p: { modal: true } }], focus: "dlg1" };
		sink.invalidate();
		sink.flush();
		const opened = ops(cap.frames).slice(-1)[0];
		assert.deepEqual(opened, ["focus", "dlg1"], "focus follows the overlay's add in the same frame");

		sink.invalidate();
		sink.flush();
		assert.equal(focusOps().length, 2, "an unchanged target sends nothing");

		surface.regions = { main: [], dock: [editor], layer: [], focus: "ke" };
		sink.invalidate();
		sink.flush();
		assert.deepEqual(focusOps().slice(-1), [["focus", "ke"]], "the composer gets the focus back");

		surface.regions = { main: [], dock: [], layer: [], focus: null };
		sink.invalidate();
		sink.flush();
		assert.equal(focusOps().length, 3, "null sends nothing");

		surface.regions = { main: [], dock: [editor], layer: [], focus: "ke" };
		sink.handleInput(tspEvent({ ev: "error", sf: "test1", msg: "unknown id dock" }));
		sink.flush();
		assert.deepEqual(focusOps().slice(3), [["focus", "ke"]], "a region rebuild sends the focus again");
		sink.close();
	} finally {
		cap.restore();
	}
});

test("a Tern resize renders the semantic surface again at the new width", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const widths: number[] = [];
		sink.attachSurface({
			describe: (cols) => {
				widths.push(cols);
				return { main: [{ id: "r", k: "rows", p: { cols, lines: ["x".repeat(cols)] } }], dock: [], layer: [] };
			},
		});
		sink.flush();
		sink.handleInput(tspEvent({ ev: "resize", sf: "test1", cols: 120, cell: { w: 16, h: 33 }, visible: true }));
		sink.flush();
		assert.deepEqual(widths, [80, 120], "the hello's width first, then Tern's");
		assert.deepEqual(ops(cap.frames).slice(-1), [["set", "r", { cols: 120, lines: ["x".repeat(120)] }]]);

		const before = cap.frames.length;
		sink.handleInput(tspEvent({ ev: "resize", sf: "test1", cols: 120 }));
		sink.handleInput(tspEvent({ ev: "resize", sf: "test1", cols: 0 }));
		sink.flush();
		assert.equal(cap.frames.length, before, "the same width or a bad one sends nothing");
		sink.close();
	} finally {
		cap.restore();
	}
});

test("a resize before the surface attaches sets the width it first renders at", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.handleInput(tspEvent({ ev: "resize", cols: 64 }));
		const widths: number[] = [];
		sink.attachSurface({
			describe: (cols) => {
				widths.push(cols);
				return { main: [], dock: [], layer: [] };
			},
		});
		sink.flush();
		assert.deepEqual(widths, [64]);
		sink.close();
	} finally {
		cap.restore();
	}
});

test("PI_TERN_SEMANTIC=0 keeps the row copy and refuses a surface", () => {
	const cap = capture();
	const previous = process.env.PI_TERN_SEMANTIC;
	try {
		process.env.PI_TERN_SEMANTIC = "0";
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		assert.equal(sink.nativeState().semantic, false);
		assert.equal(sink.attachSurface(fakeSurface({ main: [], dock: [], layer: [] })), false);
		sink.feed("row text\r\n");
		sink.flush();
		const open = cap.frames.find((frame) => frame.verb === "o")?.body as { listen?: boolean } | undefined;
		assert.equal(open?.listen, false, "the row copy keeps listen:false");
		const main = ops(cap.frames).find((op) => op[0] === "add" && op[1] === "main");
		assert.equal(((nodeOf(main ?? ["add"])?.c ?? []) as FrameNode[])[0]?.k, "rows");
		sink.close();
	} finally {
		if (previous === undefined) delete process.env.PI_TERN_SEMANTIC;
		else process.env.PI_TERN_SEMANTIC = previous;
		cap.restore();
	}
});

test("a throwing surface is dropped for the row copy, and the reason is kept", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		sink.attachSurface({
			describe: () => {
				throw new Error("boom");
			},
		});
		sink.flush();
		assert.equal(sink.nativeState().surfaceAttached, false);
		assert.match(String(sink.nativeState().semanticFallback), /boom/);
		sink.feed("still here\r\n");
		sink.flush();
		const main = ops(cap.frames).find((op) => op[0] === "add" && op[1] === "main");
		assert.equal(((nodeOf(main ?? ["add"])?.c ?? []) as FrameNode[])[0]?.k, "rows");
		sink.close();
	} finally {
		cap.restore();
	}
});

test("Tern events reach the surface first, and repeated rejections fall back to rows", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const surface = fakeSurface({ main: [], dock: [], layer: [] });
		sink.attachSurface(surface);
		sink.flush();
		assert.equal(sink.handleInput(`a${tspEvent({ ev: "select", sf: "test1", id: "l", item: "i" })}b`), "ab");
		assert.deepEqual(surface.events.map((event) => event.ev), ["select"]);
		for (let i = 0; i < 3; i += 1) {
			sink.handleInput(tspEvent({ ev: "error", sf: "test1", msg: "unknown kind nope" }));
			sink.flush();
			assert.equal(sink.nativeState().surfaceAttached, true, `rebuild ${i + 1} keeps the surface`);
		}
		sink.handleInput(tspEvent({ ev: "error", sf: "test1", msg: "unknown kind nope" }));
		assert.equal(sink.nativeState().surfaceAttached, false);
		assert.match(String(sink.nativeState().semanticFallback), /rejected/);
		assert.equal(surface.events.length, 1, "error events are the sink's own");
		sink.flush();
		sink.close();
	} finally {
		cap.restore();
	}
});

test("a rejection's frame and op index name the refused node to the surface", () => {
	const cap = capture();
	try {
		const sink = createNativeSink({ hello: HELLO, surfaceId: "test1" });
		const rejected: string[][] = [];
		const surface = fakeSurface({ main: [{ id: "xt1", k: "md", p: { text: "a" } }], dock: [], layer: [] });
		sink.attachSurface({ ...surface, rejected: (id, message) => rejected.push([id, message]) });
		sink.flush();
		const frame = cap.frames.filter((captured) => captured.verb === "f").at(-1)?.body as { s: number; ops: FrameOp[] };
		const index = frame.ops.findIndex((op) => op[1] === "xt1");
		sink.handleInput(tspEvent({ ev: "error", sf: "test1", s: frame.s, op: index, msg: "unknown kind md" }));
		sink.handleInput(tspEvent({ ev: "error", sf: "test1", s: frame.s + 5, op: 0, msg: "no such frame" }));
		assert.deepEqual(rejected, [["xt1", "unknown kind md"]]);
		sink.close();
	} finally {
		cap.restore();
	}
});

test("blob sends image bytes once with verb b, named by their sha256, in chunks over the apc limit", async () => {
	const { createHash } = await import("node:crypto");
	const written: string[] = [];
	const original = process.stdout.write.bind(process.stdout);
	process.stdout.write = ((chunk) => (written.push(String(chunk)), true)) as typeof process.stdout.write;
	try {
		const sink = createNativeSink({ hello: { ...HELLO, apc: 1024 }, surfaceId: "test1" });
		const small = Buffer.from("tiny png").toString("base64");
		const id = sink.blob(small, "image/png");
		assert.equal(id, createHash("sha256").update("tiny png").digest("hex"));
		const blobs = () => written.filter((text) => text.startsWith("\x1b_tsp;b;"));
		assert.deepEqual(blobs(), [`\x1b_tsp;b;id=${id};mime=image/png;${small}\x1b\\`]);
		assert.equal(sink.blob(small, "image/png"), id, "the same payload is not sent again");
		assert.equal(blobs().length, 1);

		const large = Buffer.alloc(2000, 7).toString("base64");
		const largeId = sink.blob(large, "image/jpeg");
		const chunks = blobs().slice(1);
		assert.equal(chunks.length, 3);
		assert.deepEqual(
			chunks.map((text) => text.split(";").slice(1, -1)),
			[
				["b", `id=${largeId}`, "mime=image/jpeg", "c=b2", "m=1"],
				["b", `id=${largeId}`, "mime=image/jpeg", "c=b2", "m=1"],
				["b", `id=${largeId}`, "mime=image/jpeg", "c=b2"],
			],
		);
		assert.equal(chunks.map((text) => text.slice(text.lastIndexOf(";") + 1, -2)).join(""), large);
		assert.equal(sink.blob("", "image/png"), undefined);
		sink.close();
	} finally {
		process.stdout.write = original;
	}
});
