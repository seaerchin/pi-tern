/**
 * How the launcher learns that it runs in a Tern agent block.
 *
 * On Tern 0.9.10 the TSP hello and the pane's TERN_* variables are the same in an agent block and in
 * a shell block, so neither can tell them apart. Tern runs `agent_command` only in agent blocks, so
 * the dedicated entry `pi-tern-agent.mjs` is the signal that holds. pi-bridge's `pane.kind` answer
 * stays as a second signal for the plain launcher, but a headless `tern serve` never loads plugin
 * window entries, so that answer is unverified.
 */

let agentEntry = false;

/** Called by `pi-tern-agent.mjs` before it loads the launcher. */
export function markAgentEntry() {
	agentEntry = true;
}

export function startedFromAgentEntry() {
	return agentEntry;
}

/**
 * The pane id pi-bridge matches against `cx.session:panes()`. Daemon panes export TERN_PANE. Panes
 * in a headless `tern serve` export only TERN_WINDOW_PANE.
 */
export function bridgePaneId(env) {
	return env.TERN_PANE || env.TERN_WINDOW_PANE || undefined;
}

/**
 * Resolve the block kind, strongest signal first. `ask` is only called when no stronger signal
 * applies, because the mailbox round trip is the launcher's whole startup cost.
 */
export async function resolveBlockKind({ agentEntry: fromAgentEntry, env, ask }) {
	if (fromAgentEntry) return { kind: "agent", via: "agent-command" };
	if (env.PI_TERN_NATIVE_BLOCK === "force" || env.PI_TERN_SKIP_KIND_CHECK === "1") return { kind: "agent", via: "forced" };
	return { kind: await ask(bridgePaneId(env)), via: "pi-bridge" };
}
