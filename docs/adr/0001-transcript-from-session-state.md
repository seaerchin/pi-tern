# Build the transcript from session state, not by walking Pi's components

The full surface builds the transcript's semantic nodes from Pi's session events and stored entries. The composer is an `editor` node from the live editor and its Vim status. Pi's other containers (status, widgets, footer) are rendered by their own components into a row fallback. Pi's components only render text lines, and their meaning sits in private fields that change between Pi releases. Session events and entries are a supported API. The [prototype](https://github.com/seaerchin/pi-tern/issues/5) showed the session model matches Pi's user, assistant and tool components one to one.

## Considered Options

- **Walk the component tree and read each component's fields.** Rejected: it depends on Pi internals and breaks when they change.
- **Copy Pi's screen as rows.** Rejected: it is not a semantic surface. It stays as the fallback only.

## Consequences

- Transcript items with no session event (startup notices, `!` shell output) need a separate decision.
- Anything Pi draws inside the composer's border, such as the working spinner, needs its own node.

## Extended: OMP's shapes and the footer

The surface sends the node shapes and roles OMP sends, because Tern styles them by role (`omp.user`, `omp.assistant`, `omp.thinking`, `omp.editor`, `omp.composer.*`, `omp.working`, `omp.tool.*`). With `pi.*` roles Tern drew plain cards with a fallback look.

- User messages are user-toned cards. Replies are an `omp.assistant` column. Thinking is a foldable section.
- Tool calls are Tern `tool` nodes, so Tern draws the verb, target, facts and status.
- The composer sits in OMP's `omp.editor` frame: the context meter, the input, then a bar with the model and effort chips, the usage facts, the cost and send or Stop.
- In native mode OMP has no separate status line, so pi's built-in footer is folded into that bar. Tern draws the pane's directory itself beside the bar.
- Pi keeps the git branch, the extension statuses and the provider count only in its footer's data provider. The surface reads them from the built-in `FooterComponent` by shape.
- A custom footer from `setFooter`, or a provider whose shape changed, stays rows and logs once.
- Role names are Tern's styling contract with OMP. A Tern release that renames them leaves the surface unstyled but working.
