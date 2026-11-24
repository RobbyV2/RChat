import { allowsAccountOrigin } from './hosted_policy'
import { client } from './client'
import type { AccountSession } from './session'
import type { P2pApp } from '../p2p/app/runtime'

export type PeerLink = { kind: 'contact' | 'invite'; code?: string }

// Private peer codes have no instance URL. Leave decoding/signature validation to the peer app.
export function peerCode(text: string): PeerLink | null {
  const code = text.trim()
  if (/^rcp1\.[A-Za-z0-9_-]+$/.test(code)) return { kind: 'contact', code }
  if (/^rci1\.[A-Za-z0-9_-]+$/.test(code)) return { kind: 'invite', code }
  return null
}

export function selectPeerActor<T>(eligible: readonly T[], actor: T | null) {
  if (actor !== null) return eligible.includes(actor) ? actor : null
  return eligible.length === 1 ? eligible[0] : null
}

export function peerLinkRequest(account: AccountSession, link: PeerLink, actor: P2pApp | null) {
  const candidates = new Map<P2pApp, { owner: AccountSession; valid(): boolean }>()
  const live = client.live()
  const sessions = [...new Set([account, ...live])].filter(owner =>
    allowsAccountOrigin(owner.conn.origin)
  )
  const actorMark = account.lifetime.sessionMark()
  const actorUsername = account.store.getState().me?.username
  const actorOrigin = account.conn.origin
  for (const owner of sessions) {
    const username = owner.store.getState().me?.username
    const origin = owner.conn.origin
    const mark = owner.lifetime.sessionMark()
    const registered = live.includes(owner)
    for (const app of owner.identities.list()) {
      const valid = () => {
        const now = owner.store.getState()
        const peer = app.useP2p.getState()
        return (
          allowsAccountOrigin(origin) &&
          allowsAccountOrigin(actorOrigin) &&
          !!username &&
          owner.lifetime.sessionMark() === mark &&
          owner.conn.origin === origin &&
          account.lifetime.sessionMark() === actorMark &&
          account.store.getState().me?.username === actorUsername &&
          account.conn.origin === actorOrigin &&
          (!registered || client.live().includes(owner)) &&
          now.me?.username === username &&
          !now.guest &&
          now.settings.p2p &&
          owner.identities.get(app.localId) === app &&
          peer.enabled &&
          peer.account === username
        )
      }
      if (valid()) candidates.set(app, { owner, valid })
    }
  }
  const choices = [...candidates.keys()]
  const owned = choices.filter(app => candidates.get(app)?.owner === account)
  const selected = selectPeerActor(owned, actor)
  if (!choices.length || (actor && !selected)) return null
  return {
    id: crypto.randomUUID(),
    link,
    choices,
    selected,
    sessions,
    owner: (app: P2pApp) => candidates.get(app)!.owner,
    valid: (app: P2pApp) => !!candidates.get(app)?.valid(),
  }
}
export type PeerLinkRequest = NonNullable<ReturnType<typeof peerLinkRequest>>

export function openPeerLink(
  account: AccountSession,
  link: PeerLink,
  actor: P2pApp | null,
  overlay = account
) {
  const request = peerLinkRequest(account, link, actor)
  if (!request) {
    overlay.store.getState().setError('Open an enabled P2P identity to use a code.')
    return false
  }
  overlay.store.getState().openDialog({ kind: 'peer_code', request })
  return true
}
