import { randomUUID } from 'crypto'
import * as fs from 'fs'
import * as http from 'http'
import * as vscode from 'vscode'
import { canPeerHandleRequest, loadBridgeConfig } from './config'
import { BridgeConfig, BridgeErrorResponse, BridgeSuccessResponse, OpenLocationRequest } from './protocol'

export class PeerServer {
  private server?: http.Server
  private activePort?: number

  constructor(private readonly output: vscode.OutputChannel) {}

  async start(): Promise<void> {
    const config = await loadBridgeConfig()
    if (this.server && this.activePort === config.self.port) {
      return
    }

    await this.stop()

    this.server = http.createServer((request, response) => {
      void this.handleRequest(request, response)
    })

    await new Promise<void>((resolve, reject) => {
      this.server?.once('error', reject)
      this.server?.listen(config.self.port, '127.0.0.1', () => resolve())
    })

    this.activePort = config.self.port
    this.output.appendLine(`[peer-server] listening on 127.0.0.1:${config.self.port}`)
  }

  async stop(): Promise<void> {
    if (!this.server) {
      return
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => error ? reject(error) : resolve())
    })

    this.server = undefined
    this.activePort = undefined
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const requestId = request.headers['x-editor-peer-request-id']?.toString() ?? randomUUID()

    try {
      const config = await loadBridgeConfig()
      const url = request.url ?? '/'
      const method = request.method ?? 'GET'

      if (method === 'GET' && url === '/peer/v1/info') {
        this.writeJson(response, 200, success(requestId, {
          identity: {
            peerId: config.self.peerId,
            editorKind: config.self.editorKind,
            instanceName: config.self.instanceName,
            version: '0.0.1'
          },
          workspaceRoots: config.self.workspaceRoots,
          supportedProjectTypes: config.self.supportedProjectTypes,
          capabilities: {
            openLocation: true,
            restoreSelection: true,
            activateWindow: true
          },
          server: {
            port: config.self.port
          }
        }))
        return
      }

      if (method === 'POST' && url === '/peer/v1/ping') {
        this.writeJson(response, 200, success(requestId, { status: 'alive' }))
        return
      }

      if (method === 'POST' && url === '/peer/v1/can-handle') {
        const body = await readJsonBody<OpenLocationRequest>(request)
        const canHandle = canPeerHandleRequest(config, config.self, body)
        this.writeJson(response, 200, success(requestId, {
          canHandle,
          reason: canHandle ? 'MATCHED' : 'NOT_MATCHED'
        }))
        return
      }

      if (method === 'POST' && url === '/peer/v1/open-location') {
        const body = await readJsonBody<OpenLocationRequest>(request)
        const validationError = validateOpenLocationRequest(body)
        if (validationError) {
          this.writeJson(response, 400, error(requestId, 'INVALID_REQUEST', validationError))
          return
        }

        const matchError = getMatchError(config, body)
        if (matchError) {
          this.writeJson(response, 409, error(requestId, matchError.code, matchError.message, matchError.details))
          return
        }

        if (!fs.existsSync(body.document.filePath)) {
          this.writeJson(response, 404, error(requestId, 'FILE_NOT_FOUND', 'Requested file does not exist.', {
            filePath: body.document.filePath
          }))
          return
        }

        const fileSizeError = checkFileSize(body.document.filePath)
        if (fileSizeError) {
          this.writeJson(response, 413, error(requestId, 'FILE_TOO_LARGE', fileSizeError, {
            filePath: body.document.filePath
          }))
          return
        }

        try {
          await openInVsCode(body)
        } catch (openError) {
          const msg = openError instanceof Error ? openError.message : String(openError)
          this.writeJson(response, 500, error(requestId, 'OPEN_FAILED', msg, {
            filePath: body.document.filePath
          }))
          return
        }
        this.writeJson(response, 200, success(requestId, {
          targetPeerId: config.self.peerId,
          openedFile: body.document.filePath,
          selectionApplied: true,
          windowActivated: body.options.activateWindow
        }))
        return
      }

      this.writeJson(response, 404, error(requestId, 'NOT_FOUND', 'Unknown endpoint.'))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unexpected server error.'
      this.output.appendLine(`[peer-server] ${message}`)
      this.writeJson(response, 500, error(requestId, 'INTERNAL_ERROR', message))
    }
  }

  private writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
    response.statusCode = statusCode
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(JSON.stringify(body))
  }
}

