export type EditorKind = 'rider' | 'vscode' | 'cursor' | 'codebuddy'

export interface Position {
  line: number
  column: number
}

export interface Range {
  start: Position
  end: Position
}

export interface DocumentRef {
  filePath: string
  selection: Range
}

export interface SourceContext {
  peerId: string
  editorKind: EditorKind
  instanceName: string
  projectRoot: string
  projectType: string
}

export interface TargetHint {
  peerIds?: string[]
  editorKinds?: EditorKind[]
}

export interface OpenLocationOptions {
  activateWindow: boolean
  revealMode: 'default' | 'center'
}

export interface OpenLocationRequest {
  source: SourceContext
  targetHint?: TargetHint
  document: DocumentRef
  options: OpenLocationOptions
}

export interface PeerIdentity {
  peerId: string
  editorKind: EditorKind
  instanceName: string
  version?: string
}

export interface PeerEntry {
  peerId: string
  editorKind: EditorKind
  instanceName: string
  port: number
  workspaceRoots: string[]
  supportedProjectTypes: string[]
  projectType: string
}

export interface RawBridgeConfig {
  peers: Record<string, PeerEntry>
  typeHierarchy: Record<string, string[]>
  routing?: {
    defaultTargetPeerIds?: Partial<Record<EditorKind, string>>
    requestTimeoutMs?: number
  }
}

export interface BridgeConfig {
  self: PeerEntry
  knownPeers: PeerEntry[]
  typeHierarchy: Record<string, string[]>
  routing?: {
    defaultTargetPeerIds?: Partial<Record<EditorKind, string>>
    requestTimeoutMs?: number
  }
}

export type PeerConfig = PeerEntry

export interface PeerInfoResponseData {
  identity: PeerIdentity
  workspaceRoots: string[]
  supportedProjectTypes: string[]
  capabilities: {
    openLocation: boolean
    restoreSelection: boolean
    activateWindow: boolean
  }
  server: {
    port: number
  }
}

export interface BridgeSuccessResponse<T> {
  ok: true
  requestId: string
  protocolVersion: number
  data: T
}

export interface BridgeErrorResponse {
  ok: false
  requestId: string
  protocolVersion: number
  error: {
    code: string
    message: string
    details?: unknown
  }
}

export type BridgeResponse<T> = BridgeSuccessResponse<T> | BridgeErrorResponse
