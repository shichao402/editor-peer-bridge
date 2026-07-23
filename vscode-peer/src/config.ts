import * as fs from 'fs/promises'
import * as net from 'net'
import * as path from 'path'
import * as vscode from 'vscode'
import { BridgeConfig, EditorKind, OpenLocationRequest, PeerConfig, PeerEntry, RawBridgeConfig } from './protocol'
import { normalizePath, normalizeStoredPath, pathMatchesRoots, projectTypeMatches } from './pathUtils'

export { selfPeerConfigChanged } from './selfPeerSync'

const CONFIG_FILE_NAME = '.editor-peer-bridge.json'
const PORT_RANGE_START = 47631
const PORT_RANGE_END = 47700
const SETTINGS_SECTION = 'editorPeerBridge'
const FOCUS_ON_JUMP_SETTING = 'focusOnJump'
const WORKSPACE_PEER_ID_KEY = 'editorPeerBridge.assignedPeerId'
const EDITOR_KINDS: readonly EditorKind[] = ['rider', 'vscode', 'cursor', 'codebuddy']

export interface ConfigContext {
  workspaceState?: vscode.Memento
}

let activeConfigContext: ConfigContext | undefined

/** Bind this VS Code/Cursor window to a stable peer entry for the lifetime of the workspace. */
export function setConfigContext(context: ConfigContext | undefined): void {
  activeConfigContext = context
}

function getEffectiveExplicitPeerId(): string | undefined {
  return process.env.EDITOR_PEER_BRIDGE_PEER_ID
    ?? activeConfigContext?.workspaceState?.get<string>(WORKSPACE_PEER_ID_KEY)
}

export async function bindPeerIdToWorkspace(peerId: string): Promise<void> {
  const workspaceState = activeConfigContext?.workspaceState
  if (!workspaceState) {
    return
  }

  const current = workspaceState.get<string>(WORKSPACE_PEER_ID_KEY)
  if (current === peerId) {
    return
  }

  await workspaceState.update(WORKSPACE_PEER_ID_KEY, peerId)
}

interface ParsedBridgeConfig {
  raw: RawBridgeConfig
  warnings: string[]
}

type ParseBridgeConfigResult =
  | { ok: true; parsed: ParsedBridgeConfig }
  | { ok: false; error: string }

export type EnsureConfigStatus = 'created' | 'updated' | 'unchanged' | 'skipped'

export interface EnsureConfigResult {
  status: EnsureConfigStatus
  configPath?: string
  peerId?: string
  changes: string[]
}

async function detectSolutionName(workspaceRoot: string): Promise<string | undefined> {
  try {
    const entries = await fs.readdir(workspaceRoot)
    const slnFiles = entries.filter((f) => /\.slnx?$/i.test(f))
    if (slnFiles.length !== 1) return undefined
    const name = slnFiles[0].replace(/\.slnx?$/i, '')
    const sanitized = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
    return sanitized || undefined
  } catch {
    return undefined
  }
}

function detectEditorKind(): EditorKind {
  const appName = vscode.env.appName.toLowerCase()
  if (appName.includes('codebuddy')) {
    return 'codebuddy'
  }
  if (appName.includes('cursor')) {
    return 'cursor'
  }

  return 'vscode'
}

export async function loadBridgeConfig(): Promise<BridgeConfig> {
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) {
    throw new Error('No workspace folder is open.')
  }

  const configPath = await findConfigPath(workspaceRoot)
  if (!configPath) {
    throw new Error(`Could not find ${CONFIG_FILE_NAME} from ${workspaceRoot} or its parent directories.`)
  }

  const content = await fs.readFile(configPath, 'utf8')
  const parsed = parseBridgeConfigContent(content)
  if (!parsed.ok) {
    throw new Error(`Invalid ${CONFIG_FILE_NAME}: ${parsed.error}`)
  }

  const solutionName = await detectSolutionName(workspaceRoot)
  return resolveBridgeConfig(parsed.parsed.raw, detectEditorKind(), solutionName, workspaceRoot)
}

function resolveBridgeConfig(
  raw: RawBridgeConfig,
  myEditorKind: EditorKind,
  solutionName: string | undefined,
  workspaceRoot: string
): BridgeConfig {
  const entries = Object.values(raw.peers)
  const explicitPeerId = getEffectiveExplicitPeerId()
  const projectType = solutionName ?? 'all'

  const self = findSelfPeer(entries, myEditorKind, explicitPeerId, projectType, workspaceRoot)

  if (!self) {
    const searchKey = explicitPeerId ?? `${myEditorKind}@${normalizeStoredPath(workspaceRoot)}`
    throw new Error(`No peer entry found for "${searchKey}" in .editor-peer-bridge.json`)
  }

  const knownPeers = entries.filter((p) => p.peerId !== self.peerId)

  return {
    self,
    knownPeers,
    typeHierarchy: raw.typeHierarchy,
    routing: raw.routing,
    ui: raw.ui
  }
}

