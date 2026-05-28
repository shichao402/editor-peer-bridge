import * as vscode from 'vscode'
import { BridgeController, getBridgeConfigPath } from './bridgeController'
import { jumpToPeer } from './peerClient'
import { StatusBarController } from './statusBar'

let controller: BridgeController | undefined

const RELOAD_CONFIG = 'Reload Config'
const CREATE_CONFIG = 'Create Config'
const OPEN_CONFIG = 'Open Config'
const SHOW_OUTPUT = 'Show Output'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('Editor Peer Bridge')
  context.subscriptions.push(output)

  controller = new BridgeController(output)
  const statusBar = new StatusBarController()
  context.subscriptions.push({
    dispose: () => {
      statusBar.dispose()
      void controller?.dispose()
      controller = undefined
    }
  })

  context.subscriptions.push(
    controller.onDidReconcile((outcome) => statusBar.update(outcome))
  )

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
    const outcome = await controller.reconcile()
    if (outcome.error) {
      throw outcome.error
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    output.appendLine(`[activate] ${message}`)
    await showConfigActionMessage(`Editor Peer Bridge: ${message}`, output, 'warning')
  }
}

async function runConfigCommand(output: vscode.OutputChannel): Promise<void> {
  if (!controller) {
    return
  }

  try {
    const outcome = await controller.reconcile()
    if (outcome.error) {
      throw outcome.error
    }

    const message = formatConfigOutcomeMessage(outcome)
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

function formatConfigOutcomeMessage(outcome: { configResult: { status: string; changes: string[] }; activePort?: number; portReassigned: boolean }): string {
  const portSuffix = outcome.activePort
    ? outcome.portReassigned
      ? ` Server is listening on port ${outcome.activePort} (reassigned).`
      : ` Server is listening on port ${outcome.activePort}.`
    : ''

  switch (outcome.configResult.status) {
    case 'created':
      return `Editor Peer Bridge: created config.${portSuffix}`
    case 'updated':
      return `Editor Peer Bridge: updated config.${portSuffix}`
    case 'unchanged':
      return `Editor Peer Bridge: config is already up to date.${portSuffix}`
    case 'skipped':
      return `Editor Peer Bridge: ${outcome.configResult.changes[0] ?? 'config skipped.'}`
    default:
      return `Editor Peer Bridge: reconciled.${portSuffix}`
  }
}

async function openConfigDocument(output: vscode.OutputChannel): Promise<void> {
  const configPath = await getBridgeConfigPath()
  if (!configPath) {
    const action = await vscode.window.showWarningMessage('Editor Peer Bridge: config not found.', CREATE_CONFIG)
    if (action === CREATE_CONFIG && controller) {
      const outcome = await controller.reconcile()
      if (outcome.configResult.configPath) {
        await openPath(outcome.configResult.configPath)
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
  const action = await showMessage(message, RELOAD_CONFIG, OPEN_CONFIG, SHOW_OUTPUT)

  if (action === RELOAD_CONFIG) {
    await vscode.commands.executeCommand('editorPeerBridge.updateConfig')
  } else if (action === OPEN_CONFIG) {
    await vscode.commands.executeCommand('editorPeerBridge.openConfig')
  } else if (action === SHOW_OUTPUT) {
    output.show()
  }
}

export async function deactivate(): Promise<void> {
  await controller?.dispose()
  controller = undefined
}
