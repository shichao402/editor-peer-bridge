# Editor Peer Bridge

Editor Peer Bridge is a local cross-editor navigation bridge for teams and solo developers who use Rider together with VS Code-compatible editors.

Jump from VS Code, Cursor, or CodeBuddy to the matching location in JetBrains Rider, or send the current file and selection from one VS Code-compatible editor to another peer in the same workspace.

## Features

- **Cross-editor jump**: open the same file and selection in Rider, VS Code, Cursor, or CodeBuddy.
- **Multi-target picker**: choose a specific peer or broadcast to all available peers.
- **Automatic config**: creates `.editor-peer-bridge.json` on first launch.
- **Workspace-aware routing**: reads config from the project root or a parent directory.
- **Multi-instance support**: supports explicit peer IDs for multiple editor windows.
- **Rider solution detection**: Rider peers can route by loaded `.sln` / `.slnx` project type.
- **Local-only communication**: peers talk over localhost; file paths and selections are not sent to any external service.

## Supported editors

| Editor | Support |
| --- | --- |
| VS Code | Native extension |
| Cursor | Uses the VS Code extension package |
| CodeBuddy | Uses the VS Code extension package |
| JetBrains Rider | Companion Rider plugin |

## Quick start

1. Install this extension in VS Code, Cursor, or CodeBuddy.
2. Install the companion Rider plugin if you want to jump to or from Rider.
3. Open the same project in two or more editors.
4. Run `Editor Peer Bridge: Jump To Peer`.
5. If multiple peers are available, select a target or choose `All`.

On first launch, the extension creates `.editor-peer-bridge.json` in your workspace. You can keep the generated defaults or edit the file to customize peer IDs, ports, project types, and routing timeouts.

## Configuration summary

The bridge configuration contains:

- `peers`: editor instances participating in the bridge.
- `peerId`: unique ID for each instance.
- `editorKind`: one of `rider`, `vscode`, `cursor`, or `codebuddy`.
- `port`: local HTTP port, auto-assigned from `47631` to `47700`.
- `workspaceRoots`: project roots covered by the peer.
- `supportedProjectTypes`: project types a peer can handle.
- `typeHierarchy`: parent-child relationships between project types.
- `routing.requestTimeoutMs`: timeout for jump requests.
- `ui.focusOnJump`: allow OS-level window focusing after receiving a jump. Defaults to `false`.

VS Code, Cursor, and CodeBuddy also expose `editorPeerBridge.focusOnJump` in Settings. This setting is disabled by default and must be enabled before the extension raises the editor window to the OS foreground.

For multiple VS Code-compatible editor instances, set `EDITOR_PEER_BRIDGE_PEER_ID` before launching the editor.

## Privacy

Editor Peer Bridge is designed for local navigation. Communication happens on `127.0.0.1`; the extension does not upload code, file paths, selections, or configuration to external services.
