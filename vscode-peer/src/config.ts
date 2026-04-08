import * as fs from 'fs/promises'
import * as net from 'net'
import * as path from 'path'
import * as vscode from 'vscode'
import { BridgeConfig, EditorKind, OpenLocationRequest, PeerConfig, PeerEntry, RawBridgeConfig } from './protocol'
import { pathMatchesRoots, projectTypeMatches } from './pathUtils'

const CONFIG_FILE_NAME = '.editor-peer-bridge.json'
const PORT_RANGE_START = 47631
const PORT_RANGE_END = 47700

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

  return resolveBridgeConfig(rawConfig, detectEditorKind())
}

function resolveBridgeConfig(raw: RawBridgeConfig, myEditorKind: EditorKind): BridgeConfig {
  const entries = Object.values(raw.peers)

  // Allow explicit peerId selection via environment variable (supports multiple instances of same editorKind)
  const explicitPeerId = process.env.EDITOR_PEER_BRIDGE_PEER_ID
  const self = explicitPeerId
    ? entries.find((p) => p.peerId === explicitPeerId)
    : entries.find((p) => p.editorKind === myEditorKind)

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

export async function ensureConfig(): Promise<void> {
  const workspaceRoot = getPrimaryWorkspaceRoot()
  if (!workspaceRoot) return

  const editorKind = detectEditorKind()
  const explicitPeerId = process.env.EDITOR_PEER_BRIDGE_PEER_ID
  const existingPath = await findConfigPath(workspaceRoot)

  if (existingPath) {
    await ensureSelfInConfig(existingPath, editorKind, workspaceRoot, explicitPeerId)
  } else {
    await createInitialConfig(workspaceRoot, editorKind)
  }
}

async function ensureSelfInConfig(
  configPath: string,
  editorKind: EditorKind,
  workspaceRoot: string,
  explicitPeerId: string | undefined
): Promise<void> {
  const raw = JSON.parse(await fs.readFile(configPath, 'utf8')) as RawBridgeConfig
  const entries = Object.values(raw.peers)

  // Check if self already exists
  if (explicitPeerId) {
    if (entries.some((p) => p.peerId === explicitPeerId)) return
  } else {
    if (entries.some((p) => p.editorKind === editorKind)) return
  }

  // Self not found - register
  const usedPorts = new Set(entries.map((p) => p.port))
  const port = await findAvailablePort(usedPorts)
  const peerId = generatePeerId(editorKind, entries)
  const instanceName = generateInstanceName(editorKind, entries)

  const newPeer: PeerEntry = {
    peerId,
    editorKind,
    instanceName,
    port,
    workspaceRoots: [workspaceRoot],
    supportedProjectTypes: ['all'],
    projectType: 'all'
  }

  raw.peers[peerId] = newPeer
  await fs.writeFile(configPath, JSON.stringify(raw, null, 2) + '\n', 'utf8')
}

async function createInitialConfig(workspaceRoot: string, editorKind: EditorKind): Promise<void> {
  const port = await findAvailablePort(new Set())
  const peerId = `${editorKind}-01`
  const instanceName = `${capitalize(editorKind)} 01`

  const config: RawBridgeConfig = {
    peers: {
      [peerId]: {
        peerId,
        editorKind,
        instanceName,
        port,
        workspaceRoots: [workspaceRoot],
        supportedProjectTypes: ['all'],
        projectType: 'all'
      }
    },
    typeHierarchy: { all: [] },
    routing: { requestTimeoutMs: 3000 }
  }

  const configPath = path.join(workspaceRoot, CONFIG_FILE_NAME)
  await fs.writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf8')
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