export function isStatusBarEnabled(config: BridgeConfig): boolean {
  // Default to true when the user hasn't expressed a preference.
  return config.ui?.statusBar !== false
}

export function isFocusOnJumpEnabled(config: BridgeConfig): boolean {
  // Disabled by default. The VS Code/Cursor setting is the user-visible
  // switch; the bridge config can still force this off for a workspace.
  const enabledInSettings = vscode.workspace
    .getConfiguration(SETTINGS_SECTION)
    .get<boolean>(FOCUS_ON_JUMP_SETTING, false)
  return enabledInSettings && config.ui?.focusOnJump !== false
}

export function getPrimaryWorkspaceRoot(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

export async function getBridgeConfigPath(): Promise<string | undefined> {
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) return undefined
  return findConfigPath(workspaceRoot)
}

async function findConfigPath(startDirectory: string): Promise<string | undefined> {
  let currentDirectory = path.resolve(startDirectory)

  while (true) {
    const candidate = path.join(currentDirectory, CONFIG_FILE_NAME)
    try {
      await fs.access(candidate)
      return candidate
    } catch {
      // keep walking upward
    }

    const parentDirectory = path.dirname(currentDirectory)
    if (parentDirectory === currentDirectory) {
      return undefined
    }

    currentDirectory = parentDirectory
  }
}

// ── Config parse / validate / backup cleanup ──

export async function cleanupConfigBackups(configPath: string): Promise<string[]> {
  const dir = path.dirname(configPath)
  const prefix = `${path.basename(configPath)}.bak.`
  let entries: string[]
  try {
    entries = await fs.readdir(dir)
  } catch {
    return []
  }

  const removed: string[] = []
  for (const name of entries) {
    if (!name.startsWith(prefix)) {
      continue
    }
    try {
      await fs.unlink(path.join(dir, name))
      removed.push(name)
    } catch {
      // best-effort cleanup
    }
  }
  return removed
}

function isEditorKind(value: unknown): value is EditorKind {
  return typeof value === 'string' && (EDITOR_KINDS as readonly string[]).includes(value)
}

function isValidPort(port: unknown): port is number {
  return typeof port === 'number'
    && Number.isInteger(port)
    && port >= PORT_RANGE_START
    && port <= PORT_RANGE_END
}

function validatePeerEntry(value: unknown): PeerEntry | null {
  if (!value || typeof value !== 'object') {
    return null
  }

  const peer = value as Partial<PeerEntry>
  if (typeof peer.peerId !== 'string' || !peer.peerId.trim()) {
    return null
  }
  if (!isEditorKind(peer.editorKind)) {
    return null
  }
  if (typeof peer.instanceName !== 'string' || !peer.instanceName.trim()) {
    return null
  }
  if (!isValidPort(peer.port)) {
    return null
  }
  if (!Array.isArray(peer.workspaceRoots) || peer.workspaceRoots.some((root) => typeof root !== 'string')) {
    return null
  }
  if (!Array.isArray(peer.supportedProjectTypes)
    || peer.supportedProjectTypes.some((type) => typeof type !== 'string')) {
    return null
  }
  if (typeof peer.projectType !== 'string' || !peer.projectType.trim()) {
    return null
  }

  return {
    peerId: peer.peerId,
    editorKind: peer.editorKind,
    instanceName: peer.instanceName,
    port: peer.port,
    workspaceRoots: peer.workspaceRoots,
    supportedProjectTypes: peer.supportedProjectTypes,
    projectType: peer.projectType
  }
}

