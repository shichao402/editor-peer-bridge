import * as http from 'http'

const PROBE_TIMEOUT_MS = 500

interface PeerInfoResponse {
  ok?: boolean
  data?: {
    identity?: {
      peerId?: string
    }
  }
}

/**
 * Check whether `port` is already served by an Editor Peer Bridge instance
 * registered as `expectedPeerId`.
 */
export function probePeerServer(port: number, expectedPeerId: string): Promise<boolean> {
  return new Promise((resolve) => {
    const request = http.get(
      {
        host: '127.0.0.1',
        port,
        path: '/peer/v1/info',
        timeout: PROBE_TIMEOUT_MS
      },
      (response) => {
        const chunks: Buffer[] = []
        response.on('data', (chunk) => chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)))
        response.on('end', () => {
          if (response.statusCode !== 200) {
            resolve(false)
            return
          }

          try {
            const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as PeerInfoResponse
            resolve(body.ok === true && body.data?.identity?.peerId === expectedPeerId)
          } catch {
            resolve(false)
          }
        })
      }
    )

    request.on('timeout', () => {
      request.destroy()
      resolve(false)
    })
    request.on('error', () => resolve(false))
  })
}
