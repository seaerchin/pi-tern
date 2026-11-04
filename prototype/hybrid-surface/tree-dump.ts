// PROTOTYPE, throwaway. Dumps Pi's live component tree to PI_TERN_TREE_LOG.
import { appendFileSync } from "node:fs";

const out = process.env.PI_TERN_TREE_LOG ?? "/tmp/pi-tern-tree.log";

function walk(node: any, depth: number, lines: string[], seen: Set<any>) {
	if (!node || typeof node !== "object" || seen.has(node) || depth > 8) return;
	seen.add(node);
	const kids: any[] = Array.isArray(node.children) ? node.children : node.child ? [node.child] : [];
	const name = node.constructor?.name ?? "?";
	const extra = [
		typeof node.getText === "function" ? "editor-like" : "",
		node.toolName ? `tool=${node.toolName}` : "",
		typeof node.text === "string" ? `text=${JSON.stringify(node.text.slice(0, 30))}` : "",
	]
		.filter(Boolean)
		.join(" ");
	lines.push(`${"  ".repeat(depth)}${name} (${kids.length})${extra ? ` ${extra}` : ""}`);
	for (const k of kids) walk(k, depth + 1, lines, seen);
}

export default function (pi: any) {
	pi.on("session_start", (_e: any, ctx: any) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWidget(
			"pi-tern-tree-dump",
			(tui: any) => {
				setTimeout(() => {
					const lines: string[] = [];
					walk(tui, 0, lines, new Set());
					appendFileSync(out, `--- ${new Date().toISOString()}\n${lines.join("\n")}\n`);
				}, 1500);
				return { render: () => [], invalidate() {} };
			},
			{ placement: "belowEditor" },
		);
	});
}