function salvageRawBridgeConfig(data: unknown): { raw: RawBridgeConfig | null; warnings: string[] } {
  const warnings: string[] = []
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { raw: null, warnings: ['Root value is not a JSON object.'] }
  }

  const obj = data as Record<string, unknown>
  const peers: Record<string, PeerEntry> = {}

  if (obj.peers && typeof obj.peers === 'object' && !Array.isArray(obj.peers)) {
    for (const [key, value] of Object.entries(obj.peers)) {
      const peer = validatePeerEntry(value)
      if (peer) {
        const peerId = peer.peerId || key
        peers[peerId] = { ...peer, peerId }
      } else {
        warnings.push(`Dropped invalid peer entry "${key}".`)
      }
    }
  } else {
    warnings.push('Missing or invalid peers object.')
  }

  const typeHierarchy: Record<string, string[]> = { all: [] }
  if (obj.typeHierarchy && typeof obj.typeHierarchy === 'object' && !Array.isArray(obj.typeHierarchy)) {
    for (const [key, value] of Object.entries(obj.typeHierarchy)) {
      if (Array.isArray(value) && value.every((item) => typeof item === 'string')) {
        typeHierarchy[key] = [...value]
      } else {
        warnings.push(`Dropped invalid typeHierarchy entry "${key}".`)
      }
    }
  } else {
    warnings.push('Missing or invalid typeHierarchy; using defaults.')
  }

  if (!typeHierarchy.all) {
    typeHierarchy.all = []
  }

  const routing = obj.routing && typeof obj.routing === 'object' && !Array.isArray(obj.routing)
    ? obj.routing as RawBridgeConfig['routing']
    : undefined

  const ui = obj.ui && typeof obj.ui === 'object' && !Array.isArray(obj.ui)
    ? obj.ui as RawBridgeConfig['ui']
    : undefined

  return {
    raw: {
      peers,
      typeHierarchy,
      routing,
      ui
    },
    warnings
  }
}

function parseBridgeConfigContent(content: string): ParseBridgeConfigResult {
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `JSON parse error: ${message}` }
  }

  const salvaged = salvageRawBridgeConfig(data)
  if (!salvaged.raw) {
    return { ok: false, error: salvaged.warnings.join(' ') }
  }

  return { ok: true, parsed: { raw: salvaged.raw, warnings: salvaged.warnings } }
}

// ── Manual config sync: create/repair/update only when the user asks ──

export async function ensureConfig(): Promise<EnsureConfigResult> {
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) {
    return { status: 'skipped', changes: ['No workspace folder is open.'] }
  }

  const editorKind = detectEditorKind()
  const explicitPeerId = getEffectiveExplicitPeerId()
  const solutionName = await detectSolutionName(workspaceRoot)
  const existingPath = await findConfigPath(workspaceRoot)

  if (existingPath) {
    return ensureSelfInConfig(existingPath, editorKind, workspaceRoot, explicitPeerId, solutionName)
  }

  return createInitialConfig(workspaceRoot, editorKind, explicitPeerId, solutionName)
}

async function ensureSelfInConfig(
  configPath: string,
  editorKind: EditorKind,
  workspaceRoot: string,
  explicitPeerId: string | undefined,
  solutionName: string | undefined
): Promise<EnsureConfigResult> {
  const changes: string[] = []
  const projectType = solutionName ?? 'all'

  let content: string
  try {
    content = await fs.readFile(configPath, 'utf8')
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { status: 'skipped', changes: [`Failed to read config: ${message}`] }
  }

  const parsed = parseBridgeConfigContent(content)
  let raw: RawBridgeConfig

  if (!parsed.ok) {
    changes.push(`Config repair: ${parsed.error}`)
    return createInitialConfigAt(configPath, workspaceRoot, editorKind, explicitPeerId, solutionName, changes)
  }

  raw = parsed.parsed.raw
  if (parsed.parsed.warnings.length > 0) {
    for (const warning of parsed.parsed.warnings) {
      changes.push(warning)
    }
  }

  normalizePeerWorkspaceRoots(Object.values(raw.peers), changes)

  let self = findSelfPeer(Object.values(raw.peers), editorKind, explicitPeerId, projectType, workspaceRoot)
  if (self && !validatePeerEntry(self)) {
    changes.push(`Removed invalid self peer ${self.peerId}; will recreate or repair.`)
    delete raw.peers[self.peerId]
    self = undefined
  }

  const storedWorkspaceRoot = normalizeStoredPath(workspaceRoot)

  if (!self) {
    const entries = Object.values(raw.peers)
    const usedPorts = new Set(entries.map((p) => p.port))
    const port = await findAvailablePort(usedPorts)
    const peerId = explicitPeerId ?? generatePeerId(editorKind, entries)
    const instanceName = solutionName
      ? `${capitalize(editorKind)} (${solutionName})`
      : generateInstanceName(editorKind, entries)

    const newPeer: PeerEntry = {
      peerId,
      editorKind,
      instanceName,
      port,
      workspaceRoots: [storedWorkspaceRoot],
      supportedProjectTypes: [projectType],
      projectType
    }

    raw.peers[peerId] = newPeer
    changes.push(`Added peer ${peerId}.`)
    ensureProjectType(raw, projectType, changes)
    changes.push(...await writeConfigFile(configPath, raw))

    return { status: 'updated', configPath, peerId, changes }
  }

  if (shouldAppendWorkspaceRoot(self, storedWorkspaceRoot)) {
    self.workspaceRoots = [...self.workspaceRoots, storedWorkspaceRoot]
    changes.push(`Added workspace root ${storedWorkspaceRoot}.`)
  }

  if (!self.supportedProjectTypes.includes(projectType)) {
    self.supportedProjectTypes = [...self.supportedProjectTypes, projectType]
    changes.push(`Added supported project type ${projectType}.`)
  }

  if (self.projectType !== projectType) {
    self.projectType = projectType
    changes.push(`Updated project type to ${projectType}.`)
  }

  ensureProjectType(raw, projectType, changes)

  if (changes.length > 0) {
    changes.push(...await writeConfigFile(configPath, raw))
    return { status: 'updated', configPath, peerId: self.peerId, changes }
  }

  const removedBackups = await cleanupConfigBackups(configPath)
  if (removedBackups.length > 0) {
    changes.push(`Removed ${removedBackups.length} config backup file(s).`)
    return { status: 'updated', configPath, peerId: self.peerId, changes }
  }

  return { status: 'unchanged', configPath, peerId: self.peerId, changes }
}

