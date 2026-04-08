import { randomUUID } from 'crypto'
import * as vscode from 'vscode'
import { loadBridgeConfig, resolveTargetPeers } from './config'
import { BridgeConfig, BridgeResponse, OpenLocationRequest, PeerConfig } from './protocol'

export async function jumpToPeer(output: vscode.OutputChannel): Promise<void> {
  const editor = vscode.window.activeTextEditor
  if (!editor) {
    void vscode.window.showWarningMessage('Editor Peer Bridge: no active editor.')
    return
  }

  const config = await loadBridgeConfig()
  const request = buildOpenLocationRequest(config, editor)
  const candidates = resolveTargetPeers(config, request)

  if (!candidates.length) {
    void vscode.window.showWarningMessage('Editor Peer Bridge: no matching peer found.')
    return
  }

  if (candidates.length === 1) {
    await sendToPeer(candidates[0], request, config, output, true)
    return
  }

  // Multiple candidates: show picker with "All" option
  const choice = await pickTargetPeer(candidates)
  if (!choice) {
    return
  }

  if (choice === 'all') {
    await broadcastToPeers(candidates, request, config, output)
  } else {
    await sendToPeer(choice, request, config, output, true)
  }
}

function buildOpenLocationRequest(config: BridgeConfig, editor: vscode.TextEditor): OpenLocationRequest {
  const selection = editor.selection
  return {
    source: {
      peerId: config.self.peerId,
      editorKind: config.self.editorKind,
      instanceName: config.self.instanceName,
      projectRoot: config.self.workspaceRoots[0],
      projectType: config.self.projectType
    },
    document: {
      filePath: editor.document.uri.fsPath,
      selection: {
        start: { line: selection.start.line + 1, column: selection.start.character + 1 },
        end: { line: selection.end.line + 1, column: selection.end.character + 1 }
      }
    },
    options: {
      activateWindow: true,
      revealMode: 'center'
    }
  }
}

async function pickTargetPeer(candidates: PeerConfig[]): Promise<PeerConfig | 'all' | undefined> {
  interface PeerQuickPickItem extends vscode.QuickPickItem {
    peer: PeerConfig | 'all'
  }

  const items: PeerQuickPickItem[] = [
    {
      label: `$(broadcast) All (${candidates.length} peers)`,
      description: 'Jump to all peers without activating windows',
      peer: 'all'
    },
    ...candidates.map((p): PeerQuickPickItem => ({
      label: p.instanceName,
      description: `${p.editorKind} | ${p.peerId} | :${p.port}`,
      peer: p
    }))
  ]

  const selected = await vscode.window.showQuickPick(items, { placeHolder: 'Select a peer target' })
  return selected?.peer
}

async function sendToPeer(
  target: PeerConfig,
  request: OpenLocationRequest,
  config: BridgeConfig,
  output: vscode.OutputChannel,
  activateWindow: boolean
): Promise<boolean> {
  const actualRequest = activateWindow ? request : { ...request, options: { ...request.options, activateWindow: false } }
  const timeoutMs = config.routing?.requestTimeoutMs ?? 3000
  const response = await postJson<{ targetPeerId: string }>(target, '/peer/v1/open-location', actualRequest, timeoutMs)

  if (!response.ok) {
    output.appendLine(`[peer-client] open-location to ${target.instanceName} failed: ${response.error.code} ${response.error.message}`)
    void vscode.window.showErrorMessage(`Editor Peer Bridge: ${target.instanceName} - ${response.error.message}`)
    return false
  }

  void vscode.window.showInformationMessage(`Editor Peer Bridge: jumped to ${target.instanceName}.`)
  return true
}

async function broadcastToPeers(
  targets: PeerConfig[],
  request: OpenLocationRequest,
  config: BridgeConfig,
  output: vscode.OutputChannel
): Promise<void> {
  const results = await Promise.allSettled(
    targets.map((target) => sendToPeer(target, request, config, output, false))
  )
  const succeeded = results.filter((r) => r.status === 'fulfilled' && r.value).length
  const failed = targets.length - succeeded
  if (failed === 0) {
    void vscode.window.showInformationMessage(`Editor Peer Bridge: jumped to all ${succeeded} peers.`)
  } else {
    void vscode.window.showWarningMessage(`Editor Peer Bridge: ${succeeded} succeeded, ${failed} failed.`)
  }
}

async function postJson<T>(peer: PeerConfig, endpoint: string, body: unknown, timeoutMs: number): Promise<BridgeResponse<T>> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(`http://127.0.0.1:${peer.port}${endpoint}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-Editor-Peer-Protocol-Version': '1',
        'X-Editor-Peer-Request-Id': randomUUID(),
        'X-Editor-Peer-Source': body && typeof body === 'object' && 'source' in (body as Record<string, unknown>)
          ? String((body as { source: { peerId: string } }).source.peerId)
          : 'unknown'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    })

    return await response.json() as BridgeResponse<T>
  } finally {
    clearTimeout(timer)
  }
}
