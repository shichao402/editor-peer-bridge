# Release tooling

Cross-platform Node.js publisher for `vscode-peer` and `rider-peer`.

## One-time setup

1. Copy the config template and fill in tokens:

   ```bash
   cp release.config.example.json release.config.json
   ```

2. Get tokens:
   - **VS Code Marketplace** (`vscode.pat`): Azure DevOps PAT with `Marketplace > Manage` scope.
     See https://code.visualstudio.com/api/working-with-extensions/publishing-extension#get-a-personal-access-token
   - **JetBrains Marketplace** (`rider.token`): https://plugins.jetbrains.com/author/me/tokens

   `release.config.json` is gitignored.

3. Make sure these are on your PATH:
   - `node` (>= 18)
   - `npm` / `npx`
   - `gradle` (8.x; compatible with the current IntelliJ Gradle plugin)

## Commands

From the repo root:

```bash
# Both editors
npm run release

# One at a time
npm run release:vscode
npm run release:rider

# Build/package only, no upload
npm run release:dry

# Direct invocation with extra options
node scripts/release.mjs vscode --skip-build
node scripts/release.mjs rider --dry-run
```

## Environment variable override

These env vars take precedence over `release.config.json`:

- `VSCE_PAT` — VS Code Marketplace PAT
- `JETBRAINS_PUBLISH_TOKEN` — JetBrains Marketplace token

Useful for CI without committing tokens to disk.

## Flags

| Flag | Effect |
|------|--------|
| `--dry-run` | vscode: `vsce package`; rider: `gradle buildPlugin`. No upload. |
| `--skip-build` | Skip `npm install` / `npm run compile`; reuse existing artifacts. |

## How it maps to existing tooling

- vscode-peer: `npx @vscode/vsce publish --pat <token>` (cwd = `vscode-peer/`)
- rider-peer: `gradle publishPlugin` with `JETBRAINS_PUBLISH_TOKEN` injected — consumed by `rider-peer/build.gradle.kts:43` (`publishing.token = providers.environmentVariable("JETBRAINS_PUBLISH_TOKEN")`).
