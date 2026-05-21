# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/).

## [0.0.4] - 2026-05-21

### Added

- Publish targets for all supported channels: VS Code Marketplace, Open VSX Registry, and JetBrains Marketplace.
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
