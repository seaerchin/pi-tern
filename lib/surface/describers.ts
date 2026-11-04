/**
 * The describer registry (ADR 0003): describers that extensions register on pi's event bus.
 *
 * An extension emits `tern:describe` with `{ kind, key, source?, describe, onEvent? }` at load and
 * again on `tern:ready`, which the surface emits at every session start. The registry picks one
 * describer per key by source, checks what it returns, and falls back to the surface's default per
 * item. Only tool describers have a surface hook so far. The transcript calls `tool()`.
 */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { SurfaceHost, TernEvent } from "./host.ts";
import type { ToolDescribeInput, ToolDescription, ToolStatus, TranscriptDescribers } from "./transcript.ts";

export const DESCRIBER_KINDS = ["tool", "message", "entry", "widget", "status"] as const;
export type DescriberKind = (typeof DESCRIBER_KINDS)[number];

/** Strongest first. A missing source counts as `author`, because the bus carries no sender identity. */
export const DESCRIBER_SOURCES = ["local", "author", "builtin"] as const;
export type DescriberSource = (typeof DESCRIBER_SOURCES)[number];

/** The kinds a surface area reads describers for. The others are kept and listed in `/tern diagnose`. */
const HOOKED_KINDS: ReadonlySet<DescriberKind> = new Set(["tool"]);

const TOOL_STATUSES: ReadonlySet<string> = new Set<ToolStatus>(["pending", "running", "done", "error", "cancelled"]);

/** A describe call over this many milliseconds counts as slow. */
export const SLOW_DESCRIBE_MS = 50;
/** Slow calls a key may make before it is turned off for the session. */
export const SLOW_DESCRIBE_LIMIT = 3;

/** What `tern:describe` carries once checked. `describe: null` opts the key out to the default. */
export interface DescriberRegistration {
	kind: DescriberKind;
	key: string;
	source: DescriberSource;
	describe: ((input: unknown) => unknown) | null;
	onEvent?: (event: TernEvent, input: unknown) => unknown;
}

export interface DescriberProblem {
	kind: string;
	key: string;
	/** The first error, as logged. */
	first: string;
	count: number;
}

/** What `/tern diagnose` shows. */
export interface DescriberReport {
	registrations: { kind: DescriberKind; key: string; source: DescriberSource; describe: "function" | "null"; wins: boolean; note?: string }[];
	off: { kind: DescriberKind; key: string; reason: string }[];
	problems: DescriberProblem[];
}

export interface DescriberRegistry extends Required<TranscriptDescribers> {
	/** Check and store a `tern:describe` payload. Within one kind, key and source the latest wins. */
	register(payload: unknown): boolean;
	/** A Tern event inside a described card goes to its describer's `onEvent`. True when one took it. */
	onEvent(event: TernEvent): boolean;
	/** Tern rejected the op that sent `nodeId`. The key whose card owns it is turned off. */
	rejected(nodeId: string, message: string): void;
	/** Failed items are tried again, as after `tern:invalidate`. */
	retry(): void;
	/** A new session: keys that were turned off and slow counts start over. */
	resetSession(): void;
	report(): DescriberReport;
}

export interface RegistryOptions {
	/** Node kinds from Tern's hello. Undefined when the hello named none, and then `k` is not checked. */
	kinds?: readonly string[];
	log(message: string): void;
	now?: () => number;
}

const registryKey = (kind: string, key: string) => `${kind}:${key}`;

const errorText = (error: unknown) => String((error as Error)?.message ?? error);

/** A registration from the bus, or the reason it was refused. */
export function parseRegistration(payload: unknown): DescriberRegistration | string {
	if (!payload || typeof payload !== "object") return "the payload is not an object";
	const { kind, key, source, describe, onEvent } = payload as Record<string, unknown>;
	if (!DESCRIBER_KINDS.includes(kind as DescriberKind)) return `kind must be one of ${DESCRIBER_KINDS.join(", ")}`;
	if (typeof key !== "string" || key === "") return "key must be a non-empty string";
	if (source !== undefined && !DESCRIBER_SOURCES.includes(source as DescriberSource)) return `source must be one of ${DESCRIBER_SOURCES.join(", ")}`;
	if (describe !== null && typeof describe !== "function") return "describe must be a function or null";
	if (onEvent !== undefined && typeof onEvent !== "function") return "onEvent must be a function";
	return {
		kind: kind as DescriberKind,
		key,
		source: (source as DescriberSource | undefined) ?? "author",
		describe: describe as DescriberRegistration["describe"],
		...(onEvent ? { onEvent: onEvent as DescriberRegistration["onEvent"] } : {}),
	};
}

