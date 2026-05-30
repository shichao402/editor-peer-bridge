# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.13] - 2026-05-30

### Added

- Both peers: `ui.focusOnJump` toggle in `.editor-peer-bridge.json` (default: enabled). On a peer-initiated jump, the receiving IDE now raises its OS window to the foreground so the user no longer has to alt-tab.
  - VS Code/Cursor/CodeBuddy: activates the app via the platform's native focus mechanism (`osascript` on macOS, `SetForegroundWindow` on Windows, `wmctrl`/`xdotool` on Linux).
  - Rider: uses `ProjectUtil.focusProjectWindow` after opening the file.

### Fixed

- Rider peer: Jackson now ignores unknown JSON properties when reading `.editor-peer-bridge.json`, so configs written by a newer VS Code peer (e.g. with a `ui` section) no longer crash the Rider deserializer.

## [0.0.12] - 2026-05-28

### Added

- VS Code peer: status bar indicator showing the live server port; click to open the bridge config. Toggle via `ui.statusBar` in `.editor-peer-bridge.json` (default: enabled).
- VS Code peer: hot reload of `.editor-peer-bridge.json` — manual edits are picked up automatically; no need to reload the window.

### Changed

- VS Code peer: server lifecycle is now managed by a single reconcile loop (`BridgeController`), so commands and file events can no longer leave the server stuck in a half-started state.

### Fixed

- VS Code peer: `EADDRINUSE` no longer blocks startup. The server now falls back to the next free port in the configured range and persists the new port back into the bridge config.
- VS Code peer: running "Update Config" while the server was not listening previously short-circuited on `[config] unchanged`; the server is now (re)started on every reconcile when needed.

## [0.0.11] - 2026-05-26

### Added

- Rider actions to create, update, and open the Editor Peer Bridge config from Find Action.

## [0.0.10] - 2026-05-26

### Added

- Gradle wrapper for the Rider peer plugin project.

### Fixed

- Replaced deprecated Rider `ReadAction.compute(ThrowableComputable)` usage to maintain compatibility with newer IntelliJ Platform APIs.

## [0.0.5] - 2026-05-21

### Added

- Marketplace-facing README and changelog for VS Code Marketplace and Open VSX Registry.
- Expanded JetBrains Marketplace plugin description and release notes.
- Open VSX release target in the shared release tooling.

### Changed

- VS Code extension short description now lists Rider, VS Code, Cursor, and CodeBuddy support.
- Release documentation now describes all three publication channels more clearly.

## [0.0.4] - 2026-05-21

### Added

- Publish targets for VS Code Marketplace and JetBrains Marketplace.
- Package-only GitHub Actions workflow for repeatable VSIX and Rider ZIP artifacts.
- Release tooling that can publish from a version tag, the latest successful package run, or a specific workflow run.
- Rider and VS Code/Cursor/CodeBuddy support for `.sln` auto-detection, making multi-solution workspaces easier to route.
- Marketplace metadata for repository, issues, homepage, license, and publisher details.

### Changed

- `VERSION` is now the single release version source for the VS Code extension, package lockfile, and Rider Gradle metadata.
- Release logs now redact marketplace tokens.
- VS Code Marketplace publishing no longer depends on local `vsce login` state.

### Fixed

- Rider plugin ID metadata now avoids JetBrains validation warnings.
- VS Code/Cursor large-file checks no longer report false 50 MB sync errors from accumulated buffers.

## [0.0.1] - 2026-04-08

### Added

- Bidirectional jump between Rider, VSCode, Cursor, and CodeBuddy.
- Multi-target selection with an "All" broadcast option.
- Auto-config generation on first launch.
- Auto-register when a new IDE opens an existing project.
- Available port auto-detection in the 47631-47700 range.
- Parent directory config file lookup.
- Multi-instance support via environment variable / JVM property.
- File size pre-check for VSCode/Cursor with a 50 MB limit.
- Project type hierarchy and routing configuration.
