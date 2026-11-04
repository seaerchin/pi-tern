# PROTOTYPE: hybrid native surface (throwaway)

Answers [How do Pi's components produce semantic nodes?](https://github.com/seaerchin/pi-tern/issues/5). Not production code.

- `extension.ts` builds the transcript from Pi session events and stored entries, then describes it as `md`, `card`, `code`, `ansi` and `diff` nodes. The dock is an `editor` node with the Vim status, plus rows rendered from Pi's status, widget and footer containers. It logs transcript items with no session counterpart to `PI_TERN_GAP_LOG`.
- `native/backend.mjs` (PROTOTYPE blocks): with `PI_TERN_SEMANTIC=1`, the sink diffs the node trees into `add`, `set` and `del` ops.
- `render-check.sh` runs the headless `tern serve` render check.
- `tree-dump.ts` dumps Pi's live component tree.

Run: `PI_TERN_SEMANTIC=1 ./render-check.sh start -e "$PWD/extension.ts"`, then `./render-check.sh ctl $(cat /tmp/pi-tern-rc.last) shot NAME`.

Results are on the issue.