/** Why `nodes` cannot be sent to Tern, or undefined when they can. */
export function checkNodes(nodes: unknown, kinds: readonly string[] | undefined, ids: Set<string> = new Set()): string | undefined {
	if (!Array.isArray(nodes)) return "nodes must be an array";
	for (const node of nodes) {
		if (!node || typeof node !== "object" || Array.isArray(node)) return "every node must be an object";
		const { id, k, p, c } = node as Record<string, unknown>;
		if (typeof id !== "string" || id === "") return "every node needs a string id";
		if (ids.has(id)) return `the id ${id} is used twice`;
		ids.add(id);
		if (typeof k !== "string") return `node ${id} needs a string k`;
		if (kinds && !kinds.includes(k)) return `node ${id} has kind ${k}, which Tern did not announce`;
		if (p !== undefined && (!p || typeof p !== "object" || Array.isArray(p))) return `node ${id} has props that are not an object`;
		if (c !== undefined) {
			const problem = checkNodes(c, kinds, ids);
			if (problem) return problem;
		}
	}
	return undefined;
}

/** Why a tool describer's output cannot be used, or undefined when it can. */
export function checkToolDescription(output: unknown, kinds: readonly string[] | undefined): string | undefined {
	if (!output || typeof output !== "object" || Array.isArray(output)) return "describe must return { head?, status?, body }";
	if (output instanceof Promise) return "describe must return synchronously";
	const { head, status, body } = output as Record<string, unknown>;
	if (head !== undefined && typeof head !== "string") return "head must be a string";
	if (status !== undefined && !TOOL_STATUSES.has(status as string)) return `status must be one of ${[...TOOL_STATUSES].join(", ")}`;
	return checkNodes(body, kinds);
}

/** What the transcript last asked of a card, so an event or a rejection finds its describer. */
interface CardRecord {
	kind: DescriberKind;
	key: string;
	input: ToolDescribeInput;
	registration: DescriberRegistration;
}

/** The input a failed describe saw. The item is tried again once any of it changes. */
interface FailedInput {
	generation: number;
	status: ToolStatus;
	argsComplete: boolean;
	expanded: boolean;
	args: unknown;
	partial: unknown;
	result: unknown;
}

const sameInput = (failed: FailedInput, input: ToolDescribeInput, generation: number) =>
	failed.generation === generation &&
	failed.status === input.status &&
	failed.argsComplete === input.argsComplete &&
	failed.expanded === input.expanded &&
	failed.args === input.args &&
	failed.partial === input.partial &&
	failed.result === input.result;

