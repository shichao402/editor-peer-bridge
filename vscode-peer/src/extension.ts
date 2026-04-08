import * as vscode from 'vscode'
import { ensureConfig, loadBridgeConfig } from './config'
import { jumpToPeer } from './peerClient'
import { PeerServer } from './peerServer'

let server: PeerServer | undefined

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Editor Peer Bridge')
  context.subscriptions.push(output)

  server = new PeerServer(output)

  try {
    await ensureConfig()
    await loadBridgeConfig()
    await server.start()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[activate] ${message}`)
    void vscode.window.showWarningMessage('Editor Peer Bridge: config not found, server not started.')
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('editorPeerBridge.jumpToPeer', async () => {
      try {
        await jumpToPeer(output)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[command] ${message}`)
        void vscode.window.showErrorMessage(`Editor Peer Bridge: ${message}`)
      }
    })
  )
}

export async function deactivate(): Promise<void> {
  await server?.stop()
}
