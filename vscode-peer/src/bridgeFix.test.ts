import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import test from 'node:test'
import { isDocumentSyncRejection } from './documentSyncError'
import { probePeerServer } from './peerProbe'
import { selfPeerConfigChanged } from './selfPeerSync'
import type { PeerEntry } from './protocol'

function startMockBridge(port: number, peerId: string): Promise<Server> {
  return new Promise((resolve, reject) => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify({
        ok: true,
        requestId: 'test',
        protocolVersion: 1,
        data: {
          identity: { peerId, editorKind: 'cursor', instanceName: 'Cursor 01', version: '0.0.1' }
        }
      }))
    })
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve(server))
  })
}

test('probePeerServer returns true when peerId matches', async () => {
  const server = await startMockBridge(47699, 'cursor-01')
  try {
    assert.equal(await probePeerServer(47699, 'cursor-01'), true)
    assert.equal(await probePeerServer(47699, 'cursor-02'), false)
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())))
  }
})

test('probePeerServer returns false when port is closed', async () => {
  assert.equal(await probePeerServer(47698, 'cursor-01'), false)
})

test('selfPeerConfigChanged ignores workspace root updates', () => {
  const base: PeerEntry = {
    peerId: 'cursor-01',
    editorKind: 'cursor',
    instanceName: 'Cursor 01',
    port: 47632,
    workspaceRoots: ['C:/project'],
    supportedProjectTypes: ['all'],
    projectType: 'all'
  }

  const withExtraRoot: PeerEntry = {
    ...base,
    workspaceRoots: ['C:/project', 'C:/project/tools/abc']
  }

  assert.equal(selfPeerConfigChanged(base, withExtraRoot), false)
})

test('selfPeerConfigChanged detects port changes', () => {
  const base: PeerEntry = {
    peerId: 'cursor-01',
    editorKind: 'cursor',
    instanceName: 'Cursor 01',
    port: 47632,
    workspaceRoots: ['C:/project'],
    supportedProjectTypes: ['all'],
    projectType: 'all'
  }

  const portChanged: PeerEntry = { ...base, port: 47633 }
  assert.equal(selfPeerConfigChanged(base, portChanged), true)
})

test('isDocumentSyncRejection matches VS Code and Cursor size-limit wording', () => {
  assert.equal(
    isDocumentSyncRejection(new Error('Files above 50MB cannot be synchronized with extensions.')),
    true
  )
  assert.equal(
    isDocumentSyncRejection(new Error(
      'cannot open file:///d%3A/project/Foo.h. Detail: Documents above the size limit cannot be synchronized with extensions.'
    )),
    true
  )
})

test('isDocumentSyncRejection ignores unrelated open failures', () => {
  assert.equal(isDocumentSyncRejection(new Error('cannot open file. Detail: EACCES: permission denied')), false)
  assert.equal(isDocumentSyncRejection(undefined), false)
})
