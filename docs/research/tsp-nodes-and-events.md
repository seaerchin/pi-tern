# TSP nodes and events in Tern 0.9.10

This answers [seaerchin/pi-tern#3](https://github.com/seaerchin/pi-tern/issues/3). It was measured on 2026-11-04 against Tern 0.9.10 (`2ad447b`).

Every claim cites a source. A claim marked **UNVERIFIED** has no primary evidence behind it. A claim marked *inferred* follows from evidence but was not observed directly.

## Sources

| Label | Source |
| --- | --- |
| [TY] | `tern plugin types DIR` from Tern 0.9.10. It writes `DIR/tern.d.luau` (2299 lines). Line numbers refer to that file. |
| [TS] | Tern's settings source, embedded in the binary. Found with `strings -n 6 /Applications/Tern.app/Contents/MacOS/tern \| grep -n native_editing`. |
| [TC] | Tern's changelog, embedded in the binary. Found with `strings -n 8 … \| grep -n '^## 0.9'`. |
| [W] | OMP `packages/wire/src/tsp.ts` (package `@oh-my-pi/pi-wire`) |
| [N] | OMP `packages/tui/src/native/node.ts` |
| [D] | OMP `packages/tui/src/native/describe.ts` |
| [EN] | OMP `packages/tui/src/native/encode.ts` |
| [BE] | OMP `packages/tui/src/native/backend.ts` |
| [RC] | OMP `packages/tui/src/native/reconcile.ts` |
| [ED] | OMP `packages/tui/src/components/editor.ts` |
| [P1] [P2] [P3] | Live probes in a headless Tern 0.9.10 window, described below |

All OMP files are at commit `33ea58a` on `main`. The base URL is `https://github.com/can1357/oh-my-pi/blob/33ea58aa7dfd696c1ac419ba51fb915660740ab2/`.

The ticket names `packages/tui/src/native/tsp.ts`. That file does not exist at this commit. The wire types live in `packages/wire/src/tsp.ts`.

`tern help dev` documents no TSP. Its only surface commands are `surface-play`, `media wait` and `plugins expect`. `tern plugin --help` documents only the `types` verb.

### Live probes

The probes ran in a hermetic headless window, so no real window or daemon was involved:

```sh
W=$(mktemp -d)
TERN_CONFIG_DIR=$W/cfg TERN_DAEMON_SOCKET=$W/daemon.sock tern serve --control $W/ctl.sock &
tern ctl --control $W/ctl.sock ready
tern ctl --control $W/ctl.sock run '"node probe.mjs out.json"'
```

Each probe puts stdin in raw mode. It sends a hello query with `features: ["edit","undo","send"]` and a DA1 sentinel, opens an inline surface and writes frames. It records every stdin chunk. Input came from `tern ctl type`, `key`, `click` and `dblclick`. `tern ctl tree` read the element tree.

- **P1** sends one op per frame (21 frames) and reads the error events.
- **P2** puts an `editor` in `dock` and types keys. It then sets `mode: "NORMAL"` and types again.
- **P3** draws a card, a list, a button, an `input` and an `editor`, then clicks each one.

The probe scripts are not committed. This document quotes the frames they sent and the replies they got.

## 1. The hello reply

P1 got this reply (`kinds` shortened here, listed in full below):

```json
{"r":"hello","v":1,"term":"tern","ver":"0.9.10","kinds":["…74 kinds…"],
 "features":["blobs","settle","adopt","dock","reduce-motion","aside","scroll","styles","flow","font"],
 "apc":65536,"credits":2,"cols":160,"cell":{"w":16,"h":33},"dark":false,"reduceMotion":false,"hour12":false}
```

The full kind list:

```
col row card section rule spacer text md code diff ansi math image media kv stats table tree json
badge kbd icon spinner shimmer elapsed progress rate list item tabs editor input button status seg
overlay toast rows picker prefs tool checklist agent chart meter block effort select switch slider
field otp buttons avatar avatars breadcrumb pager empty skeleton calendar date menu menubar nav
split scroll carousel message attachment trace stacktrace suggestions questions el
```

- `v` is still `1`.
- There are 74 kinds. 0.9.8 had 46 (docs/TERN-0.9.md:21-26).
- The 28 new kinds are `stats`, `button`, `select`, `switch`, `slider`, `field`, `otp`, `buttons`, `avatar`, `avatars`, `breadcrumb`, `pager`, `empty`, `skeleton`, `calendar`, `date`, `menu`, `menubar`, `nav`, `split`, `scroll`, `carousel`, `message`, `attachment`, `trace`, `stacktrace`, `suggestions` and `questions`. The 0.9.9 changelog adds most of them as plugin view elements [TC].
- `font` is a new feature. [TY] 436-439 calls it "the `o` `font`": `"sans"` or `"mono"`. The field name on the wire comes from that comment only. **UNVERIFIED**.
- `TERN_KINDS_KNOWN` in lib/tsp.ts:39-45 lacks those 28 kinds. `TERN_FEATURES_KNOWN` in lib/tsp.ts:48-51 lacks `font`. `negotiateHello` reports them as unknown. It does not fail.
- OMP's `TSP_KINDS` has 45 kinds [W] 38-84. All 45 are in Tern's list. Tern has 29 more: `block`, `el` and the 27 plugin kinds other than `button`. OMP types only its own 45.

## 2. Verbs and update ops

The framing is `ESC _ tsp ; <verb> [; k=v]* ; <body> ESC \` [W] 8. A body over `apc` bytes is split into chunks tagged `c=<id>`, with `m=1` on every chunk but the last [EN] 1-12.

### Verbs

| Verb | Direction | Body | Source |
| --- | --- | --- | --- |
| `q` | program to Tern | `{q:"hello", v:[1], app, ver?, features?}` or `{q:"blobs", ids}` | [W] 1067-1069 |
| `r` | Tern to program | the hello reply, or `{r:"blobs", have}` | [W] 1072-1089 |
| `o` | program to Tern | open: `{id, mode:"inline"\|"screen", title?, role?, adopt?}` | [W] 1051-1057 |
| `f` | program to Tern | frame: `{sf, s, ops}`. One atomic batch for one surface. `s` rises by one per frame. | [W] 1042-1048 |
| `b` | program to Tern | one blob, base64 | [W] 10, [BE] 18-25 |
| `x` | program to Tern | close: `{id, keep}`. `keep: true` keeps `main` in scrollback. | [W] 1060-1064 |
| `e` | Tern to program | an event (section 5) | [W] 1092-1139 |

So `o`, `f` and `x` are verbs. `add`, `set` and `del` are ops inside the `ops` array of an `f` body. The [W] header also names a `t` palette verb (line 11), but `TspVerb` leaves it out [W] 31. **UNVERIFIED**.

### Ops inside `f`

| Op | Shape | P1 result |
| --- | --- | --- |
| `add` | `["add", id, parent, before \| null, node]` | accepted |
| `set` | `["set", id, props]` | accepted |
| `text` | `["text", id, "append" \| "replace", text]`, for `text md code ansi math editor input shimmer` [W] 1006 | accepted |
| `splice` | `["splice", id, at, del, text]`, for the same kinds | accepted |
| `move` | `["move", id, parent, before \| null]` | accepted |
| `del` | `["del", id]` | accepted |
| `settle` | `["settle", id]` frees view state for an unchanged subtree (docs/NATIVE-FINDINGS.md:73) | accepted |
| `focus` | `["focus", id \| null]` moves Tern's keyboard focus to a field | accepted |
| `reveal` | `["reveal", id, "start" \| "end" \| "nearest"]` | accepted |
| `scroll` | `["scroll", id, "line-up" \| "line-down" \| "page-up" \| "page-down" \| "start" \| "end"]`. Send it only when `features` lists `scroll` [W] 1034-1039. | accepted |
| `suspend`, `resume` | `["suspend"]`, `["resume"]` | not sent |

The shapes come from [W] 1020-1032. "Accepted" means Tern sent no error event. An unknown kind got `{"ev":"error","sf":"probe-sf","s":20,"op":0,"msg":"unknown kind nosuchkind"}`. A `["blob",…]` op got `"msg":"unknown op blob"`.

- No error does not prove a node draws. Tern ignores unknown props ([W] 17-18, docs/TSP-ENCODINGS.md:66-68).
- Whether `set` keeps props it does not name is **UNVERIFIED**.
- `suspend` and `resume` were accepted on 0.5.0 (docs/NATIVE-FINDINGS.md:59). They are **UNVERIFIED** on 0.9.10.
- Flow control allows at most `credits` unacknowledged frames per surface [BE] 13-16. P1 sent 21 frames and got one ack, `{"ev":"ack","sf":"probe-sf","s":21}`. P3 sent 3 and got an ack for `s: 3`. So one ack covers every frame up to its `s` (*inferred*).

## 3. Surface regions

A surface has three regions: `main`, `dock` and `layer` ([W] 1013-1014, [TY] 411-419, [TY] 585-588).

- Region roots go under the surface id: `["add","main",<sf>,null,{"id":"main","k":"col"}]` ([RC] 268, docs/NATIVE-FINDINGS.md:37-43).
- `main` is the flowing document, the transcript [N] 97-102.
- `dock` is the sticky bottom chrome while the surface is live: the composer, the status line and HUDs [N] 100-101.
- `layer` sits above `main`. Overlays, pickers and sheets go there ([BE] 480-517, [TY] 416).
- A region's root node is not drawn. Only its `role` and its children are. Wrap content in a `col` [TY] 408-410.
- `dock` and `layer` are live only. After a close and an adopt, OMP adds them again and keeps diffing `main` ([RC] 237-238, [RC] 314-334).
- A surface's mode is `"inline"`, `"screen"`, `"block"` or `"flow"` [TY] 586. OMP opens only `inline` and `screen` [W] 1053. OMP shows a fullscreen overlay as a separate `screen` surface [BE] 6-11.

### `aside` is a feature, not a region

OMP says: "`aside`: a `prefs` page in `layer` docks as a sheet at the pane's right edge, the transcript narrowed beside it" [N] 89-91.

P2 added an `aside` root and a `bogus` root under the surface. Tern sent no error for either. `tern ctl tree` then showed these regions:

```
div | sf-region sf-main  | [16.0, 50.0, 1248.0, 28.5]
div | sf-region sf-dock  | [16.0, 755.5, 1248.0, 28.5]
div | sf-region sf-layer | [6.0, 40.0, 1268.0, 754.0]
```

The text in `main` and in the editor appeared in the tree. The text inside `aside` and `bogus` did not. So Tern accepts any root id but draws only the three regions.

This contradicts docs/TSP-ENCODINGS.md:44 and 60-62. They read an accepted `aside` root on 0.5.0 as a sheet at the right edge. That was never checked with a tree or pixels (docs/TSP-ENCODINGS.md:64-74). The 0.9.9 changelog says "Overlays dock as side sheets and bottom drawers" [TC]. How a program asks for a side sheet is **UNVERIFIED**.

## 4. Node kinds and their props

A wire node is `{id, k, p?, c?}` [W] 1009-1011.

Every node takes these common props: `role`, `key`, `tone`, `hidden`, `grow`, `shrink`, `basis`, `min`, `max`, `actions` (`click`, `dblclick`, `menu`), `title`, `aria`, `href`, `mark` and `hovercard` [W] 132-165. [TY] 128 adds that any node takes `collapsed`.

### `editor` [W] 465-489

| Prop | Meaning |
| --- | --- |
| `text` | the buffer |
| `cursor` | caret, a UTF-16 offset into `text` |
| `anchor` | selection anchor, or `null` |
| `decor` | styled ranges: `[{from, to, s, fx?}]` [W] 459-464 |
| `ghost` | inline completion suffix drawn after the caret |
| `placeholder` | dim text while `text` is empty |
| `prompt` | text before the field |
| `mode` | mode label, for Vim. Any label stops native editing (section 6). |
| `lang` | the text is code in this language |
| `readonly` | no editing |
| `sendable` | ready for an atomic `send`. Independent of focus. Absent or false means not ready. |
| `maxLines` | height cap |
| `typeahead` | Tern keeps what is typed, draws it at the caret, and sends it once this clears |

OMP's composer describes one `editor` node with key `input`. It sits in a `col` whose role is `omp.field`, or `omp.editor` for the prompt composer [ED] 1865-1972. OMP sets `mode` to `"PTY"` when another owner reads raw keys, else to the Vim label [ED] 1934. An open autocomplete list is an `overlay` with `anchor: {caret: <keypath>}` and role `omp.autocomplete` [ED] 1959. P2 drew the editor as `sf sf-editor focused` in `dock`.

### `input` [W] 490

`input` takes the `editor` props without `maxLines`. P3 drew it as `sf sf-input`.

### `md` [W] 219-225

`text`, `stream` (the tail is still arriving) and `marks` (literal runs drawn as these spans). `text` and `splice` ops work on it [W] 1006. An `md` node is the only way to show a clickable `file://` link (docs/TSP-ENCODINGS.md:56-59).

### `card` [W] 185-197

`head`, `status` (`pending`, `running`, `done`, `error`, `cancelled`), `collapsible`, `collapsed`, `preview` (`{lines}` or `"auto"`), `selected`, `inset` and `variant: "bare"`. [TY] 286-297 adds `icon`, `meta` and `end` (the id of a child drawn at the end of the head). In P3 a click on a collapsible card's head sent `toggle`.

### `list` [W] 417-423

`selected`, `filter`, `empty`, `max` (`{lines}` or a number) and `virtual`. Its children are `item` nodes. A list keeps its selected row in view only with `max = {lines = N}` [TY] 128.

### `item` [W] 424-431

`label`, `detail`, `icon`, `hint` (a string array), `disabled` and `value`. In P3 a click sent `select` and a double click sent `activate`. Both carry the item node's id as `item`.

### `rows` [W] 520-525

`cols` (the width the rows were rendered at) and `lines` (pre-rendered ANSI rows). [W] calls it a "migration fallback only". This is the row fallback. OMP turns any component without `describe` into a `rows` node [N] 10-11.

### `overlay` [W] 503-514

`anchor` (`"center"`, `"top"`, `"bottom"`, `{node, side: "above" | "below"}` or `{caret: id}`), `size` (`sm`, `md`, `lg`, `full`), `modal` and `head`. [TY] 300-311 adds `icon`, `meta`, `end` and `foot` (the id of a child drawn in the footer bar). OMP wraps each TUI overlay in an `overlay` node in `layer` [BE] 908-931. P1 added an `overlay` under `layer` without error.

### `image` [W] 317-326

`blob` (the sha256 content address of a blob sent with verb `b`), `builtin` (`"omp"`), `alt`, `w`, `h` and `max`. A click on an image zooms it by default [W] 125-129.

pi-tern's `figure()` sends `{data, mime}` inline (docs/TSP-ENCODINGS.md:52). OMP has no `data` prop, and Tern does not reject unknown props. Whether inline `data` draws in 0.9.10 is **UNVERIFIED**. docs/TSP-ENCODINGS.md:49-52 concludes that blobs cannot be sent from a program. That holds for frame ops only. Blobs travel as verb `b` ([W] 10, [BE] 18-25), which this repo never tried.

### `button` [W] 438-458

`text`, `icon`, `keys`, `variant`, `size`, `on`, `disabled` and `busy`. A click sends `action` with `act` set to `actions.click`, else `"click"`. A button never takes focus.

### Other kinds

[W] also types `tool` (761-801), `agent` (829-861), `checklist` (820-826), `picker` (624-675), `prefs` (731-753), `chart` (912-937), `meter` (885-901) and the layout and text kinds. The kinds OMP does not type (`block`, `el` and the 0.9.9 plugin kinds) are documented only through Luau's `tern.ui.*` builders [TY] 2133-2200. Their wire props for a program are **UNVERIFIED**.

## 5. Events Tern sends back

Shapes come from [W] 1092-1139. The fields OMP requires come from [EN] 198-215.

| `ev` | Fields | When | Live evidence |
| --- | --- | --- | --- |
| `ack` | `sf, s` | frames applied | P1, P3 |
| `resize` | `sf?, cols, cell?, visible?` | the width changed | P1: `{"ev":"resize","sf":"probe-sf","cols":160,"cell":{"w":16,"h":33},"visible":true}` |
| `theme` | `dark` | appearance changed | **UNVERIFIED** |
| `motion` | `reduce` | Reduce Motion changed | **UNVERIFIED** |
| `visible` | `sf?, visible` | the surface was shown or hidden | **UNVERIFIED** |
| `toggle` | `sf, id, key?, collapsed` | a collapsible head was clicked | P3: `{"ev":"toggle","id":"c1","collapsed":true,"sf":"probe3"}` |
| `select` | `sf, id, item` | a list item was clicked | P3: `{"ev":"select","id":"l1","item":"i2","sf":"probe3"}` |
| `activate` | `sf, id, item` | a list item was double clicked | P3: two `select` events, then `{"ev":"activate","id":"l1","item":"i2","sf":"probe3"}` |
| `action` | `sf, id, act, value?, mods?` | a button or action was clicked | P3: `{"ev":"action","id":"b1","act":"go","sf":"probe3"}`. A Shift click added `"mods":["shift"]`. |
| `change` | `sf, id, item, value` | a typed value changed by pointer (prefs rows, picker toggles, `el` checkboxes) | **UNVERIFIED** |
| `edit` | `sf, id, from, to, text, cursor, len` | Tern edited over its own selection | P2 (section 6) |
| `undo` | `sf, id` | ⌃Z or ⌘Z in a field | P2: `{"ev":"undo","id":"ed","sf":"probe2"}` |
| `send` | `sf, id, text` | Tern submits a whole prompt | **UNVERIFIED** in 0.9.10 |
| `focus` | `sf, id` | a click into a field that lacks the focus | P3: `{"ev":"focus","id":"in1","sf":"probe3"}` |
| `error` | `sf?, s?, op?, msg` | an op was rejected | P1 |
| `gone` | `sf?, ids` | an adopt found nothing, or ids were dropped | **UNVERIFIED** |

Details:

- `edit`: replace `[from, to)` with `text`, then put the caret at `cursor`. Offsets are UTF-16 code units into the lines joined with `"\n"`. `len` is the text length Tern saw. If the program's text has a different length, the edit is stale and the program drops it ([W] 1110-1115, [N] 144-160).
- In P2, Tern sent `len: 14`. That is `"hello world"` plus three typed letters. The program never sent those letters back with `set`. So Tern tracks typed text between frames (*inferred* from one sample).
- `send` arrives only when the program's hello `features` includes `"send"`. Its `sf` and `id` must name a live editable composer whose `sendable` is exactly `true`. Blank text is a no-op. A draft already in the field is kept for recall, not joined to the prompt [W] 1122-1131. `cx.agents:ask` queues a prompt until the composer reports `sendable=true` and then uses "one atomic TSP send event" [TY] 794-796.
- The 0.5.0 `send` round trip is in docs/NATIVE-FINDINGS.md:57. That file injects events with `tern send` (line 106). So it does not show Tern emitting `send` by itself (*inferred*).
- An action name that contains `=` is split into `act` and `value` [TY] 372-375.
- Luau plugin blocks get only `action`, `select`, `activate`, `change`, `toggle`, `focus`, `edit` and `undo` [TY] 372-375.

## 6. Key routing

### The program opts in

The program lists features in its hello query. OMP sends `["edit","undo","send"]` [EN] 136-152. Without `"edit"`, "every key stays omp's" [EN] 137-140. `"undo"` lets Tern turn ⌃Z in a field into an `undo` event [EN] 140-141. lib/tsp.ts:109 sends the same three features by default. Routing without `"edit"` was not probed on 0.9.10. **UNVERIFIED**.

Luau plugin blocks opt in with `features = { "edit", "undo" }` [TY] 433-435.

### With `edit`, `native_editing` on and no `mode` label

P2 typed into a focused `editor` whose text was `"hello world"`:

| Input | What reached the program |
| --- | --- |
| type `abc` | pty bytes `a`, `b`, `c` |
| Shift+Left | nothing. Tern made a selection. |
| type `Z` over the selection | `{"ev":"edit","id":"ed","from":13,"to":14,"text":"Z","cursor":14,"len":14,"sf":"probe2"}` |
| ⌘Z | `{"ev":"undo","id":"ed","sf":"probe2"}` |
| ⌃Z | `{"ev":"undo","id":"ed","sf":"probe2"}` |
| Up, on one line of text | pty bytes `ESC [ A` |
| Enter | pty byte `CR` |

Tern owns the selection and any edit made over it. The program still owns plain typing, Up and Down at the edges, and Enter. In a multi-line field, Tern moves the caret between the rows it drew and hands over only Up on the first row and Down on the last [ED] 811-817. Up and Down inside a multi-line field were not probed. **UNVERIFIED**.

### The `native_editing` setting

The setting's doc comment in Tern's source [TS]:

```rust
/// Program composers (omp's) edit like text fields: ⇧ with the arrows
/// or a drag selects, ⌘A/⌘C/⌘X, typing replaces the selection
/// (`view::composer`); off, and while the program edits in Vim mode,
/// every key is the program's.
pub native_editing:          bool,
```

The default is `native_editing: true` [TS]. The settings page says: "Select with … and the arrows or by dragging in omp's composer, then type over it, … undoes instead of suspending omp. Off, or in Vim mode, every key goes to the program." The key glyphs were lost in extraction.

### The Vim case

Tern learns about Vim mode from the `editor`'s `mode` prop. OMP's comment: "Insert carries none: Insert edits like a plain field, and a host such as Tern stops native editing (selection, ⌘A/⌘C/⌘X) for any labelled mode" [ED] 86-96. OMP's labels are `NORMAL`, `VISUAL` (also for visual-line) and `REPLACE`. Insert has no label.

P2 then sent `["set","ed",{"mode":"NORMAL"}]` and typed again:

| Input | What reached the program |
| --- | --- |
| type `xy` | pty bytes `x`, `y` |
| Shift+Left | pty bytes `ESC [ 1 ; 2 D` |
| ⌘Z | nothing reached the program |
| Escape | pty byte `ESC` |

Shift+Left reached the program here, but Tern kept it in the first run. This matches "every key is the program's". Where ⌘Z went is **UNVERIFIED**. A Tern app shortcut may take it. Only `NORMAL` was probed. That `VISUAL`, `REPLACE` and `PTY` behave the same rests on the OMP comment.

The consequence for pi-tern: the composer's `editor.mode` must carry the Vim status mode whenever it is not Insert. Otherwise Tern takes Shift+arrows and edits over a selection away from Pi's Vim mode.

### Focus

The program moves Tern's focus with the `focus` op. OMP sends it whenever its focused component changes [BE] 527-531. A click into a field that lacks the focus sends a `focus` event. The program then moves its focus there, or ignores it while a modal overlay holds the keys [W] 1132-1137. In P3 the click on `input` sent `focus`. The next typed `q` still arrived as a pty byte, because the probe never moved its focus.

## 7. Corrections to this repo

- `TERN_KINDS_KNOWN` and `TERN_FEATURES_KNOWN` in lib/tsp.ts:39-51 are stale for 0.9.10. They lack 28 kinds and the `font` feature (section 1).
- docs/TSP-ENCODINGS.md:44 and 60-62 call `aside` a region that draws a right-edge sheet. In 0.9.10 an `aside` root is accepted and not drawn (section 3).
- docs/TSP-ENCODINGS.md:49-52 says blobs cannot reach Tern from a program. Verb `b` carries them (section 4, `image`).
- docs/TERN-0.9.md:55 lists "aside region" as accepted. That is true, but acceptance does not mean it draws.

## 8. Still unverified

- Whether the `font` feature's `o` field is spelled `font`.
- The `t` verb.
- Whether `set` keeps the props it does not name.
- `suspend` and `resume` on 0.9.10.
- The events `theme`, `motion`, `visible`, `change`, `send` and `gone`.
- Key routing when the hello omits `"edit"`.
- Up and Down inside a multi-line field.
- Where ⌘Z goes while a `mode` label is set.
- `VISUAL`, `REPLACE` and `PTY` labels.
- Whether inline image `data` draws.
- How a program asks for a side sheet.
- Wire props of the 29 kinds OMP does not type.
- All probes ran in a headless `tern serve` window. A GUI window was not used.
