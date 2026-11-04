# Build the transcript from session state, not by walking Pi's components

The full surface builds the transcript's semantic nodes from Pi's session events and stored entries. The composer is an `editor` node from the live editor and its Vim status. Pi's other containers (status, widgets, footer) are rendered by their own components into a row fallback. Pi's components only render text lines, and their meaning sits in private fields that change between Pi releases. Session events and entries are a supported API. The [prototype](https://github.com/seaerchin/pi-tern/issues/5) showed the session model matches Pi's user, assistant and tool components one to one.

## Considered Options

- **Walk the component tree and read each component's fields.** Rejected: it depends on Pi internals and breaks when they change.
- **Copy Pi's screen as rows.** Rejected: it is not a semantic surface. It stays as the fallback only.

## Consequences

- Transcript items with no session event (startup notices, `!` shell output) need a separate decision.
- Anything Pi draws inside the composer's border, such as the working spinner, needs its own node.
