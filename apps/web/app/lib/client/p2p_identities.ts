import { readLocal, writeLocal } from '../instances'
import { coversInstance, type P2pState } from '../p2p/app/store'
import { createP2pApp, legacyP2pApp, type P2pApp } from '../p2p/app/runtime'
import { createP2pInbox, startP2pPings } from '../p2p/inbox_source'
import { startP2pIndex } from '../p2p/palette_source'
import { viewKey } from '../view'
import { bindP2pHost } from '../p2p/app/host'
import type { AccountSession } from './session'

const MAX_IDENTITIES = 8
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)

export function instanceUncovered(account: AccountSession, now: P2pState, before: P2pState) {
  if (coversInstance(now) || !coversInstance(before)) return
  const view = account.store.getState().view
  if (!view) return
  const key = viewKey(view)
  account.store.setState(s => {
    const mark = s.reads[key]
    const anchor = mark && mark.latest > mark.lastRead && !(s.unreadAnchor[key] > 0)
    return {
      atBottom: { ...s.atBottom, [key]: false },
      ...(anchor ? { unreadAnchor: { ...s.unreadAnchor, [key]: mark.lastRead } } : {}),
    }
  })
}

function savedIds(key: string): string[] {
  try {
    const saved: unknown = JSON.parse(readLocal(key) ?? '[]')
    if (Array.isArray(saved))
      return [...new Set(saved.filter(id => validId(id) && id !== 'main'))].slice(
        0,
        MAX_IDENTITIES - 1
      )
  } catch {
    // An invalid list must not prevent the historical main identity from opening.
  }
  return []
}

export class P2pIdentities {
  private entries = new Map<string, { app: P2pApp; detach: () => void }>()
  private username: string | null = null
  private disposed = false

  constructor(private readonly account: AccountSession) {}

  get(localId = 'main') {
    return this.entries.get(localId)?.app
  }

  list() {
    return Array.from(this.entries.values(), entry => entry.app)
  }

  private attach(localId: string, username: string) {
    const account = this.account
    const legacy = account.isHome && localId === 'main'
    const app = legacy ? legacyP2pApp : createP2pApp(account, localId)
    const state = account.store.getState
    let attached = true
    const live = () => attached && state().me?.username === username
    if (legacy) {
      bindP2pHost(app, account, live)
      app.callRtc.onChange = () => {
        if (!live()) return
        account.store.setState(s => ({ rtcTick: s.rtcTick + 1 }))
        app.p2pVoice.videoChanged()
      }
    }
    const offView =
      !legacy &&
      app.useP2p.subscribe((now, before) => {
        if (!live()) return
        instanceUncovered(account, now, before)
        if (localId === 'main') account.home.noteP2pVisit(now, before)
      })
    const inbox = createP2pInbox(account, app, live)
    const stopIndex = startP2pIndex(account, { app })
    const stopPings = startP2pPings(account, app)
    const detach = () => {
      attached = false
      if (offView) offView()
      if (legacy) {
        app.callRtc.onChange = () => {}
        void app.p2pAccount(null, account)
      } else app.dispose()
      stopIndex()
      stopPings()
      account.inbox.removeInboxAdapter(inbox.id)
    }
    this.entries.set(localId, { app, detach })
    void app.p2pAccount(username, account)
    account.inbox.addInboxAdapter(inbox)
    return app
  }

  setAccount(username: string | null) {
    if (this.disposed) return
    const state = this.account.store.getState()
    if (!state.settings.p2p || state.guest || state.me?.username !== username) username = null
    if (username === this.username) return
    this.clear()
    this.username = username
    if (username) {
      this.attach('main', username)
      for (const id of savedIds(this.account.keys.local('rchat_p2p_identities')))
        this.attach(id, username)
    }
  }

  add(localId: string = crypto.randomUUID()) {
    const username = this.username
    const state = this.account.store.getState()
    if (!username || !state.settings.p2p || state.guest || state.me?.username !== username)
      throw new Error('Sign in with P2P enabled to add an identity')
    if (!validId(localId)) throw new Error('Invalid local identity ID')
    const existing = this.get(localId)
    if (existing) return existing
    const key = this.account.keys.local('rchat_p2p_identities')
    const ids = new Set([...savedIds(key), ...this.entries.keys(), localId])
    if (ids.size > MAX_IDENTITIES) throw new Error('An account can hold up to eight P2P identities')
    ids.delete('main')
    if (!writeLocal(key, JSON.stringify([...ids]))) throw new Error('Unable to save P2P identities')
    return this.attach(localId, username)
  }

  // The caller handles deletion of peer data through the app before unregistering its slot.
  unregister(localId: string) {
    const entry = this.entries.get(localId)
    if (
      !entry ||
      localId === 'main' ||
      this.account.store.getState().me?.username !== this.username
    )
      return false
    const key = this.account.keys.local('rchat_p2p_identities')
    if (!writeLocal(key, JSON.stringify(savedIds(key).filter(id => id !== localId))))
      throw new Error('Unable to save P2P identities')
    this.entries.delete(localId)
    entry.detach()
    return true
  }

  private clear() {
    this.username = null
    for (const entry of this.entries.values()) entry.detach()
    this.entries.clear()
  }

  dispose() {
    this.disposed = true
    this.clear()
  }
}
