/**
 * The loader patch in native/patch.mjs makes exactly one sink per pi process.
 *
 * pi-subagents imports its own copy of pi-tui from ~/.pi/agent/npm. Patching both copies created
 * two sinks, so two surfaces opened and the semantic surface attached to the one pi never draws
 * through. The patch is scoped to the launched release, and the sink handle is a singleton.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { transformSource } from "../native/patch.mjs";

const RELEASE = "file:///home/u/.pi/agent/install/releases/1.5.0/node_modules/";
const EXTENSION_COPY = "file:///home/u/.pi/agent/npm/node_modules/";
const TERMINAL = "@earendil-works/pi-tui/dist/terminal.js";

test("only the launched release's pi-tui is patched", () => {
	assert.match(transformSource(RELEASE + TERMINAL, "class ProcessTerminal {}", RELEASE) ?? "", /__createNativeSink/);
	assert.equal(transformSource(EXTENSION_COPY + TERMINAL, "class ProcessTerminal {}", RELEASE), null);
	assert.equal(transformSource(`${RELEASE}some/other.js`, "", RELEASE), null);
});

test("without a release scope every copy is patched, as before", () => {
	assert.notEqual(transformSource(EXTENSION_COPY + TERMINAL, "", ""), null);
});

test("a second patched pi-tui copy reuses the first sink instead of opening another", async () => {
	const dir = mkdtempSync(path.join(tmpdir(), "pi-tern-patch-"));
	const env = { native: process.env.PI_TERN_NATIVE, surface: process.env.PI_TERN_SURFACE_ID };
	const globals = globalThis as { __piTernNative?: unknown };
	try {
		process.env.PI_TERN_NATIVE = "1";
		process.env.PI_TERN_SURFACE_ID = "patch-test";
		const source = "export class ProcessTerminal { write(data) { return `raw:${data}`; } start() {} }";
		const copies = ["release", "extension"].map((name) => {
			const file = path.join(dir, name, "node_modules", TERMINAL);
			mkdirSync(path.dirname(file), { recursive: true });
			writeFileSync(file, transformSource(pathToFileURL(file).href, source, "") ?? "");
			return file;
		});
		const first = await import(pathToFileURL(copies[0]).href);
		const handle = globals.__piTernNative;
		assert.ok(handle, "the first copy creates the handle");
		const second = await import(pathToFileURL(copies[1]).href);
		assert.equal(globals.__piTernNative, handle, "the second copy keeps the first handle");
		assert.notEqual(first.ProcessTerminal.prototype.write.toString(), second.ProcessTerminal.prototype.write.toString());
		assert.equal(new second.ProcessTerminal().write("x"), "raw:x", "the second copy writes through untouched");
	} finally {
		delete globals.__piTernNative;
		for (const [key, value] of [["PI_TERN_NATIVE", env.native], ["PI_TERN_SURFACE_ID", env.surface]] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		rmSync(dir, { recursive: true, force: true });
	}
});
