import { canView, channelTarget } from '../../viewing'
import type { P2pState } from './store'

export const peerTarget = (s: P2pState, room: string, id: string) => {
  const ch = s.servers[room]?.channels.find(c => c.id === id)
  return ch && channelTarget(s.account, 'p2p', room, ch)
}
export const peerVisible = (s: P2pState, room: string, id: string) => {
  const target = peerTarget(s, room, id)
  return !!target && canView(target)
}