function peerMatchesPrimaryWorkspace(peer: PeerEntry, workspaceRoot: string): boolean {
  const currentPath = normalizePath(normalizeStoredPath(workspaceRoot))
  const primary = peer.workspaceRoots[0]
  if (primary && normalizePath(primary) === currentPath) {
    return true
  }

  return peer.workspaceRoots.length === 1 && normalizePath(peer.workspaceRoots[0]) === currentPath
}

function shouldAppendWorkspaceRoot(peer: PeerEntry, workspaceRoot: string): boolean {
  if (containsWorkspaceRoot(peer.workspaceRoots, workspaceRoot)) {
    return false
  }

  const currentPath = normalizePath(normalizeStoredPath(workspaceRoot))
  const isStrictChildOfPeerRoot = peer.workspaceRoots.some((root) => {
    const normalizedRoot = normalizePath(root)
    return normalizedRoot !== currentPath && currentPath.startsWith(`${normalizedRoot}/`)
  })

  // A child folder opened as its own workspace should get its own peer, not be merged in.
  return !isStrictChildOfPeerRoot
}

function findSelfPeer(
  entries: PeerEntry[],
  editorKind: EditorKind,
  explicitPeerId: string | undefined,
  projectType: string,
  workspaceRoot: string
): PeerEntry | undefined {
  if (explicitPeerId) {
    return entries.find((p) => p.peerId === explicitPeerId)
  }

  const byKind = entries.filter((p) => p.editorKind === editorKind)

  return (
    byKind.find((p) => p.projectType === projectType && peerMatchesPrimaryWorkspace(p, workspaceRoot)) ??
    byKind.find((p) => peerMatchesPrimaryWorkspace(p, workspaceRoot))
  )
}

function ensureProjectType(raw: RawBridgeConfig, projectType: string, changes: string[]): void {
  if (!raw.typeHierarchy) {
    raw.typeHierarchy = { all: [] }
    changes.push('Created type hierarchy.')
  }

  if (!raw.typeHierarchy.all) {
    raw.typeHierarchy.all = []
    changes.push('Added root type hierarchy entry.')
  }

  if (projectType !== 'all' && !raw.typeHierarchy[projectType]) {
    raw.typeHierarchy[projectType] = []
    changes.push(`Added type hierarchy entry ${projectType}.`)
  }

  if (projectType !== 'all' && !raw.typeHierarchy.all.includes(projectType)) {
    raw.typeHierarchy.all = [...raw.typeHierarchy.all, projectType]
    changes.push(`Linked ${projectType} under all.`)
  }
}

async function createInitialConfig(
  workspaceRoot: string,
  editorKind: EditorKind,
  explicitPeerId: string | undefined,
  solutionName: string | undefined
): Promise<EnsureConfigResult> {
  const configPath = path.join(workspaceRoot, CONFIG_FILE_NAME)
  return createInitialConfigAt(configPath, workspaceRoot, editorKind, explicitPeerId, solutionName, [])
}