export function createDescriberRegistry(options: RegistryOptions): DescriberRegistry {
	const now = options.now ?? (() => performance.now());
	/** Registrations by kind and key, then by source. */
	const registrations = new Map<string, Map<DescriberSource, DescriberRegistration>>();
	const off = new Map<string, string>();
	const slowCalls = new Map<string, number>();
	const problems = new Map<string, DescriberProblem>();
	const cards = new Map<string, CardRecord>();
	const failed = new Map<string, FailedInput>();
	let generation = 0;

	const problem = (kind: string, key: string, message: string) => {
		const id = registryKey(kind, key);
		const known = problems.get(id);
		if (known) {
			known.count += 1;
			return;
		}
		problems.set(id, { kind, key, first: message, count: 1 });
		options.log(`describers: ${kind} ${key}: ${message}`);
	};
	const turnOff = (kind: DescriberKind, key: string, reason: string) => {
		const id = registryKey(kind, key);
		if (off.has(id)) return;
		off.set(id, reason);
		options.log(`describers: ${kind} ${key} is off for this session: ${reason}`);
	};
	/** The registration that decides a key. No cascade: a failing winner falls back to the default. */
	const winner = (kind: DescriberKind, key: string): DescriberRegistration | undefined => {
		const bySource = registrations.get(registryKey(kind, key));
		if (!bySource) return undefined;
		for (const source of DESCRIBER_SOURCES) {
			const registration = bySource.get(source);
			if (registration) return registration;
		}
		return undefined;
	};
	const cardOf = (nodeId: string): [string, CardRecord] | undefined => {
		for (const [cardId, card] of cards) {
			if (nodeId === cardId || nodeId.startsWith(`${cardId}-`)) return [cardId, card];
		}
		return undefined;
	};

	return {
		register(payload) {
			const registration = parseRegistration(payload);
			if (typeof registration === "string") {
				const { kind, key } = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>;
				problem(String(kind ?? "?"), String(key ?? "?"), `registration refused: ${registration}`);
				return false;
			}
			const id = registryKey(registration.kind, registration.key);
			const bySource = registrations.get(id) ?? new Map<DescriberSource, DescriberRegistration>();
			bySource.set(registration.source, registration);
			registrations.set(id, bySource);
			generation += 1;
			return true;
		},

		tool(toolName, input, cardId) {
			cards.delete(cardId);
			const registration = winner("tool", toolName);
			if (!registration?.describe || off.has(registryKey("tool", toolName))) return undefined;
			const lastFailure = failed.get(cardId);
			if (lastFailure && sameInput(lastFailure, input, generation)) return undefined;
			failed.delete(cardId);

			const started = now();
			let output: unknown;
			let error: string | undefined;
			try {
				output = registration.describe(input);
			} catch (thrown) {
				error = `describe threw: ${errorText(thrown)}`;
			}
			const elapsed = now() - started;
			if (elapsed > SLOW_DESCRIBE_MS) {
				const slow = (slowCalls.get(toolName) ?? 0) + 1;
				slowCalls.set(toolName, slow);
				problem("tool", toolName, `describe took ${Math.round(elapsed)} ms`);
				if (slow >= SLOW_DESCRIBE_LIMIT) turnOff("tool", toolName, `${slow} describe calls over ${SLOW_DESCRIBE_MS} ms`);
			}
			error ??= checkToolDescription(output, options.kinds);
			if (error) {
				problem("tool", toolName, error);
				failed.set(cardId, {
					generation,
					status: input.status,
					argsComplete: input.argsComplete,
					expanded: input.expanded,
					args: input.args,
					partial: input.partial,
					result: input.result,
				});
				return undefined;
			}
			cards.set(cardId, { kind: "tool", key: toolName, input, registration });
			return output as ToolDescription;
		},

		onEvent(event) {
			// The surface owns collapse, so a `toggle` never reaches a describer.
			if (event.ev === "toggle" || typeof event.id !== "string") return false;
			const found = cardOf(event.id);
			if (!found) return false;
			const [cardId, card] = found;
			if (!card.registration.onEvent || off.has(registryKey(card.kind, card.key))) return false;
			const unprefix = (value: unknown) => (typeof value === "string" && value.startsWith(`${cardId}-`) ? value.slice(cardId.length + 1) : value);
			const local: TernEvent = { ...event, id: unprefix(event.id), ...("item" in event ? { item: unprefix(event.item) } : {}) };
			try {
				const outcome = card.registration.onEvent(local, card.input);
				if (outcome instanceof Promise) outcome.catch((rejection) => problem(card.kind, card.key, `onEvent rejected: ${errorText(rejection)}`));
			} catch (error) {
				problem(card.kind, card.key, `onEvent threw: ${errorText(error)}`);
			}
			return true;
		},

		rejected(nodeId, message) {
			const found = cardOf(nodeId);
			if (!found) return;
			const [, card] = found;
			problem(card.kind, card.key, `Tern rejected node ${nodeId}: ${message}`);
			turnOff(card.kind, card.key, `Tern rejected node ${nodeId}: ${message}`);
		},

		retry() {
			generation += 1;
		},

		resetSession() {
			off.clear();
			slowCalls.clear();
			cards.clear();
			failed.clear();
			generation += 1;
		},

		report() {
			const list: DescriberReport["registrations"] = [];
			for (const bySource of registrations.values()) {
				for (const registration of bySource.values()) {
					const wins = winner(registration.kind, registration.key) === registration;
					list.push({
						kind: registration.kind,
						key: registration.key,
						source: registration.source,
						describe: registration.describe ? "function" : "null",
						wins,
						...(HOOKED_KINDS.has(registration.kind) ? {} : { note: "no surface hook yet" }),
					});
				}
			}
			return {
				registrations: list,
				off: [...off].map(([id, reason]) => {
					const [kind, ...key] = id.split(":");
					return { kind: kind as DescriberKind, key: key.join(":"), reason };
				}),
				problems: [...problems.values()].map((entry) => ({ ...entry })),
			};
		},
	};
}

/** Node kinds from the hello the launcher passed on, or undefined when it named none. */
export function helloKinds(env: Record<string, string | undefined> = process.env): string[] | undefined {
	try {
		const kinds = JSON.parse(env.PI_TERN_HELLO || "{}")?.kinds;
		return Array.isArray(kinds) && kinds.length > 0 ? kinds.map(String) : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Connect the registry to pi's event bus. Registrations arrive on `tern:describe`, a repaint is asked
 * for on `tern:invalidate`, and `tern:ready` goes out at each session start, after `/reload` too.
 */
export function connectDescribers(pi: ExtensionAPI, host: SurfaceHost, registry: DescriberRegistry, kinds: readonly string[] | undefined): void {
	pi.events.on("tern:describe", (payload) => {
		if (registry.register(payload)) host.invalidate();
	});
	pi.events.on("tern:invalidate", () => {
		registry.retry();
		host.invalidate();
	});
	pi.on("session_start", () => {
		registry.resetSession();
		pi.events.emit("tern:ready", { kinds: kinds ? [...kinds] : [] });
		host.invalidate();
	});
}
