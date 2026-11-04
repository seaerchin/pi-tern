# Walk Pi's components only for notices

[ADR 0001](0001-transcript-from-session-state.md) builds the transcript from session state and rejects walking Pi's components. Notices are the exception: Pi shows them in its transcript container but never saves them and fires no event, so the component tree is the only place they exist. The surface walks `chatContainer` only for components with no session counterpart, using just the `children` arrays, class names and `render()`. It shows `notify()` text as Markdown with a warning or error tone, and anything else as rows, after the item it follows. If Pi's structure changes, the walk logs it and shows nothing, so the rest of the transcript is unaffected. Decided in [issue 8](https://github.com/seaerchin/pi-tern/issues/8).

## Considered Options

- **Tern `toast` nodes.** Rejected: toasts vanish, so errors can't be found later, and a toast from a program has not been seen to display.
- **Intercept Pi's `showWarning` and `showError`.** Rejected: it patches private method names and misses notices that bypass them, such as the package update notice.
- **Drop notices.** Rejected: errors such as "Compaction failed" would be invisible.

## Extended: built-in dialogs

Built-in dialogs (`select`, `confirm`, `input`, `editor`) replace the composer in Pi's editor slot, and no supported API exposes their state. The surface reads the dialog component there by shape (for the selector: `baseTitle`, `options`, `selectedIndex`), mirrors it as a native overlay, and answers it by sending keys through the component's public `handleInput()`. If the shape doesn't match, the dialog shows as rows. Decided in [issue 15](https://github.com/seaerchin/pi-tern/issues/15).
