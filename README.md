# Editor Peer Bridge

Cross-editor code navigation tool. Jump between Rider, VSCode, Cursor, and CodeBuddy with a single keystroke.

## Features

- **Bidirectional jump** - Navigate from any editor to any other editor in the same project
- **Multi-target selection** - Choose a specific target or broadcast to all peers
- **Auto-config** - Configuration file is generated automatically on first launch
- **Multi-instance support** - Run multiple instances of the same editor on the same project

## Supported Editors

| Editor | Version | Plugin |
|--------|---------|--------|
| JetBrains Rider | 2024.1+ | Rider plugin (ZIP) |
| Visual Studio Code | 1.95+ | VSCode extension (VSIX) |
| Cursor | Latest | VSCode extension (VSIX) |
| CodeBuddy | Latest | VSCode extension (VSIX) |

## Installation

### VSCode / Cursor / CodeBuddy

1. Open Extensions panel
2. Click `...` > `Install from VSIX...`
3. Select `editor-peer-bridge-vscode-peer-x.x.x.vsix`
4. Restart the editor

### Rider

1. Open `Settings` > `Plugins`
2. Click `Install Plugin from Disk...`
3. Select `editor-peer-bridge-rider-x.x.x.zip`
4. Restart Rider

## Quick Start

1. Open the same project in two or more editors (e.g. Rider + Cursor)
2. A `.editor-peer-bridge.json` config file is auto-generated in your project root
3. Jump:
   - **Rider**: Press `Ctrl+Alt+Shift+J`
   - **VSCode/Cursor/CodeBuddy**: Run command `Editor Peer Bridge: Jump To Peer`
4. If multiple peers are available, a picker appears with an **All** option for broadcast

## Configuration

The plugin reads `.editor-peer-bridge.json` from the project root (or any parent directory). It is auto-generated on first launch, but you can edit it manually.

### Example

```json
{
  "peers": {
    "rider-01": {
      "peerId": "rider-01",
      "editorKind": "rider",
      "instanceName": "Rider 01",
      "port": 47631,
      "workspaceRoots": ["D:/workspace/my-project"],
      "supportedProjectTypes": ["all"],
      "projectType": "all"
    },
    "cursor-01": {
      "peerId": "cursor-01",
      "editorKind": "cursor",
      "instanceName": "Cursor 01",
      "port": 47632,
      "workspaceRoots": ["D:/workspace/my-project"],
      "supportedProjectTypes": ["all"],
      "projectType": "all"
    }
  },
  "typeHierarchy": {
    "all": []
  },
  "routing": {
    "requestTimeoutMs": 3000
  }
}
```

### Fields

| Field | Description |
|-------|-------------|
| `peers` | Map of all editor instances participating in the bridge |
| `peerId` | Unique identifier for each instance |
| `editorKind` | One of: `rider`, `vscode`, `cursor`, `codebuddy` |
| `port` | HTTP port for the local peer server (auto-assigned from 47631-47700) |
| `workspaceRoots` | Project root paths this instance covers |
| `supportedProjectTypes` | Project types this instance can handle |
| `typeHierarchy` | Defines parent-child relationships between project types |
| `routing.requestTimeoutMs` | Timeout for jump requests (default: 3000ms) |

### Multi-Instance Support

To run multiple instances of the same editor kind on the same project, set an explicit peer ID:

- **VSCode/Cursor/CodeBuddy**: Set environment variable `EDITOR_PEER_BRIDGE_PEER_ID=my-cursor-02`
- **Rider**: Set JVM property `-Deditor.peer.bridge.peerId=my-rider-02`

## How It Works

Each editor instance runs a lightweight HTTP server on localhost. When you trigger a jump:

1. The source editor builds a request with the current file path and selection
2. It sends the request to the target peer's HTTP server
3. The target editor opens the file, restores the selection, and scrolls to it

All communication is local (127.0.0.1) - no data leaves your machine.

## Project Structure

```
EditorPeerBridge/
  rider-peer/          Rider/IntelliJ plugin (Kotlin)
  vscode-peer/         VSCode/Cursor/CodeBuddy extension (TypeScript)
  shared/              Shared protocol definitions
  examples/            Example configurations
```

## Building from Source

### VSCode Extension

```bash
cd vscode-peer
npm install
npm run compile
npx @vscode/vsce package
```

### Rider Plugin

Requires JDK 17+ and Gradle 8+.

```bash
cd rider-peer
gradle buildPlugin
```

Output: `rider-peer/build/distributions/editor-peer-bridge-rider-x.x.x.zip`

## License

[MIT](LICENSE)
