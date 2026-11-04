#!/usr/bin/env node
/**
 * The native launcher for Tern's `agent_command`. Tern runs that command only in agent blocks, so
 * starting here is the block-kind answer and no force variable is needed. A plain `pi-tern` in a
 * shell block keeps Pi's terminal interface.
 */
import { markAgentEntry } from "./block-kind.mjs";

markAgentEntry();
await import("./pi-tern.mjs");
