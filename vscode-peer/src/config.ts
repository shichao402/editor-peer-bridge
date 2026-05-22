import * as fs from 'fs/promises'
import * as net from 'net'
import * as path from 'path'
import * as vscode from 'vscode'
import { BridgeConfig, EditorKind, OpenLocationRequest, PeerConfig, PeerEntry, RawBridgeConfig } from './protocol'
import { pathMatchesRoots, projectTypeMatches } from './pathUtils'

const CONFIG_FILE_NAME = '.editor-peer-bridge.json'
const PORT_RANGE_START = 47631
const PORT_RANGE_END = 47700

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

  const raw = await fs.readFile(configPath, 'utf8')
  const rawConfig = JSON.parse(raw) as RawBridgeConfig
  const solutionName = await detectSolutionName(workspaceRoot)

  return resolveBridgeConfig(rawConfig, detectEditorKind(), solutionName)
}

function resolveBridgeConfig(
  raw: RawBridgeConfig,
  myEditorKind: EditorKind,
  solutionName: string | undefined
): BridgeConfig {
  const entries = Object.values(raw.peers)

  // Allow explicit peerId selection via environment variable (supports multiple instances of same editorKind)
  const explicitPeerId = process.env.EDITOR_PEER_BRIDGE_PEER_ID

  let self: PeerEntry | undefined
  if (explicitPeerId) {
    self = entries.find((p) => p.peerId === explicitPeerId)
  } else if (solutionName) {
    self =
      entries.find((p) => p.editorKind === myEditorKind && p.projectType === solutionName) ??
      entries.find((p) => p.editorKind === myEditorKind)
  } else {
    self = entries.find((p) => p.editorKind === myEditorKind)
  }

  if (!self) {
    const searchKey = explicitPeerId ?? myEditorKind
    throw new Error(`No peer entry found for "${searchKey}" in .editor-peer-bridge.json`)
  }

  const knownPeers = entries.filter((p) => p.peerId !== self.peerId)

  return {
    self,
    knownPeers,
    typeHierarchy: raw.typeHierarchy,
    routing: raw.routing
  }
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

// ── Auto-config: ensure config exists and self is registered ──

export async function ensureConfig(): Promise<EnsureConfigResult> {
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) {
    return { status: 'skipped', changes: ['No workspace folder is open.'] }
  }

  const editorKind = detectEditorKind()
  const explicitPeerId = process.env.EDITOR_PEER_BRIDGE_PEER_ID
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
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as RawBridgeConfig
  const entries = Object.values(raw.peers)
  const changes: string[] = []
  const projectType = solutionName ?? 'all'
  const self = findSelfPeer(entries, editorKind, explicitPeerId, projectType)

  if (!self) {
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
      workspaceRoots: [workspaceRoot],
      supportedProjectTypes: [projectType],
      projectType
    }

    raw.peers[peerId] = newPeer
    changes.push(`Added peer ${peerId}.`)
    ensureProjectType(raw, projectType, changes)
    await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')

    return { status: 'updated', configPath, peerId, changes }
  }

  if (!self.workspaceRoots.includes(workspaceRoot)) {
    self.workspaceRoots = [...self.workspaceRoots, workspaceRoot]
    changes.push(`Added workspace root ${workspaceRoot}.`)
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
    await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
    return { status: 'updated', configPath, peerId: self.peerId, changes }
  }

  return { status: 'unchanged', configPath, peerId: self.peerId, changes }
}

function findSelfPeer(
  entries: PeerEntry[],
  editorKind: EditorKind,
  explicitPeerId: string | undefined,
  projectType: string
): PeerEntry | undefined {
  if (explicitPeerId) {
    return entries.find((p) => p.peerId === explicitPeerId)
  }

  return entries.find((p) => p.editorKind === editorKind && p.projectType === projectType) ??
    entries.find((p) => p.editorKind === editorKind)
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
        workspaceRoots: [workspaceRoot],
        supportedProjectTypes: [projectType],
        projectType
      }
    },
    typeHierarchy,
    routing: { requestTimeoutMs: 3000 }
  }

  const configPath = path.join(workspaceRoot, CONFIG_FILE_NAME)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')

  return { status: 'created', configPath, peerId, changes: [`Created config with peer ${peerId}.`] }
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

async function findAvailablePort(usedPorts: Set<number>): Promise<number> {
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
