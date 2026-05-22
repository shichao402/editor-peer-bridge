import * as vscode from 'vscode'
import { ensureConfig, EnsureConfigResult, getBridgeConfigPath } from './config'
import { jumpToPeer } from './peerClient'
import { PeerServer } from './peerServer'

let server: PeerServer | undefined

const CREATE_OR_UPDATE_CONFIG = 'Create/Update Config'
const CREATE_CONFIG = 'Create Config'
const OPEN_CONFIG = 'Open Config'
const SHOW_OUTPUT = 'Show Output'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Editor Peer Bridge')
  context.subscriptions.push(output)

  server = new PeerServer(output)

  context.subscriptions.push(
    vscode.commands.registerCommand('editorPeerBridge.jumpToPeer', async () => {
      try {
        await jumpToPeer(output)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        output.appendLine(`[command] ${message}`)
        await showConfigActionMessage(`Editor Peer Bridge: ${message}`, output, 'error')
      }
    }),
    vscode.commands.registerCommand('editorPeerBridge.createConfig', async () => {
      await runConfigCommand(output)
    }),
    vscode.commands.registerCommand('editorPeerBridge.updateConfig', async () => {
      await runConfigCommand(output)
    }),
    vscode.commands.registerCommand('editorPeerBridge.openConfig', async () => {
      await openConfigDocument(output)
    })
  )

  try {
    await startBridge(output)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[activate] ${message}`)
    await showConfigActionMessage(`Editor Peer Bridge: ${message}`, output, 'warning')
  }
}

async function startBridge(output: vscode.OutputChannel): Promise<EnsureConfigResult> {
  const result = await ensureConfig()
  output.appendLine(`[config] ${result.status}${result.configPath ? `: ${result.configPath}` : ''}`)
  for (const change of result.changes) {
    output.appendLine(`[config] ${change}`)
  }

  if (result.status !== 'skipped') {
    await server?.start()
  }

  return result
}

async function runConfigCommand(output: vscode.OutputChannel): Promise<void> {
  try {
    const result = await startBridge(output)
    const message = formatConfigResultMessage(result)
    const action = await vscode.window.showInformationMessage(message, OPEN_CONFIG)
    if (action === OPEN_CONFIG) {
      await openConfigDocument(output)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[config-command] ${message}`)
    await showConfigActionMessage(`Editor Peer Bridge: ${message}`, output, 'error')
  }
}

function formatConfigResultMessage(result: EnsureConfigResult): string {
  switch (result.status) {
    case 'created':
      return 'Editor Peer Bridge: created config.'
    case 'updated':
      return 'Editor Peer Bridge: updated config.'
    case 'unchanged':
      return 'Editor Peer Bridge: config is already up to date.'
    case 'skipped':
      return `Editor Peer Bridge: ${result.changes[0] ?? 'config skipped.'}`
  }
}

async function openConfigDocument(output: vscode.OutputChannel): Promise<void> {
  const configPath = await getBridgeConfigPath()
  if (!configPath) {
    const action = await vscode.window.showWarningMessage('Editor Peer Bridge: config not found.', CREATE_CONFIG)
    if (action === CREATE_CONFIG) {
      const result = await startBridge(output)
      if (result.configPath) {
        await openPath(result.configPath)
      }
    }
    return
  }

  await openPath(configPath)
}

async function openPath(filePath: string): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(filePath))
  await vscode.window.showTextDocument(document)
}

async function showConfigActionMessage(
  message: string,
  output: vscode.OutputChannel,
  severity: 'warning' | 'error'
): Promise<void> {
  const showMessage = severity === 'error'
    ? vscode.window.showErrorMessage
    : vscode.window.showWarningMessage
  const action = await showMessage(message, CREATE_OR_UPDATE_CONFIG, OPEN_CONFIG, SHOW_OUTPUT)

  if (action === CREATE_OR_UPDATE_CONFIG) {
    await vscode.commands.executeCommand('editorPeerBridge.updateConfig')
  } else if (action === OPEN_CONFIG) {
    await vscode.commands.executeCommand('editorPeerBridge.openConfig')
  } else if (action === SHOW_OUTPUT) {
    output.show()
  }
}

export async function deactivate(): Promise<void> {
  await server?.stop()
}
