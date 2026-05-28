import * as vscode from 'vscode'
import { isStatusBarEnabled } from './config'
import { ReconcileOutcome } from './bridgeController'

const COMMAND_ID = 'editorPeerBridge.openConfig'

/**
 * Status bar indicator for the peer server. Visibility is gated by the
 * `ui.statusBar` field in the bridge config (default: enabled). The item is
 * created lazily so users who disable the indicator pay nothing.
 */
export class StatusBarController implements vscode.Disposable {
  private item?: vscode.StatusBarItem

  dispose(): void {
    this.item?.dispose()
    this.item = undefined
  }

  update(outcome: ReconcileOutcome): void {
    const enabled = outcome.bridgeConfig
      ? isStatusBarEnabled(outcome.bridgeConfig)
      : true // before config loads, default to showing

    if (!enabled) {
      this.item?.hide()
      return
    }

    const item = this.ensureItem()
    const { state, activePort, portReassigned, error } = outcome

    if (error) {
      item.text = '$(error) Bridge: error'
      item.tooltip = `Editor Peer Bridge failed: ${error.message}\nClick to open config.`
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.errorBackground')
    } else if (state === 'listening' && activePort) {
      const reassignedSuffix = portReassigned ? ' (reassigned)' : ''
      item.text = `$(broadcast) Bridge :${activePort}`
      item.tooltip = `Editor Peer Bridge listening on 127.0.0.1:${activePort}${reassignedSuffix}.\nClick to open config.`
      item.backgroundColor = portReassigned
        ? new vscode.ThemeColor('statusBarItem.warningBackground')
        : undefined
    } else {
      item.text = '$(circle-slash) Bridge stopped'
      item.tooltip = 'Editor Peer Bridge is not running.\nClick to open config.'
      item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground')
    }

    item.show()
  }

  private ensureItem(): vscode.StatusBarItem {
    if (!this.item) {
      this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
      this.item.name = 'Editor Peer Bridge'
      this.item.command = COMMAND_ID
    }
    return this.item
  }
}
