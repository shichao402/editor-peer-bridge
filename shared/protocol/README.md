# Editor Peer Bridge Protocol

JSON schemas in this directory describe the shared wire format and config file shape.

## Cross-IDE behavior

All IDE implementations (`vscode-peer`, `rider-peer`) should behave consistently:

| Capability | Expected behavior |
|------------|-------------------|
| Config repair | **Manual only** (Create / Update Config). Invalid JSON or an invalid self peer block is salvaged/repaired in place; historical `.editor-peer-bridge.json.bak.*` files are deleted on update. No automatic config writes on startup. |
| Config watch | Changes to `.editor-peer-bridge.json` trigger a reconcile pass (debounced ~150ms) that reloads config and restarts the local server if needed — **read-only**, does not rewrite the file. |
| Self peer restart | When the current IDE's peer entry changes (port, roots, project type, etc.), the local HTTP server stops and restarts. |
| Port reassignment | If the configured port is already in use at startup, the peer scans `47631`–`47700` for a free port (skipping ports assigned to other peers) and listens there **for this session only**. The shared config file is not rewritten. |
| Restart Server | Manual command tears down the listener and runs a full reconcile. |
| Open Log | Command opens a disk log file written by the plugin (location is IDE-specific). |
| Jump errors | HTTP client connection failures surface a friendly message, e.g. connection refused with peer name and port. |

### Editor kinds

`editorKind` is one of: `rider`, `vscode`, `cursor`, `codebuddy`.

- **Rider** uses the `rider-peer` IntelliJ plugin.
- **VS Code, Cursor, CodeBuddy** share the `vscode-peer` extension (`editorKind` is detected from `appName`).

### Explicit peer selection

- VS Code family: `EDITOR_PEER_BRIDGE_PEER_ID` environment variable
- Rider: JVM property `-Deditor.peer.bridge.peerId=...`
