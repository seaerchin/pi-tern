# Pi transcript and composer components in Pi 1.5.0

Research for [issue 4](https://github.com/seaerchin/pi-tern/issues/4). It lists the Pi components that draw the transcript and the composer, and the extension hooks that touch them.

## Sources and path prefixes

Every claim cites a file and line. Prefixes:

- `pca/` is `~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/` (version 1.5.0, `pca/package.json:3`).
- `tui/` is `~/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-tui/` (version 1.5.0).
- `im.js` is `pca/dist/modes/interactive/interactive-mode.js`.
- `cmp/` is `pca/dist/modes/interactive/components/`.
- `types.d.ts` is `pca/dist/core/extensions/types.d.ts`.
- `vim/` is `~/.pi/agent/npm/node_modules/pi-vim-editor/src/` (0.9.0).
- `sub/` is `~/.pi/agent/npm/node_modules/pi-subagents/` (0.84.0).

All findings come from reading source. Nothing here was observed in a running Pi. Items marked UNVERIFIED are inferences that need a live check.

## Answer in short

1. One `InteractiveMode` owns one component tree. The transcript is `chatContainer`, a plain pi-tui `Container`. The composer is whatever sits in `editorContainer`.
2. Each transcript element has its own Pi class. User text is `UserMessageComponent`. Assistant text and thinking are both inside `AssistantMessageComponent`. A tool call and its result share one `ToolExecutionComponent`. Diffs are ANSI text from `renderDiff()` inside the edit tool renderer. Images are pi-tui `Image` children of `ToolExecutionComponent`.
3. The composer is `CustomEditor`, a subclass of pi-tui `Editor`. The autocomplete menu is a `SelectList` that `Editor.render()` appends below its own bottom border. The status line is `FooterComponent`.
4. The tree can be walked at runtime. Every container exposes a public `children` array, and Pi uses no `#private` fields. Any extension factory receives the live `TUI` object. There is no supported describe or serialise API, so a walk depends on Pi internals.
5. The supported way to rebuild the transcript is from state. Use `message_*` and `tool_execution_*` events for live updates and `ctx.sessionManager` for the stored branch. Pi itself rebuilds the transcript this way on resume.
6. Pi 1.5.0 defaults to fullscreen mode (`TuiAltScreen` with a `ScrollView` transcript). The native sink in `native/` was verified on Pi 1.0.4 only.

## How the TUI root is structured

`InteractiveMode` builds the containers in its constructor (`im.js:388-415`):

| Container | Holds |
|---|---|
| `documentContainer` | `headerContainer`, `loadedResourcesContainer`, `chatContainer` (`im.js:388-394`) |
| `pendingMessagesContainer` | queued steering and follow-up messages (`im.js:395`, `im.js:3947-3958`) |
| `statusContainer` | working, retry and compaction status indicators (`im.js:396`, `im.js:1870-1904`) |
| `widgetContainerAbove`, `widgetContainerBelow` | extension widgets (`im.js:397-398`) |
| `editorContainer` | the composer, or an extension dialog that replaces it (`im.js:409-410`, `im.js:2211-2218`) |
| `footerContainer` | `FooterComponent` or an extension footer (`im.js:414-415`) |

`init()` mounts the seven containers on the TUI in that order (`im.js:709-717`). The comment says "Keep one component tree and remount it when changing renderers" (`im.js:693`).

There are two renderers. `createInteractiveTui()` returns `TuiAltScreen` for `tuiMode: "fullscreen"` and `TuiMainScreen` otherwise (`pca/dist/modes/interactive/tui-renderer.js:6-35`). The default `tuiMode` is `"fullscreen"` (`pca/dist/core/settings-defaults.js:61`, `pca/docs/settings.md:97`).

In fullscreen mode the TUI also gets a layout root (`im.js:610-617`). `createChatViewport()` wraps `documentContainer` in a `ScrollView` that follows the end, and stacks the dock below it in a `VStack` (`pca/dist/modes/interactive/chat-viewport.js:3-26`). The dock order is pending messages, status, widgets above, editor, widgets below, footer (`chat-viewport.js:12-19`).

Extensions see a stable proxy, not the renderer itself. `this.ui` is `createInteractiveTuiReference(() => this.renderer)` (`im.js:386`), a `Proxy` that forwards to the current renderer (`tui-renderer.js:37-66`). `switchTuiMode()` moves the same children to a new renderer (`im.js:637-664`).

The TUI is itself a `Container`. `TuiBase extends Container` (`tui/dist/tui.d.ts:259`). `TUI` declares `children: Component[]` (`tui/dist/tui.d.ts:225`).

## Transcript components

Pi adds transcript components in two places. Live events go through `handleEvent()` (`im.js:2796`). Stored entries go through `renderSessionEntries()` and `renderSessionItems()` (`im.js:3284-3400`).

| Element | Component | Built from | Source |
|---|---|---|---|
| User message | `UserMessageComponent` wrapping one pi-tui `Markdown` | text blocks of the user message | `cmp/user-message.js:10-43`, `im.js:3241-3266` |
| Skill invocation | `SkillInvocationMessageComponent` | a parsed skill block in user text | `im.js:3247-3258` |
| Assistant text | `Markdown` inside `AssistantMessageComponent.contentContainer` | `content[].type === "text"` | `cmp/assistant-message.js:105-111` |
| Thinking | `Markdown` (shown) or `Text` with the hidden label, wrapped in `MouseRegion` | consecutive `thinking` blocks | `cmp/assistant-message.js:113-154` |
| Truncated, aborted or failed reply | `Text` inside `AssistantMessageComponent` | `stopReason` | `cmp/assistant-message.js:159-178` |
| Tool call and tool result | one `ToolExecutionComponent` per `toolCallId` | `toolCall` block, then tool events or `toolResult` message | `cmp/tool-execution.js:7-62`, `im.js:2897-2921`, `im.js:2969-3005`, `im.js:3311-3359` |
| Diff (edit tool) | ANSI string from `renderDiff()` placed in a `Text` | `args.edits` preview, then `result.details.diff` | `pca/dist/core/tools/renderers/edit.js:55-98`, `cmp/diff.js:70` |
| Image in a tool result | pi-tui `Image`, child of `ToolExecutionComponent` | `result.content[].type === "image"` | `cmp/tool-execution.js:288-315` |
| User bash (`!cmd`) | `BashExecutionComponent` | `bashExecution` message | `cmp/bash-execution.js:13-41`, `im.js:3207-3214` |
| Custom message | `CustomMessageComponent` with an extension renderer or default `Markdown` | `custom` message with `display: true` | `cmp/custom-message.js:8-88`, `im.js:3216-3223` |
| Custom entry | `CustomEntryComponent` with an extension entry renderer | `custom` session entry | `cmp/custom-entry.js:8-43`, `im.js:3186-3204` |
| Compaction and branch summaries | `CompactionSummaryMessageComponent`, `BranchSummaryMessageComponent` | summary messages | `im.js:3225-3238` |
| Notices, errors, warnings | `ThemedText` and `Spacer` added straight to `chatContainer` | Pi and extension notifications | `im.js:3167-3185`, `im.js:3864-3873` |

Details that matter for a semantic transcript:

- **Tool rows have three shells.** With a tool definition the row uses a `Box` (`contentBox`) or, for `renderShell: "self"`, a bare `Container`. Without a definition it uses a `Text` that prints the tool name and JSON arguments (`cmp/tool-execution.js:52-61`, `cmp/tool-execution.js:323-333`).
- **Renderer order.** `getRegisteredToolDefinition()` asks extension resolvers first, then built-in renderers (`im.js:1792-1794`). Built-in renderers cover read, bash, powershell, edit, write, grep, find and ls (`pca/dist/core/tools/renderers/index.js:17-28`).
- **Tool state lives on the component.** It keeps `toolName`, `toolCallId`, `args`, `result`, `isPartial`, `expanded` and `executionStarted` as plain fields (`cmp/tool-execution.js:20-35`).
- **Diffs are text, not structure.** The edit tool stores `details: { diff, patch, firstChangedLine }` on its result (`pca/dist/core/tools/edit.js:135`). The renderer turns `diff` into coloured ANSI lines (`cmp/diff.js:63-70`). The structured `patch` is the better source for a diff node.
- **User images are not drawn.** `getUserMessageText()` keeps only text blocks (`im.js:3140-3147`). `UserMessageComponent` has no image child (`cmp/user-message.js:31-43`). The only transcript `Image` use is in `ToolExecutionComponent` (`cmp/tool-execution.js:303`).
- **Streaming.** On `message_start` for an assistant, Pi creates one `AssistantMessageComponent` and calls `updateContent()` on each `message_update` (`im.js:2889-2900`). Tool rows are created as soon as a `toolCall` block appears in the stream (`im.js:2901-2920`). `updateContent()` clears and rebuilds `contentContainer` every time, reusing `Markdown` instances by slot (`cmp/assistant-message.js:76-89`).
- **Message identity.** Restored messages carry `messageId` and `timestamp` from their session entry (`im.js:3382-3396`). Live messages do not (`pca/docs/extensions.md:1816`).
- **Terminal markers.** User and assistant components add OSC 133 zone markers to their first and last line (`cmp/user-message.js:44-52`, `cmp/assistant-message.js:67-75`). `TuiMainScreen` strips them before writing (`tui/dist/tui-main-screen.js:232-233`).

## Composer, autocomplete and status line

| Element | Component | Source |
|---|---|---|
| Composer | `CustomEditor extends Editor` | `cmp/custom-editor.js:5-20`, `im.js:403-410` |
| Composer borders | `Editor.renderTopBorder()` and `renderBottomBorder()` draw `─` rules | `tui/dist/components/editor.js:389-396` |
| Working spinner in the border | `CustomEditor.renderTopBorder()` with `embedWorkingStatus: true` | `cmp/custom-editor.js:24-55`, `im.js:403-407` |
| Autocomplete menu | `SelectList` held in `Editor.autocompleteList`, rendered by `Editor.render()` after the bottom border | `tui/dist/components/editor.js:478-489`, `tui/dist/components/editor.js:1884` |
| Autocomplete data | `CombinedAutocompleteProvider` of slash commands, templates, extension commands and skills | `im.js:546` |
| Status line | `FooterComponent`: cwd and branch, token stats and model, then extension statuses sorted by key | `cmp/footer.js:47`, `cmp/footer.js:131-264` |
| Working and retry indicators | `StatusIndicator extends Loader` in `statusContainer` or in the editor border | `cmp/status-indicator.js:5-40`, `im.js:1863-1869` |

The supported editor contract is `EditorComponent`: `getText`, `setText`, `handleInput`, `onSubmit`, `onChange` and optional extras (`tui/dist/editor-component.d.ts:10-38`). `Editor` also has a public `getCursor()` (`tui/dist/components/editor.d.ts:113`). Its state, autocomplete list and autocomplete state are TypeScript `private` (`tui/dist/components/editor.d.ts:34`, `tui/dist/components/editor.d.ts:51-52`).

The composer, its menu and its border spinner are one component's output. A row split cannot tell them apart without knowing `Editor.render()`. `native/layout.mjs:34-51` takes the lowest two rules as the composer box. With autocomplete open, the menu rows fall below that box and land in the status rows. UNVERIFIED: inferred from code, not seen live.

## Extension API that touches rendering

All `ctx.ui` methods map to `InteractiveMode` in `createExtensionUIContext()` (`im.js:2138-2190`).

| API | What it does | Source |
|---|---|---|
| `ctx.ui.setEditorComponent(factory)` | replaces the composer. Pi copies `onSubmit`, `onChange`, text, border colour, padding, autocomplete and app action handlers to the new editor | `types.d.ts:194`, `im.js:2293-2364` |
| `ctx.ui.getEditorComponent()` | returns the current factory so a new one can wrap it | `types.d.ts:196`, `im.js:2169` |
| `ctx.ui.custom(factory, options)` | without `overlay` it pushes a dialog that replaces the composer in `editorContainer`. With `overlay: true` it calls `tui.showOverlay()` | `types.d.ts:132`, `im.js:2381-2440`, `im.js:2197-2218` |
| `pi.registerTool({ renderCall, renderResult, renderShell })` | per-tool call and result components | `pca/docs/extensions.md:2503-2589` |
| `pi.registerToolRenderer(resolver)` | renderers for any tool name, including tools not registered yet | `types.d.ts:1279`, `pca/docs/extensions.md:2107-2116` |
| `pi.registerMessageRenderer(customType, renderer)` | renders `custom` messages from `pi.sendMessage()` | `types.d.ts:1273`, `pca/docs/extensions.md:3146-3176` |
| `pi.registerEntryRenderer(customType, renderer)` | renders custom entries from `pi.appendEntry()` | `types.d.ts:1277`, `pca/docs/extensions.md:1829-1847` |
| `pi.registerMarkdownTransformer(fn)` | rewrites user, assistant and thinking Markdown before display | `types.d.ts:1275`, `pca/docs/extensions.md:1807-1827`, `im.js:1795-1797` |
| `ctx.ui.setWidget(key, lines or factory, { placement })` | adds a component above or below the composer. String arrays are capped at 10 lines | `types.d.ts:112-113`, `im.js:1940-1972`, `im.js:2025-2041` |
| `ctx.ui.setStatus(key, text)` | adds a keyed entry to the footer status line | `types.d.ts:95`, `im.js:1859-1862`, `cmp/footer.js:253-260` |
| `ctx.ui.setFooter(factory)`, `ctx.ui.setHeader(factory)` | replace the footer or the header | `types.d.ts:122-126`, `im.js:2043-2101` |
| `ctx.ui.notify(message, type)` | writes into the transcript, not a toast. `error` and `warning` append `ThemedText`. `info` appends or updates a dim status line | `types.d.ts:91`, `im.js:2369-2379`, `im.js:3167-3185`, `im.js:3864-3873` |
| `ctx.ui.addAutocompleteProvider(factory)` | stacks a provider over the built-in one | `types.d.ts:160`, `pca/docs/extensions.md:2983-3026` |
| `ctx.ui.onTerminalInput(handler)` | sees raw terminal input and can consume it | `types.d.ts:93` |

Every extension renderer returns a pi-tui `Component` that renders ANSI lines. `pi-subagents` is typical. Its `renderCall` returns a styled `Text` (`sub/src/extension/index.js:702-713`). Its result renderer builds a `Container` of `Text` lines (`sub/src/tui/render.js:3037-3064`). Its structured data lives in `result.details`, not in the component.

Component factories are ignored outside the TUI. In RPC mode `custom()` returns `undefined` (`pca/docs/extensions.md:3240-3249`).

`pi-vim-editor` shows how a composer replacement behaves in practice. It wraps the previous factory or a new `CustomEditor` (`vim/index.ts:83-115`). It then overwrites `render`, `handleInput`, `renderTopBorder` and `renderBottomBorder` on the instance, after binding the originals (`vim/attach.ts:115-118`, `vim/attach.ts:489`, `vim/attach.ts:643-677`). It publishes the vim status at `editor[Symbol.for("pi-vim-editor")]` (`vim/status.ts:8-9`, `vim/status.ts:51-58`). UNVERIFIED: the sink wraps `render` and `handleInput` on the editor prototype (`native/backend.mjs:95-114`). If pi-vim-editor binds the originals before that wrap, its instance methods skip the sink's capture hook.

## Session events and state for rebuilding the transcript

Live events available to extensions through `pi.on()` (`types.d.ts:1239-1244`):

| Event | Payload | Use |
|---|---|---|
| `message_start` | `message` for user, assistant, tool result and custom roles | open a node (`types.d.ts:856-859`, `pca/docs/extensions.md:752-758`) |
| `message_update` | `message` (full partial assistant message) and `assistantMessageEvent` | replace the streaming assistant node (`types.d.ts:861-865`) |
| `message_end` | final `message` | close the node (`types.d.ts:867-870`) |
| `tool_execution_start` | `toolCallId`, `toolName`, `args`, `parentToolCallId` | mark a tool row running (`types.d.ts:872-879`) |
| `tool_execution_update` | `partialResult` | stream tool output (`types.d.ts:881-889`) |
| `tool_execution_end` | `result`, `isError`, `durationMs` | settle the tool row (`types.d.ts:891-901`) |

Pi's own UI skips nested calls that carry `parentToolCallId` (`im.js:2970-2972`). Parallel tools emit `tool_execution_end` in completion order (`pca/docs/extensions.md:788-796`).

Pi's internal subscriber also gets `entry_appended`, `queue_update` and `session_info_changed` (`im.js:2826-2878`, `pca/docs/json.md:117-124`). `ExtensionAPI.on()` has no overload for `entry_appended` (no match in `types.d.ts`). An extension therefore gets no live event when another extension appends a custom entry. It has to read entries again.

Stored state comes from `ctx.sessionManager`, which is read-only. It offers `getEntries()`, `getBranch()`, `buildContextEntries()` and `buildSessionProjection()` (`pca/docs/extensions.md:1201-1212`, `pca/dist/core/session-manager.d.ts:178`). `sessionEntryToContextMessages()` is exported (`pca/dist/index.d.ts:21`, `pca/dist/core/session-manager.d.ts:189`). Pi's resume path uses exactly these pieces. It maps each entry with `sessionEntryToContextMessages()`, then pairs each `toolCall` with its later `toolResult` by `toolCallId` (`im.js:3381-3400`, `im.js:3311-3359`). Compaction clears `chatContainer` and replays retained entries (`im.js:2845-2867`).

Content block shapes are in `pca/docs/message-types.md:13-66`. Tool results carry `content` (text and image) and tool-specific `details` (`pca/docs/message-types.md:161-178`).

## Can the component tree be walked at runtime?

Yes, with internals. No, through a supported API.

- The `Component` interface only has `render(width): string[]` plus optional input, mouse and `invalidate` (`tui/dist/tui.d.ts:68-94`). It has no describe, type or serialise method.
- `Container.children` is a public array (`tui/dist/tui.js:96-97`). `Box.children` is public (`tui/dist/components/box.d.ts:6`). `MouseRegion` and `ScrollView` keep their child in a TypeScript-private `child` field (`tui/dist/components/mouse-region.js:3-9`, `tui/dist/components/scroll-view.d.ts:19`).
- TypeScript `private` is not enforced at runtime. A search for `#name` private fields in `markdown.js`, `text.js`, `tui.js`, `editor.js` and `tool-execution.js` found none. `Markdown.text`, `AssistantMessageComponent.lastMessage` and `ToolExecutionComponent.args` are plain properties (`tui/dist/components/markdown.js:180`, `cmp/assistant-message.js:17`, `cmp/tool-execution.js:22`).
- An extension can reach the root. `setWidget`, `setFooter`, `setHeader`, `custom` and `setEditorComponent` factories all receive the `TUI` proxy (`types.d.ts:113-132`, `im.js:1968`, `im.js:2051`, `im.js:2078`, `im.js:2305`, `im.js:2412`). `tui.children` then yields the seven mounted containers.
- Class checks are fragile. Pi exports the component classes (`pca/dist/index.js:43`). Pi's own code avoids `instanceof` for editors because it "fails across jiti module boundaries" (`im.js:2326`). A walker should duck-type.
- pi-tui also exposes layout nodes for stacks and scroll views through `getLayoutNode()` (`tui/dist/layout-node.d.ts:1-39`). That describes geometry, not meaning.

So a native surface has three options. It can rebuild semantic nodes from events and session state, which uses supported APIs. It can walk `chatContainer` and read private fields, which breaks when Pi changes. Or it can keep the row fallback for anything it cannot name, which is the current `native/` approach.

## What this fork's native sink does today

- The loader hook appends code to pi-tui `terminal.js` that replaces `ProcessTerminal.prototype.write` with the sink (`native/patch.mjs:10-45`, `native/patch.mjs:76-89`). `ProcessTerminal` and its `write` still exist in 1.5.0 (`tui/dist/terminal.js:81`, `tui/dist/terminal.js:436`).
- It also captures the `Editor` and `CustomEditor` classes (`native/patch.mjs:68-74`, `native/patch.mjs:82-87`). The sink wraps their `render` and `handleInput` to grab the live editor (`native/backend.mjs:94-114`, `native/backend.mjs:424-429`).
- Each frame goes through an ANSI grid. The sink splits it at the composer rules into `main` rows, an `editor` node and `dock` rows (`native/backend.mjs:480-553`, `native/layout.mjs:9-51`).
- The transcript is only the visible grid (`native/README.md:41`). In fullscreen mode, the Pi 1.5.0 default, that grid is the `ScrollView` viewport. UNVERIFIED: the native README records checks on Pi 1.0.4 only (`native/README.md:27`). The repo has no `tuiMode` handling (no match for `tuiMode` or `fullscreen` in `native/`, `lib/` or `index.ts`).

## UNVERIFIED items

- The autocomplete menu lands in the dock status rows under `splitComposer()`.
- The pi-vim-editor instance methods bypass the sink's prototype wrap.
- The native sink behaves the same under `TuiAltScreen` as under `TuiMainScreen`.
- Walking `chatContainer` from an extension yields the components listed above in a live session. This follows from code. No walk was run.
