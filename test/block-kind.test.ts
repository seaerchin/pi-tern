/**
 * The launcher's block-kind decision. On Tern 0.9.10 an agent block and a shell block get the same
 * TSP hello and the same TERN_* variables, so the entry Tern starts is the signal that holds.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { bridgePaneId, resolveBlockKind } from "../native/block-kind.mjs";

function recordingAsk(answer: string | undefined) {
	const asked: Array<string | undefined> = [];
	const ask = async (paneId: string | undefined) => {
		asked.push(paneId);
		return answer;
	};
	return { asked, ask };
}

test("the agent entry means an agent block without asking pi-bridge", async () => {
	const { asked, ask } = recordingAsk("terminal");
	const result = await resolveBlockKind({ agentEntry: true, env: { TERN_WINDOW_PANE: "4" }, ask });
	assert.deepEqual(result, { kind: "agent", via: "agent-command" });
	assert.deepEqual(asked, []);
});

test("PI_TERN_NATIVE_BLOCK=force and PI_TERN_SKIP_KIND_CHECK=1 still skip the ask", async () => {
	for (const env of [{ PI_TERN_NATIVE_BLOCK: "force" }, { PI_TERN_SKIP_KIND_CHECK: "1" }]) {
		const { asked, ask } = recordingAsk("terminal");
		assert.deepEqual(await resolveBlockKind({ agentEntry: false, env, ask }), { kind: "agent", via: "forced" });
		assert.deepEqual(asked, []);
	}
});

test("the plain launcher takes pi-bridge's answer", async () => {
	const terminal = recordingAsk("terminal");
	assert.deepEqual(await resolveBlockKind({ agentEntry: false, env: { TERN_PANE: "7" }, ask: terminal.ask }), {
		kind: "terminal",
		via: "pi-bridge",
	});
	assert.deepEqual(terminal.asked, ["7"]);

	const silent = recordingAsk(undefined);
	assert.deepEqual(await resolveBlockKind({ agentEntry: false, env: {}, ask: silent.ask }), {
		kind: undefined,
		via: "pi-bridge",
	});
	assert.deepEqual(silent.asked, [undefined]);
});

test("a headless serve pane is asked about by TERN_WINDOW_PANE", () => {
	assert.equal(bridgePaneId({ TERN_PANE: "7", TERN_WINDOW_PANE: "4" }), "7");
	assert.equal(bridgePaneId({ TERN_WINDOW_PANE: "4" }), "4");
	assert.equal(bridgePaneId({ TERN_PANE: "" }), undefined);
});
