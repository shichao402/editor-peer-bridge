# Changelog

## 0.0.5 - 2026-05-21

### Added

- Marketplace-facing README with feature overview, supported editors, quick start, configuration summary, and privacy notes.
- Marketplace-facing changelog for VS Code Marketplace and Open VSX Registry.
- Open VSX release target in the shared release tooling.

### Changed

- Extension short description now lists Rider, VS Code, Cursor, and CodeBuddy support.
- Release notes now describe the three publication channels more clearly.

## 0.0.4 - 2026-05-21

### Added

- Marketplace publishing support for VS Code Marketplace.
- Package-only GitHub Actions workflow for repeatable VSIX artifacts.
- Release tooling that can publish from a version tag, the latest successful package run, or a specific workflow run.
- `.sln` / `.slnx` auto-detection support for Rider peers, improving routing in multi-solution workspaces.
- Repository, issue tracker, homepage, license, and publisher metadata for marketplace listings.

### Changed

- `VERSION` is now the single release version source for extension metadata and lockfile metadata.
- Release logs redact marketplace tokens.
- VS Code Marketplace publishing no longer depends on local `vsce login` state.

### Fixed

- Large-file checks no longer report false 50 MB sync errors from accumulated buffers.

## 0.0.1 - 2026-04-08

### Added

- Bidirectional jump between Rider, VS Code, Cursor, and CodeBuddy.
- Multi-target selection with an `All` broadcast option.
- Auto-config generation on first launch.
- Auto-register when a new IDE opens an existing project.
- Available port auto-detection in the `47631-47700` range.
- Parent directory config file lookup.
- Multi-instance support via environment variable / JVM property.
- File size pre-check for VS Code/Cursor with a 50 MB limit.
- Project type hierarchy and routing configuration.