async function createInitialConfigAt(
  configPath: string,
  workspaceRoot: string,
  editorKind: EditorKind,
  explicitPeerId: string | undefined,
  solutionName: string | undefined,
  priorChanges: string[]
): Promise<EnsureConfigResult> {
  const port = await findAvailablePort(new Set())
  const projectType = solutionName ?? 'all'
  const peerId = explicitPeerId ?? `${editorKind}-01`
  const instanceName = solutionName
    ? `${capitalize(editorKind)} (${solutionName})`
    : `${capitalize(editorKind)} 01`

  const typeHierarchy =
    projectType !== 'all'
      ? { all: [projectType], [projectType]: [] as string[] }
      : { all: [] as string[] }

  const config: RawBridgeConfig = {
    peers: {
      [peerId]: {
        peerId,
        editorKind,
        instanceName,
        port,
        workspaceRoots: [normalizeStoredPath(workspaceRoot)],
        supportedProjectTypes: [projectType],
        projectType
      }
    },
    typeHierarchy,
    routing: { requestTimeoutMs: 3000 },
    ui: { statusBar: true, focusOnJump: false }
  }

  const writeChanges = await writeConfigFile(configPath, config)

  return {
    status: 'created',
    configPath,
    peerId,
    changes: [...priorChanges, `Created config with peer ${peerId}.`, ...writeChanges]
  }
}

async function writeConfigFile(configPath: string, config: RawBridgeConfig): Promise<string[]> {
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
  const removedBackups = await cleanupConfigBackups(configPath)
  return removedBackups.length > 0
    ? [`Removed ${removedBackups.length} config backup file(s).`]
    : []
}

function generatePeerId(editorKind: EditorKind, existingPeers: PeerEntry[]): string {
  const samePeers = existingPeers.filter((p) => p.editorKind === editorKind)
  const num = String(samePeers.length + 1).padStart(2, '0')
  return `${editorKind}-${num}`
}

function generateInstanceName(editorKind: EditorKind, existingPeers: PeerEntry[]): string {
  const samePeers = existingPeers.filter((p) => p.editorKind === editorKind)
  const num = String(samePeers.length + 1).padStart(2, '0')
  return `${capitalize(editorKind)} ${num}`
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function normalizePeerWorkspaceRoots(entries: PeerEntry[], changes: string[]): void {
  for (const peer of entries) {
    const normalized = normalizeWorkspaceRoots(peer.workspaceRoots)
    if (normalized.changed) {
      peer.workspaceRoots = normalized.roots
      changes.push(`Normalized workspace roots for ${peer.peerId}.`)
    }
  }
}

function normalizeWorkspaceRoots(roots: string[]): { roots: string[], changed: boolean } {
  const result: string[] = []
  const seen = new Set<string>()
  let changed = false

  for (const root of roots) {
    const storedRoot = normalizeStoredPath(root)
    const key = normalizePath(storedRoot)

    if (seen.has(key)) {
      changed = true
      continue
    }

    seen.add(key)
    result.push(storedRoot)
    changed = changed || storedRoot !== root
  }

  return { roots: result, changed }
}

function containsWorkspaceRoot(roots: string[], root: string): boolean {
  const key = normalizePath(root)
  return roots.some((candidate) => normalizePath(candidate) === key)
}

export async function findAvailablePort(usedPorts: Set<number>): Promise<number> {
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
    if (usedPorts.has(port)) continue
    if (await isPortAvailable(port)) return port
  }
  throw new Error(`No available port found in range ${PORT_RANGE_START}-${PORT_RANGE_END}`)
}

function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    server.listen(port, '127.0.0.1')
  })
}

// ── Target resolution ──

export function resolveTargetPeers(config: BridgeConfig, request: OpenLocationRequest): PeerConfig[] {
  return config.knownPeers.filter((peer) => canPeerHandleRequest(config, peer, request))
}

export function canPeerHandleRequest(config: BridgeConfig, peer: PeerConfig, request: OpenLocationRequest): boolean {
  if (request.targetHint?.peerIds?.length && !request.targetHint.peerIds.includes(peer.peerId)) {
    return false
  }

  if (request.targetHint?.editorKinds?.length && !request.targetHint.editorKinds.includes(peer.editorKind)) {
    return false
  }

  if (!pathMatchesRoots(request.document.filePath, peer.workspaceRoots)) {
    return false
  }

  return projectTypeMatches(request.source.projectType, peer.supportedProjectTypes, config.typeHierarchy)
}
