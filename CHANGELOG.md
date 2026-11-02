# Changelog

## [0.2.0] - 2026-11-02

### Added

- **Pi 1.5.0 viewport & keybinding support**: Enable `capturesViewportInput` and honor configured `tui.select.*` keybindings (`up`, `down`, `pageUp`, `pageDown`, `confirm`, `cancel`) in `/sweep` and `/drop agent` pickers.
- **Extension update changelog**: Add `CHANGELOG.md` so Pi 1.5.0+ displays package release notes under "Extension Updates".

### Fixed

- **`shortenPath` home-prefix boundary**: Avoid turning sibling directories of `$HOME` (such as `/Users/me2/project` when home is `/Users/me`) into `~2/project`.

## [0.1.0] - 2026-11-01

### Added

- Initial release with `/drop` (aliases `/d`), `/drop quit`, `/drop agent`, and `/sweep` (`current` / `all`) batch TUI picker.
- Trash-first `.jsonl` deletion safety (`trash`, `trash-put`, `gio trash`, `kioclient`) with `unlink` fallback.
- Fork-safe recursive Antigravity (`agy`) conversation, subagent tree, SQLite summary, and metadata cache cleanup.
