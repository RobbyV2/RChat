import { readLocal, writeLocal } from '../instances'
import type { P2pState } from '../p2p/app/store'
import { requests } from '../p2p/contacts'

export const requestBadgePrefix = 'rchat_peer_requests:'
const key = (origin: string, user: string, local: string) =>
  requestBadgePrefix + JSON.stringify([origin, user, local])

export function saveRequestBadge(
  origin: string,
  user: string,
  local: string,
  count: number | null
) {
  const slot = key(origin, user, local)
  const next = count === null ? null : String(count)
  if (readLocal(slot) !== next) writeLocal(slot, next)
}

export function requestBadge(origin: string, user: string, local: string, peer?: P2pState) {
  if (peer?.me && !peer.elsewhere) return requests(peer.contacts).length
  const raw = readLocal(key(origin, user, local))
  if (raw === null && peer?.reader) return requests(peer.contacts).length
  const count = Number(raw)
  return Number.isSafeInteger(count) && count > 0 ? count : 0
}
