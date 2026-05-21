# Release tooling

Cross-platform Node.js publisher for `vscode-peer` (VS Code Marketplace and Open VSX) and `rider-peer`.

## One-time setup

1. Copy the config template and fill in tokens:

   ```bash
   cp release.config.example.json release.config.json
   ```

2. Get tokens:
   - **JetBrains Marketplace** (`rider.token`): https://plugins.jetbrains.com/author/me/tokens
   - **VS Code Marketplace** (`vscode.pat`, optional): Azure DevOps PAT with `Marketplace > Manage` scope.
     If `vscode.pat` / `VSCE_PAT` is not configured, VS Code Marketplace publishing is skipped.
   - **Open VSX Registry** (`openvsx.pat`, optional): https://open-vsx.org/user-settings/tokens.
     If `openvsx.pat` / `OVSX_PAT` is not configured, Open VSX publishing is skipped.
     Before first publish, create or claim the namespace matching `vscode-peer/package.json`'s `publisher`.

   `release.config.json` is gitignored.

3. Make sure these are on your PATH:
   - `node` (>= 18)
   - `npm` / `npx`
   - `gh` authenticated with access to the repository, when publishing from GitHub Actions artifacts
   - `gradle` (8.x; only needed for local Rider builds)

## Version source

The root `VERSION` file is the single release version source. Before tagging a release:

```bash
# edit VERSION, then sync package/build metadata
npm run version:sync
npm run version:check

git tag v$(cat VERSION)
git push origin v$(cat VERSION)
```

## Commands

From the repo root:

```bash
# Publish artifacts from the Package workflow run for the repo version tag
npm run release -- --from-tag v$(cat VERSION)
npm run release:vscode -- --from-tag v$(cat VERSION)
npm run release:openvsx -- --from-tag v$(cat VERSION)
npm run release:rider -- --from-tag v$(cat VERSION)

# Validate artifact download without uploading
npm run release -- --from-tag v$(cat VERSION) --dry-run

# Debug escape hatch: publish latest artifacts or artifacts from a specific GitHub Actions run id
npm run release -- --from-latest
npm run release -- --from-run <run-id>

# Local build and publish
npm run release
npm run release:vscode
npm run release:openvsx
npm run release:rider

# Build/package only, no upload
npm run release:dry

# Direct invocation with extra options
node scripts/release.mjs vscode --skip-build
node scripts/release.mjs openvsx --dry-run
node scripts/release.mjs rider --dry-run
```

## Environment variable override

These env vars take precedence over `release.config.json`:

- `VSCE_PAT` — optional VS Code Marketplace PAT; if missing, VS Code Marketplace publishing is skipped
- `OVSX_PAT` — optional Open VSX Registry PAT; if missing, Open VSX publishing is skipped
- `JETBRAINS_PUBLISH_TOKEN` — JetBrains Marketplace token

Useful for CI without committing tokens to disk.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | Build/package only, or with artifact options: download and validate artifacts without uploading. |
| `--skip-build` | Skip dependency install / compile / build phases for local publishing. |
| `--from-latest` | Find the latest successful `Package` workflow run and publish its artifacts locally. Debug shortcut; prefer `--from-tag` for releases. |
| `--from-tag <tag>` | Find the latest successful `Package` workflow run for a tag and publish its artifacts locally. The tag must match `VERSION`. |
| `--from-run <run-id>` | Download artifacts from a specific GitHub Actions run id. Useful for debugging. |

## How it maps to existing tooling

- vscode-peer local build to VS Code Marketplace: `npx @vscode/vsce publish --pat <token>` when configured; skipped when no VS Code PAT is configured (cwd = `vscode-peer/`)
- vscode-peer from Actions artifact to VS Code Marketplace: `npx @vscode/vsce publish --packagePath <downloaded.vsix> --pat <token>` when configured; skipped when no VS Code PAT is configured
- vscode-peer local build to Open VSX Registry: `npx ovsx publish --pat <token>` when configured; skipped when no Open VSX PAT is configured (cwd = `vscode-peer/`)
- vscode-peer from Actions artifact to Open VSX Registry: `npx ovsx publish <downloaded.vsix> --pat <token>` when configured; skipped when no Open VSX PAT is configured
- rider-peer local build: `gradle publishPlugin` with `JETBRAINS_PUBLISH_TOKEN` injected.
- rider-peer from Actions artifact: upload the downloaded `.zip` to JetBrains Marketplace Upload API using `xmlId` from `rider-peer/src/main/resources/META-INF/plugin.xml`.
