import type Peer from 'peerjs'
import type { PeerTarget } from '../instances'

// The one place a signalling connection is opened. Its address comes from the instance's
// connection, and it carries the peer id and a random token, never an account's credentials.
export const openPeer = (
  PeerClass: typeof Peer,
  id: string,
  at: PeerTarget,
  extra: { token?: string; config: RTCConfiguration }
): Peer => new PeerClass(id, { ...at, ...extra })
