# Walk Pi's components only for notices

[ADR 0001](0001-transcript-from-session-state.md) builds the transcript from session state and rejects walking Pi's components. Notices are the exception: Pi shows them in its transcript container but never saves them and fires no event, so the component tree is the only place they exist. The surface walks `chatContainer` only for components with no session counterpart, using just the `children` arrays, class names and `render()`. It shows `notify()` text as Markdown with a warning or error tone, and anything else as rows, after the item it follows. If Pi's structure changes, the walk logs it and shows nothing, so the rest of the transcript is unaffected. Decided in [issue 8](https://github.com/seaerchin/pi-tern/issues/8).

## Considered Options

- **Tern `toast` nodes.** Rejected: toasts vanish, so errors can't be found later, and a toast from a program has not been seen to display.
- **Intercept Pi's `showWarning` and `showError`.** Rejected: it patches private method names and misses notices that bypass them, such as the package update notice.
- **Drop notices.** Rejected: errors such as "Compaction failed" would be invisible.

## Extended: built-in dialogs

Built-in dialogs (`select`, `confirm`, `input`, `editor`) replace the composer in Pi's editor slot, and no supported API exposes their state. The surface reads the dialog component there by shape (for the selector: `baseTitle`, `options`, `selectedIndex`), mirrors it as a native overlay, and answers it by sending keys through the component's public `handleInput()`. If the shape doesn't match, the dialog shows as rows. Decided in [issue 15](https://github.com/seaerchin/pi-tern/issues/15).

Built in [issue 16](https://github.com/seaerchin/pi-tern/issues/16):

- The `input` and `editor` fields carry the `mode` label `PTY`. Tern then edits nothing natively and sends every key to Pi, so Pi's value stays the only truth. Tern's selection editing is lost in dialog fields. Replaying Tern's `edit` events as keys was rejected because a key could apply twice.
- The `input` and `editor` overlays have Submit and Cancel buttons, so the mouse can answer them. They send Enter and Escape. Enter submits in Pi's editor dialog too.
- Tern 0.9.10 sends no event when a modal overlay closes. The overlay has no close control, a click on its backdrop sends nothing, and Escape reaches Pi as a key. So Escape cancels through Pi itself.

## Extended: extension renderer rows

Custom messages and custom entries drawn by an extension renderer show as rows from that renderer (issue 8). No supported API reaches a registered renderer, so its output exists only in Pi's `CustomMessageComponent` and `CustomEntryComponent`. The walk renders those components too, with the same `children`, class names and `render()`. Each component matches its saved item by order within its class, and only while the two counts agree. If they differ, as when an extension saves entries it never renders, that class shows its default and the walk logs it, so a renderer's rows never sit next to the wrong item. A custom message whose child has Pi's default shape (a `Box` of `Text`, `Spacer` and `Markdown`) has no renderer and shows as Markdown. Decided in [issue 10](https://github.com/seaerchin/pi-tern/issues/10).
