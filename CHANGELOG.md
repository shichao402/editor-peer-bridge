# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.17] - 2026-07-23

### Changed

- Config writes are **manual only**: Create Config / Update Config. Startup, file watching, and Restart Server only reload the shared `.editor-peer-bridge.json` and no longer rewrite it.
- Removed automatic config backups (`.editor-peer-bridge.json.bak.*`). Manual Update deletes any leftover historical backup files next to the config.
- Port fallback on bind conflict is session-only and is no longer persisted back into the config file (avoids multi-IDE write conflicts).
- Rider plugin compatibility is open-ended (`since-build` 241, no `until-build`), so newer Rider builds such as 2026.2 are accepted without bumping an upper bound each release.

### Docs

- README, marketplace README, and `shared/protocol/README.md` aligned with manual config sync behavior.

## [0.0.15] - 2026-06-18

### Added

- VS Code/Cursor/CodeBuddy: **Open Log** and **Restart Server** commands; bridge events are written to a disk log file.
- Rider: **Open Log** and **Restart Server** actions; disk logging via `PeerBridgeLog`.
- `shared/protocol/README.md` documenting cross-IDE bridge behaviors (config repair, config watch, restart, commands, jump errors).

### Changed

- VS Code/Cursor/CodeBuddy: proactive config repair (backup, salvage, overwrite) and automatic HTTP server restart when the current IDE's peer entry in `.editor-peer-bridge.json` changes.
- Rider: aligned with VS Code peer — `BridgeConfigSupport`, config file watching, reconcile/restart lifecycle, friendly jump error messages when a peer is unreachable, and automatic port reassignment on bind conflicts.
- VS Code/Cursor/CodeBuddy: clearer error messages for failed peer HTTP requests (`postJson`).
- README: cross-IDE consistency section linking to the protocol doc.
- Release script: use Gradle wrapper (`gradlew`) for Rider publish when present.

## [0.0.14] - 2026-06-06

### Added

- VS Code/Cursor/CodeBuddy: `editorPeerBridge.focusOnJump` setting to opt in to OS-level focusing after receiving a peer jump.

### Changed

- OS-level focusing is now disabled by default. New bridge configs write `ui.focusOnJump: false`.

### Fixed

- VS Code/Cursor/CodeBuddy on Windows: raising the window no longer restores maximized windows to a smaller normal window.

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
