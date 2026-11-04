# Walk Pi's components only for notices

[ADR 0001](0001-transcript-from-session-state.md) builds the transcript from session state and rejects walking Pi's components. Notices are the exception: Pi shows them in its transcript container but never saves them and fires no event, so the component tree is the only place they exist. The surface walks `chatContainer` only for components with no session counterpart, using just the `children` arrays, class names and `render()`. It shows `notify()` text as Markdown with a warning or error tone, and anything else as rows, after the item it follows. If Pi's structure changes, the walk logs it and shows nothing, so the rest of the transcript is unaffected. Decided in [issue 8](https://github.com/seaerchin/pi-tern/issues/8).

## Considered Options

- **Tern `toast` nodes.** Rejected: toasts vanish, so errors can't be found later, and a toast from a program has not been seen to display.
- **Intercept Pi's `showWarning` and `showError`.** Rejected: it patches private method names and misses notices that bypass them, such as the package update notice.
- **Drop notices.** Rejected: errors such as "Compaction failed" would be invisible.

## Extended: built-in dialogs

Built-in dialogs (`select`, `confirm`, `input`, `editor`) replace the composer in Pi's editor slot, and no supported API exposes their state. The surface reads the dialog component there by shape (for the selector: `baseTitle`, `options`, `selectedIndex`), mirrors it as a native overlay, and answers it by sending keys through the component's public `handleInput()`. If the shape doesn't match, the dialog shows as rows. Decided in [issue 15](https://github.com/seaerchin/pi-tern/issues/15).

## Extended: extension renderer rows

Custom messages and custom entries drawn by an extension renderer show as rows from that renderer (issue 8). No supported API reaches a registered renderer, so its output exists only in Pi's `CustomMessageComponent` and `CustomEntryComponent`. The walk renders those components too, with the same `children`, class names and `render()`. Each component matches its saved item by order within its class, and only while the two counts agree. If they differ, as when an extension saves entries it never renders, that class shows its default and the walk logs it, so a renderer's rows never sit next to the wrong item. A custom message whose child has Pi's default shape (a `Box` of `Text`, `Spacer` and `Markdown`) has no renderer and shows as Markdown. Decided in [issue 10](https://github.com/seaerchin/pi-tern/issues/10).
