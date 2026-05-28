import * as path from 'path'
import * as vscode from 'vscode'
import {
  EnsureConfigResult,
  ensureConfig,
  getBridgeConfigPath,
  loadBridgeConfig,
  updateSelfPort
} from './config'
import { PeerServer, PeerServerState } from './peerServer'
import { BridgeConfig } from './protocol'

export interface ReconcileOutcome {
  configResult: EnsureConfigResult
  /** Final port the server is listening on (if server is up). */
  activePort?: number
  /** True when ensureListening had to switch off the configured port. */
  portReassigned: boolean
  /** Listen / config error, if reconciliation failed. */
  error?: Error
  /** Resolved bridge config (absent when reconcile bailed out before load). */
  bridgeConfig?: BridgeConfig
  /** Effective server state at the end of this reconcile. */
  state: PeerServerState
}

/**
 * Owns the lifecycle of the peer server: ensures the config exists, keeps
 * the server listening, and reacts to changes in `.editor-peer-bridge.json`.
 *
 * All entry points (activation, commands, file watcher) funnel through
 * `reconcile()`, which is idempotent and serialised so concurrent triggers
 * cannot fight each other.
 */
export class BridgeController implements vscode.Disposable {
  private readonly server: PeerServer
  private readonly disposables: vscode.Disposable[] = []
  private readonly reconcileEmitter = new vscode.EventEmitter<ReconcileOutcome>()
  /** Fires after every reconcile attempt (success or failure). */
  readonly onDidReconcile = this.reconcileEmitter.event
  private watcher?: vscode.FileSystemWatcher
  private watchedPath?: string
  private inflight: Promise<ReconcileOutcome> | undefined
  private pending = false
  private debounceTimer?: NodeJS.Timeout
  private disposed = false

  constructor(private readonly output: vscode.OutputChannel) {
    this.server = new PeerServer(output)
    this.disposables.push(this.reconcileEmitter)
  }

  /**
   * Run a reconcile pass: ensure config → load config → ensure server listening.
   * Concurrent calls coalesce into one tail-end run so we don't restart the
   * server multiple times for a burst of file events.
   */
  async reconcile(): Promise<ReconcileOutcome> {
    if (this.inflight) {
      this.pending = true
      return this.inflight
    }

    this.inflight = this.runReconcile()
    try {
      const result = await this.inflight
      if (!this.disposed) {
        this.reconcileEmitter.fire(result)
      }
      return result
    } finally {
      this.inflight = undefined
      if (this.pending && !this.disposed) {
        this.pending = false
        // Schedule a follow-up so a change that arrived mid-run isn't lost.
        // We don't await it: the original caller already has its outcome.
        void this.reconcile()
      }
    }
  }

  private async runReconcile(): Promise<ReconcileOutcome> {
    const configResult = await ensureConfig()
    this.output.appendLine(
      `[config] ${configResult.status}${configResult.configPath ? `: ${configResult.configPath}` : ''}`
    )
    for (const change of configResult.changes) {
      this.output.appendLine(`[config] ${change}`)
    }

    if (configResult.status === 'skipped') {
      // No workspace / nothing we can do. Make sure we're not leaking a server.
      await this.server.stop()
      return { configResult, portReassigned: false, state: this.server.state }
    }

    // (Re)bind watcher to the resolved config path so manual edits are picked up.
    this.ensureWatcher(configResult.configPath)

    let bridgeConfig: BridgeConfig
    try {
      bridgeConfig = await loadBridgeConfig()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.output.appendLine(`[controller] failed to load config: ${error.message}`)
      return { configResult, portReassigned: false, error, state: this.server.state }
    }

    const configuredPort = bridgeConfig.self.port
    let portReassigned = false

    try {
      await this.server.ensureListening(bridgeConfig, {
        onPortReassigned: async (newPort, previousPort) => {
          portReassigned = true
          if (configResult.configPath) {
            await updateSelfPort(configResult.configPath, bridgeConfig.self.peerId, newPort)
            this.output.appendLine(
              `[controller] persisted port ${previousPort} → ${newPort} for peer ${bridgeConfig.self.peerId}.`
            )
          }
        }
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.output.appendLine(`[controller] ensureListening failed: ${error.message}`)
      return { configResult, portReassigned, error, bridgeConfig, state: this.server.state }
    }

    return {
      configResult,
      activePort: this.server.listeningPort ?? configuredPort,
      portReassigned,
      bridgeConfig,
      state: this.server.state
    }
  }

  private ensureWatcher(configPath: string | undefined): void {
    if (!configPath || this.watchedPath === configPath || this.disposed) {
      return
    }

    // Replace any previous watcher pointing at a stale path.
    this.watcher?.dispose()

    // Use a RelativePattern anchored at the config's parent directory. This
    // supports configs that live above the workspace root (parent-directory
    // discovery in findConfigPath) as well as configs inside the workspace.
    const dir = path.dirname(configPath)
    const fileName = path.basename(configPath)
    const pattern = new vscode.RelativePattern(vscode.Uri.file(dir), fileName)
    const watcher = vscode.workspace.createFileSystemWatcher(pattern)
    this.watcher = watcher
    this.watchedPath = configPath

    const trigger = (kind: 'change' | 'create' | 'delete') => {
      this.output.appendLine(`[controller] config ${kind} detected, scheduling reconcile.`)
      this.scheduleReconcile()
    }

    this.disposables.push(
      watcher,
      watcher.onDidChange(() => trigger('change')),
      watcher.onDidCreate(() => trigger('create')),
      watcher.onDidDelete(() => trigger('delete'))
    )
  }

  private scheduleReconcile(): void {
    if (this.disposed) return
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined
      void this.reconcile()
    }, 150)
  }

  /** Status snapshot for surfacing in error messages / future status bar. */
  get status(): { state: PeerServerState; port?: number; error?: Error } {
    return {
      state: this.server.state,
      port: this.server.listeningPort,
      error: this.server.lastError
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = undefined
    }
    for (const d of this.disposables.splice(0)) {
      try {
        d.dispose()
      } catch {
        // best-effort
      }
    }
    this.watcher = undefined
    this.watchedPath = undefined
    await this.server.stop()
  }
}

export { getBridgeConfigPath }