async function readJsonBody<T>(request: http.IncomingMessage): Promise<T> {
  const chunks: Buffer[] = []
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as T
}

function success<T>(requestId: string, data: T): BridgeSuccessResponse<T> {
  return {
    ok: true,
    requestId,
    protocolVersion: 1,
    data
  }
}

function error(requestId: string, code: string, message: string, details?: unknown): BridgeErrorResponse {
  return {
    ok: false,
    requestId,
    protocolVersion: 1,
    error: {
      code,
      message,
      details
    }
  }
}

function validateOpenLocationRequest(request: OpenLocationRequest): string | undefined {
  if (!request?.source?.peerId) {
    return 'Missing source.peerId.'
  }

  if (!request?.document?.filePath) {
    return 'Missing document.filePath.'
  }

  if (!request?.document?.selection?.start || !request?.document?.selection?.end) {
    return 'Missing document.selection.'
  }

  return undefined
}

function getMatchError(config: BridgeConfig, request: OpenLocationRequest): { code: string; message: string; details?: unknown } | undefined {
  if (request.targetHint?.peerIds?.length && !request.targetHint.peerIds.includes(config.self.peerId)) {
    return { code: 'TARGET_HINT_MISMATCH', message: 'Current peer is not listed in targetHint.peerIds.' }
  }

  if (request.targetHint?.editorKinds?.length && !request.targetHint.editorKinds.includes(config.self.editorKind)) {
    return { code: 'TARGET_HINT_MISMATCH', message: 'Current peer editor kind is not listed in targetHint.editorKinds.' }
  }

  if (!canPeerHandleRequest(config, config.self, request)) {
    return {
      code: 'PROJECT_ROOT_OR_TYPE_MISMATCH',
      message: 'Current peer does not match the incoming request by workspace root or project type.',
      details: {
        filePath: request.document.filePath,
        workspaceRoots: config.self.workspaceRoots,
        sourceProjectType: request.source.projectType,
        supportedProjectTypes: config.self.supportedProjectTypes
      }
    }
  }

  return undefined
}

const MAX_FILE_SIZE_MB = 50
const MAX_FILE_SIZE_BYTES = MAX_FILE_SIZE_MB * 1024 * 1024

function checkFileSize(filePath: string): string | undefined {
  try {
    const stat = fs.statSync(filePath)
    if (stat.size > MAX_FILE_SIZE_BYTES) {
      const sizeMB = (stat.size / 1024 / 1024).toFixed(1)
      return `File is ${sizeMB}MB, exceeding the ${MAX_FILE_SIZE_MB}MB limit. VSCode/Cursor cannot open files this large.`
    }
  } catch {
    // stat failed, let openTextDocument handle it
  }
  return undefined
}

async function openInVsCode(request: OpenLocationRequest): Promise<void> {
  const document = await vscode.workspace.openTextDocument(vscode.Uri.file(request.document.filePath))
  const editor = await vscode.window.showTextDocument(document, {
    preview: false,
    preserveFocus: !request.options.activateWindow
  })

  const selection = new vscode.Selection(
    request.document.selection.start.line - 1,
    request.document.selection.start.column - 1,
    request.document.selection.end.line - 1,
    request.document.selection.end.column - 1
  )

  editor.selection = selection
  const revealType = request.options.revealMode === 'center'
    ? vscode.TextEditorRevealType.InCenter
    : vscode.TextEditorRevealType.Default
  editor.revealRange(selection, revealType)
}
