# pi-session-sweep

Session management and cleanup extension for the [Pi coding agent](https://github.com/earendil-works/pi-mono), with built-in support for cleaning up linked Antigravity (`agy`) conversations and subagent trees.

## Features

- **Drop Current Session (`/drop`, `/d`)**:
  - `/drop` (or `/d`): Delete the current session and immediately start a fresh session.
  - `/drop quit` (or `/d quit`, `/d q`, `/sweep quit`): Delete the current session and gracefully quit Pi.
  - `/drop agent [name]` (or `/d agent [name]`): Delete the current session and start a new session with a selected target agent.
- **Interactive Batch Sweep (`/sweep`)**:
  - `/sweep` (or `/sweep current`, `/drop list`): Open an interactive TUI picker to batch-select and delete previous sessions in the current working directory.
  - `/sweep all` (or `/drop all`): Open the batch-delete picker across all working directories.
- **Trash-First Safety**:
  - Attempts to move session files to the OS trash first (`trash`, `trash-put`, `gio trash`, `kioclient`), falling back to `unlink` if no trash provider is available.
- **Fork-Safe Antigravity (`agy`) Cleanup**:
  - Automatically removes linked Antigravity conversations (`conversations/<id>.db*`, `annotations/<id>.pbtxt`, `brain/<id>`, `conversation_summaries.db`, metadata caches, and spawned subagent trees).
  - Respects session ownership (`data.sessionId === header.id`) so dropping a `/fork`ed session never deletes the parent session's Antigravity conversation.

## Installation

Add to `~/.pi/agent/settings.json`:

```json
{
  "packages": [
    "git:github.com/teededung/pi-session-sweep"
  ]
}
```

## Configuration

A `config.json` file is generated in the extension root on first run:

```json
{
  "enabled": true,
  "iconMode": "auto"
}
```

- `enabled`: Enable or disable the extension (`true` | `false`).
- `iconMode`: Picker icon set (`"auto"` | `"nerd"` | `"fallback"`). Can also be overridden via `PI_SESSION_SWEEP_ICON_MODE` or `PI_NERD_FONT`.

## License

MIT
