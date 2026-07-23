import * as path from 'path'
import * as vscode from 'vscode'
import {
  EnsureConfigResult,
  bindPeerIdToWorkspace,
  ensureConfig,
  getBridgeConfigPath,
  loadBridgeConfig,
  selfPeerConfigChanged,
  setConfigContext
} from './config'
import { PeerServer, PeerServerState } from './peerServer'
import { BridgeConfig, PeerEntry } from './protocol'

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
 * Owns the lifecycle of the peer server: loads the shared config, keeps the
 * server listening, and reacts to changes in `.editor-peer-bridge.json`.
 *
 * Config file writes happen only via `syncConfig()` (Create / Update Config).
 * Startup, file watching, and Restart Server are read-only against the config.
 *
 * All entry points funnel through `reconcile()` / `syncConfig()`, which are
 * idempotent and serialised so concurrent triggers cannot fight each other.
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
  private lastKnownSelfPeer?: PeerEntry

  constructor(
    private readonly output: vscode.OutputChannel,
    workspaceState?: vscode.Memento
  ) {
    setConfigContext({ workspaceState })
    this.server = new PeerServer(output)
    this.disposables.push(this.reconcileEmitter)
  }

  /**
   * Manually create/repair/update `.editor-peer-bridge.json`, then reconcile
   * the local server against the result.
   */
  async syncConfig(): Promise<ReconcileOutcome> {
    const configResult = await ensureConfig()
    if (configResult.peerId) {
      await bindPeerIdToWorkspace(configResult.peerId)
    }
    this.output.appendLine(
      `[config] ${configResult.status}${configResult.configPath ? `: ${configResult.configPath}` : ''}`
    )
    for (const change of configResult.changes) {
      this.output.appendLine(`[config] ${change}`)
    }

    const outcome = await this.reconcile()
    return {
      ...outcome,
      configResult
    }
  }

  /**
   * Run a reconcile pass: load config → ensure server listening.
   * Does not write the shared config file.
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
    const configPath = await getBridgeConfigPath()
    if (!configPath) {
      await this.server.stop()
      const configResult: EnsureConfigResult = {
        status: 'skipped',
        changes: ['Config not found: .editor-peer-bridge.json. Use Create Config / Update Config.']
      }
      this.output.appendLine(`[config] ${configResult.status}`)
      for (const change of configResult.changes) {
        this.output.appendLine(`[config] ${change}`)
      }
      return { configResult, portReassigned: false, state: this.server.state }
    }

    const configResult: EnsureConfigResult = {
      status: 'unchanged',
      configPath,
      changes: []
    }
    this.output.appendLine(`[config] ${configResult.status}: ${configPath}`)
    this.ensureWatcher(configPath)

    let bridgeConfig: BridgeConfig
    try {
      bridgeConfig = await loadBridgeConfig()
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.output.appendLine(`[controller] failed to load config: ${error.message}`)
      return { configResult, portReassigned: false, error, state: this.server.state }
    }

    await bindPeerIdToWorkspace(bridgeConfig.self.peerId)
    configResult.peerId = bridgeConfig.self.peerId

    const configuredPort = bridgeConfig.self.port
    let portReassigned = false
    const shouldRestartForSelfChange = selfPeerConfigChanged(this.lastKnownSelfPeer, bridgeConfig.self)

    if (shouldRestartForSelfChange) {
      const previousPort = this.server.listeningPort
      await this.server.stop()
      if (previousPort !== undefined) {
        this.output.appendLine(
          `[controller] self peer config changed, stopped server on port ${previousPort} before restart.`
        )
      } else {
        this.output.appendLine('[controller] self peer config changed, restarting server.')
      }
    }

    try {
      await this.server.ensureListening(bridgeConfig, {
        onPortReassigned: async (newPort, previousPort) => {
          portReassigned = true
          bridgeConfig = {
            ...bridgeConfig,
            self: { ...bridgeConfig.self, port: newPort }
          }
          this.output.appendLine(
            `[controller] port ${previousPort} was busy, switched to ${newPort} for this session (config not modified).`
          )
        }
      })
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      this.output.appendLine(`[controller] ensureListening failed: ${error.message}`)
      return { configResult, portReassigned, error, bridgeConfig, state: this.server.state }
    }

    this.lastKnownSelfPeer = { ...bridgeConfig.self }

    return {
      configResult,
      activePort: this.server.effectivePort ?? configuredPort,
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

  /**
   * Stop the peer server and run a full reconcile pass (reload + listen).
   * Unlike a plain reconcile, this always tears down an active listener first.
   * Does not write the shared config file.
   */
  async restartServer(): Promise<ReconcileOutcome> {
    const previousPort = this.server.listeningPort
    await this.server.stop()
    this.lastKnownSelfPeer = undefined
    if (previousPort !== undefined) {
      this.output.appendLine(`[controller] stopped server on port ${previousPort} for manual restart.`)
    } else {
      this.output.appendLine('[controller] server was not listening; starting fresh.')
    }
    return this.reconcile()
  }

  /** Status snapshot for surfacing in error messages / future status bar. */
  get status(): { state: PeerServerState; port?: number; error?: Error } {
    return {
      state: this.server.state,
      port: this.server.effectivePort,
      error: this.server.lastError
    }
  }

  async dispose(): Promise<void> {
    this.disposed = true
    setConfigContext(undefined)
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
