import { realpathSync } from "node:fs";
import { register } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

// The launcher runs `node --import register-hook.mjs <release>/node_modules/@earendil-works/pi-coding-agent/dist/cli.js`.
// Scoping the patch to that release's node_modules leaves the copies other extensions bring untouched.
// Module URLs are real paths, so the scope must be one too.
function releaseScope(entry) {
	if (!entry?.endsWith(path.join("pi-coding-agent", "dist", "cli.js"))) return "";
	try {
		return `${pathToFileURL(realpathSync(path.resolve(path.dirname(entry), "..", "..", ".."))).href}/`;
	} catch {
		return "";
	}
}

register(new URL("./patch.mjs", import.meta.url), import.meta.url, { data: { scope: releaseScope(process.argv[1]) } });
