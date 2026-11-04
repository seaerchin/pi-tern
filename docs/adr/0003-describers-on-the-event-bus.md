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

## The contract

Recorded while building it in [issue 17](https://github.com/seaerchin/pi-tern/issues/17).

**Registration.** An extension emits this at load and again on every `tern:ready`:

```ts
pi.events.emit("tern:describe", {
	kind: "tool", // or "message", "entry", "widget", "status"
	key: "subagent", // the tool name, customType, widget key or status key
	source: "local", // or "author", "builtin". Missing counts as "author".
	describe: (input) => ({ head, status, body }), // or null to opt the key out to the default
	onEvent: (event, input) => {}, // optional
});
```

- The kind and the key together name a describer, so a tool and a message `customType` with one name never collide.
- For one kind, key and source, the latest registration wins silently. Extensions re-register on `tern:ready`, and the bus cannot tell that apart from a second extension.
- A payload with an unknown kind, an empty key, an unknown source, or a `describe` that is neither a function nor null is refused and logged.
- All five kinds are accepted. Only `tool` has a surface hook so far. `/tern diagnose` lists the others with "no surface hook yet".

**Events the surface emits and takes.**

- `tern:ready` goes out at every session start, including after `/reload`. Its payload is `{ kinds }`, the node kinds from Tern's hello.
- `tern:invalidate` takes any payload. The surface repaints and tries failed items again.

**Tool describers.** `describe` gets `{ toolCallId, args, argsComplete, status, partial?, result?, expanded }` and returns `{ head?, status?, body }` synchronously. The surface prefixes every body id with the card's id. `onEvent` gets events inside the card other than `toggle`, with the ids the describer gave, and the input of the last `describe`.

**Failures.**

- Output must be an array of objects with a string `id`, a `k` from Tern's hello and ids unique within the card. Otherwise that item shows the default card.
- A failed item is tried again when its input changes, on `tern:invalidate`, or on a new registration.
- The first error per key is logged to the frame record. Repeats are counted. Both show in `/tern diagnose`.
- A key is off for the session after three `describe` calls over 50 ms, or once Tern rejects a node from its card. The sink maps the error's frame and op index to the node id. A new session turns it on again.
- `onEvent` errors and rejected promises are caught and logged.
- No cascade: when the winning describer fails, the item shows the default, not a weaker source's describer.
