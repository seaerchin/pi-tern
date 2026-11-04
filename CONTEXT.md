# pi-tern

Connects Pi to the Tern terminal. This fork adds a native surface, so Tern draws a Pi session with its own interface.

## Language

### Tern

**Tern Surface Protocol (TSP)**:
The protocol a program uses to describe its interface to Tern as a tree of nodes.
_Avoid_: surface protocol, wire format

**Agent block**:
A Tern block that runs an agent and can display a native surface.
_Avoid_: agent pane, chat block

**Shell block**:
A Tern block that runs a shell and displays only terminal cells.
_Avoid_: terminal pane

**Tern chat**:
Tern's own chat interface for an agent connected over ACP.
_Avoid_: ACP chat, native chat

### Surfaces

**Native surface**:
A Pi session that Tern draws from semantic nodes instead of terminal cells.
_Avoid_: native mode, native UI

**Full surface**:
A native surface where the transcript, the tool calls and the composer are all semantic nodes.
_Avoid_: whole-session surface

**Semantic node**:
A TSP node that states what an element is, such as a message, a tool call or an editor.
_Avoid_: native node, widget

**Row fallback**:
Copied screen rows shown inside a native surface for an interface that has no semantic nodes.
_Avoid_: rows surface, ANSI fallback

**Notice**:
A transcript item Pi shows but never saves, such as a warning from an extension or Pi's own error.
_Avoid_: notification, toast, status message

**Transcript**:
The ordered record of a session's messages, thinking and tool calls.
_Avoid_: conversation, history, main region

**Composer**:
The field where the user writes the next prompt.
_Avoid_: editor, prompt box, input

### Pi

**Native launcher**:
The command that starts Pi with a native surface inside Tern, and Pi's terminal interface elsewhere.
_Avoid_: wrapper, pi-tern binary

**Vim status**:
The mode and pending command that `pi-vim-editor` publishes for a composer.
_Avoid_: vim state, vim mode label
