import type { PeerEntry } from './protocol'

function snapshotSelfPeerForRestart(peer: PeerEntry): string {
  return JSON.stringify({
    peerId: peer.peerId,
    port: peer.port
  })
}

/** Whether the local HTTP server must restart for a config reload. */
export function selfPeerConfigChanged(previous: PeerEntry | undefined, current: PeerEntry): boolean {
  if (!previous) {
    return false
  }
  return snapshotSelfPeerForRestart(previous) !== snapshotSelfPeerForRestart(current)
}
