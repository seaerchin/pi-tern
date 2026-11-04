# Extensions supply nodes through describers on Pi's event bus

Extensions give the full surface semantic nodes by registering describers with `tern:describe` on Pi's event bus. A describer is keyed by data anyone can see (a tool name, a message or entry `customType`, a widget or status key), maps an item's data to content nodes, and may carry an `onEvent` handler. The surface owns the card shell, ids, status and collapse. This is a public contract: describers written by extension authors, by the fork, and by the user in `~/.pi/agent/extensions/` all depend on it, so changing it breaks them. Decided in [issue 6](https://github.com/seaerchin/pi-tern/issues/6).

## Considered Options

- **Import an API module from `pi-tern`.** Rejected: fragile across Pi's module loader, and it makes `pi-tern` a hard dependency.
- **An optional `describe()` on the components renderers return, as in OMP.** Rejected: the surface builds the transcript from session data (ADR 0001) and never holds those component instances.
- **Nodes inside tool result `details`.** Rejected: it mixes presentation into saved session data.
- **A shared registry on `globalThis`.** Rejected: it bypasses Pi's bus, so `/reload` leaves stale describers behind.

## Consequences

- `pi.events` has no memory, so registration needs a handshake: the surface emits `tern:ready` at session start, and extensions register at load and again on `tern:ready`.
- The bus carries no sender identity, so each registration declares its `source`. `local` beats `author` beats `builtin`, and a missing `source` counts as `author`.
- Anyone can describe another extension's tools, messages, entries, status and line widgets. Factory-built widgets need their author.
