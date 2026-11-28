import { channelTarget, viewingKey } from '../../viewing'
import type { P2pState } from './store'
import type { IdentityScope } from './scope'

export function createViewingPart(scope: IdentityScope) {
  const peerTarget = (s: P2pState, room: string, id: string) => {
    const ch = s.servers[room]?.channels.find(c => c.id === id)
    if (!ch) return
    const conn = scope.owner.conn
    const target = channelTarget(s.account, 'p2p', room, ch, conn)
    if (scope.localId !== 'main')
      target.key = viewingKey(s.account, ['p2p', scope.localId, room, id], conn)
    return target
  }

  const peerVisible = (s: P2pState, room: string, id: string) => {
    const target = peerTarget(s, room, id)
    return !!target && !!scope.owner.viewing.canView(target)
  }
  return { peerTarget, peerVisible }
}
