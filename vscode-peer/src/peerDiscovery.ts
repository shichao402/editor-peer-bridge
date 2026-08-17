import { probePeerServer } from './peerProbe'
import type { PeerConfig } from './protocol'

export const PORT_RANGE_START = 47631
export const PORT_RANGE_END = 47700

function allRangePorts(): number[] {
  const ports: number[] = []
  for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port += 1) {
    ports.push(port)
  }
  return ports
}

/**
 * Locate the port a peer actually listens on.
 *
 * Ports are assigned per workspace config, but the range is shared machine-wide:
 * a peer whose configured port was taken falls back to another one for the
 * session without rewriting the config. Sending to the configured port would
 * then reach an unrelated peer, which answers with a confusing mismatch error,
 * so verify the identity first and search the range when it does not match.
 *
 * Returns undefined when no server in the range identifies as this peer.
 */
export async function resolvePeerPort(peer: PeerConfig, searchPorts: number[] = allRangePorts()): Promise<number | undefined> {
  if (await probePeerServer(peer.port, peer.peerId)) {
    return peer.port
  }

  const candidates = searchPorts.filter((port) => port !== peer.port)
  const matches = await Promise.all(
    candidates.map(async (port) => ((await probePeerServer(port, peer.peerId)) ? port : undefined))
  )

  return matches.find((port) => port !== undefined)
}
