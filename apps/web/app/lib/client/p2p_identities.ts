import { client } from './client'
import { describeIdentity } from './book'
import { identityRecords } from './identity_enrollment'
import { saveRequestBadge } from './request_badge'
import { requests } from '../p2p/contacts'
import { peerStorage } from './keys'
import { clearHiddenForward } from '../forward_viewing'
import { readLocal, writeLocal } from '../instances'
import { coversInstance, parseOn, p2pKey } from '../p2p/app/store'
import { createP2pApp, type P2pApp } from '../p2p/app/runtime'
import { createP2pInbox, startP2pPings } from '../p2p/inbox_source'
import { startP2pIndex } from '../p2p/palette_source'
import { removeP2pDb } from '../p2p/db'
import { viewKey } from '../view'
import type { AccountSession } from './session'
import { time } from '../platform/time'
import { anything, arr, jsonOr } from '../schema'

const MAX_IDENTITIES = 8
const validId = (id: unknown): id is string =>
  typeof id === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(id)

function instanceUncovered(account: AccountSession) {
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
    const saved: unknown = jsonOr(readLocal(key), arr(anything), [])
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
  private entries = new Map<string, { app: P2pApp; manifest: string; detach: () => void }>()
  private listeners = new Set<() => void>()
  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
  private changed() {
    for (const listener of this.listeners) listener()
  }
  private viewedId = 'main'
  viewed() {
    return this.get(this.viewedId) ?? this.get()
  }
  coversView() {
    const view = this.viewed()?.useP2p.getState()
    const state = this.account.store.getState()
    return (
      !!view &&
      !!state.me &&
      !state.guest &&
      state.settings.p2p &&
      view.account === state.me.username &&
      coversInstance(view)
    )
  }
  show(app: P2pApp) {
    if (this.get(app.localId) !== app) return
    if (client.canWritePage(this.account)) client.cancelActorSelection()
    if (this.viewedId === app.localId) return
    const covered = this.coversView()
    this.viewedId = app.localId
    if (covered && !this.coversView()) instanceUncovered(this.account)
    this.changed()
  }
  private running: ReadonlySet<string> | null = null
  private held = new Set<string>()

  // Keeps an identity running as if it were admitted, until the returned release.
  hold(localId: string) {
    this.held.add(localId)
    return () => {
      if (this.held.delete(localId)) this.changed()
    }
  }

  // The manifest also lists identities which are currently parked or disabled.
  enabledIds(username: string) {
    const ids = new Set([
      'main',
      ...savedIds(this.account.keys.local('rchat_p2p_identities')),
      ...this.entries.keys(),
    ])
    return [...ids].filter(id =>
      parseOn(readLocal(peerStorage(this.account.conn, username, id).scoped(p2pKey(username))))
    )
  }

  setRunning(ids: ReadonlySet<string>) {
    const before = this.running
    this.running = ids
    if (!this.username) return
    for (const [id, { app }] of this.entries) {
      const enabled = parseOn(
        readLocal(peerStorage(this.account.conn, this.username, id).scoped(p2pKey(this.username)))
      )
      const admitted = ids.has(id) || this.held.has(id)
      if (
        !enabled ||
        ((before?.has(id) ?? true) === admitted && (admitted || !app.useP2p.getState().enabled))
      )
        continue
      if (admitted) void app.p2pAccount(this.username)
      else app.park()
    }
  }
  private username: string | null = null
  private generation = 0
  private disposed = false

  constructor(private readonly account: AccountSession) {}

  get(localId = 'main') {
    return this.entries.get(localId)?.app
  }

  list() {
    return Array.from(this.entries.values(), entry => entry.app)
  }

  // Settings can remove a saved identity even when the operator prohibits running P2P.
  offlineData() {
    const { account } = this
    const state = account.store.getState()
    const username = state.me?.username
    if (this.disposed || !username || state.guest || state.settings.p2p) return []
    const generation = this.generation
    const { origin } = account.conn
    const mark = account.lifetime.sessionMark()
    const current = () => {
      const now = account.store.getState()
      return (
        !this.disposed &&
        this.generation === generation &&
        account.conn.origin === origin &&
        account.lifetime.sessionMark() === mark &&
        now.me?.username === username &&
        !now.guest &&
        !now.settings.p2p
      )
    }
    const manifest = account.keys.local('rchat_p2p_identities')
    const ids = ['main', ...savedIds(manifest)]
    return ids.flatMap(id => {
      const storage = peerStorage(account.conn, username, id)
      const flag = storage.scoped(p2pKey(username))
      const db = storage.db
      const enabled = readLocal(flag)
      if (!db || !parseOn(enabled)) return []
      let claimed = false
      const removed = () => this.dataRemoved(username, id)
      return [
        {
          id,
          async remove() {
            if (claimed || !current() || account.keys.db(id) !== db || readLocal(flag) !== enabled)
              return false
            // Claim the pinned flag before issuing the IndexedDB request. Later database
            // opens queue behind deletion; a subsequent enable can replace this marker.
            const deleting = JSON.stringify({
              v: 1,
              on: false,
              deleting: Array.from(crypto.getRandomValues(new Uint32Array(4))),
            })
            if (!writeLocal(flag, deleting)) return false
            claimed = true
            try {
              await removeP2pDb(db)
              if (readLocal(flag) !== deleting) return true
              if (!writeLocal(flag, null)) return false
              if (id !== 'main')
                writeLocal(manifest, JSON.stringify(savedIds(manifest).filter(i => i !== id)))
              if (current()) removed()
              return true
            } catch {
              if (readLocal(flag) === deleting) writeLocal(flag, enabled)
              return false
            }
          },
        },
      ]
    })
  }

  dataRemoved(username: string, localId: string) {
    saveRequestBadge(this.account.conn.origin, username, localId, null)
    this.account.counts.peerRemoved(username, localId)
    this.changed()
  }

  private attach(localId: string, username: string) {
    const account = this.account
    const app = createP2pApp(account, localId)
    const state = account.store.getState
    let attached = true
    const live = () => attached && state().me?.username === username
    let lastRequests: number | undefined
    const offView = app.useP2p.subscribe((now, before) => {
      if (!live()) return
      if (now.ik && (now.ik !== before.ik || now.name !== before.name)) {
        const origin = account.conn.origin
        const record = identityRecords(client.book.getState(), origin, username)?.find(
          i => i.local === localId
        )
        if (record && !record.pendingImport && (record.ik !== now.ik || record.name !== now.name))
          void client.updateBook(book =>
            live() &&
            account.conn.origin === origin &&
            app.useP2p.getState().ik === now.ik &&
            identityRecords(book, origin, username)?.find(i => i.local === localId)?.ik ===
              record.ik
              ? describeIdentity(book, origin, username, localId, record.added, now.ik!, now.name)
              : book
          )
      }
      if (!now.me || now.elsewhere) lastRequests = undefined
      else if (now.contacts !== before.contacts && app.isCurrent()) {
        const count = requests(now.contacts).length
        if (count !== lastRequests) saveRequestBadge(account.conn.origin, username, localId, count)
        lastRequests = count
      }
      if (now.enabled !== before.enabled) this.changed()
      if (now.servers !== before.servers) clearHiddenForward(account)
      if (this.viewed() === app && coversInstance(before) && !coversInstance(now))
        instanceUncovered(account)
      account.home.noteP2pVisit(now, before, time().now(), localId)
    })
    const inbox = createP2pInbox(account, app, live)
    const stopIndex = startP2pIndex(account, { app })
    const stopPings = startP2pPings(account, app)
    const detach = () => {
      attached = false
      offView()
      app.dispose()
      stopIndex()
      stopPings()
      account.inbox.removeInboxAdapter(inbox.id)
    }
    this.entries.set(localId, { app, manifest: account.keys.local('rchat_p2p_identities'), detach })
    const enabled = parseOn(
      readLocal(peerStorage(account.conn, username, localId).scoped(p2pKey(username)))
    )
    if (!enabled || !this.running || this.running.has(localId)) void app.p2pAccount(username)
    account.inbox.addInboxAdapter(inbox)
    this.changed()
    return app
  }

  setAccount(username: string | null) {
    if (this.disposed) return
    const state = this.account.store.getState()
    if (!state.settings.p2p || state.guest || state.me?.username !== username) username = null
    if (username === this.username) return
    const before = this.viewed()?.useP2p.getState()
    if (
      before &&
      !state.settings.p2p &&
      !state.guest &&
      before.account === state.me?.username &&
      coversInstance(before)
    )
      instanceUncovered(this.account)
    this.clear()
    this.username = username
    if (username) {
      this.attach('main', username)
      for (const id of savedIds(this.account.keys.local('rchat_p2p_identities')))
        this.attach(id, username)
    }
  }

  saveSlot(key: string, localId: string) {
    const ids = new Set(['main', ...savedIds(key)])
    if (ids.has(localId)) return true
    if (ids.size >= MAX_IDENTITIES) return false
    ids.delete('main')
    ids.add(localId)
    return writeLocal(key, JSON.stringify([...ids]))
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
    if (this.entries.size >= MAX_IDENTITIES || !this.saveSlot(key, localId))
      throw new Error('Unable to save P2P identities (maximum eight)')
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
    return this.releaseSlot(localId, key)
  }

  emptySlotCleanup(localId: string, manifest: string, app: P2pApp) {
    const generation = this.generation
    return () => {
      const current = this.get(localId)
      if (current && this.generation === generation && current !== app) return false
      return this.releaseSlot(localId, manifest, true)
    }
  }

  // A detached enrollment still owns its original namespaced manifest entry.
  releaseSlot(localId: string, manifest: string, emptyOnly = false) {
    const entry = this.entries.get(localId)
    const attached = entry?.manifest === manifest ? entry : undefined
    if (localId === 'main' || (emptyOnly && attached?.app.useP2p.getState().ik)) return false
    const ids = savedIds(manifest)
    if (
      ids.includes(localId) &&
      !writeLocal(manifest, JSON.stringify(ids.filter(id => id !== localId)))
    )
      throw new Error('Unable to save P2P identities')
    if (!attached) return true
    const covered = this.coversView()
    if (this.viewedId === localId) this.viewedId = 'main'
    const state = this.account.store.getState()
    const clip = state.forwardClip
    if (
      clip &&
      [clip.source, clip.quoted].some(
        source => source && 'identity' in source && source.identity === localId
      )
    )
      state.clearForward()
    this.entries.delete(localId)
    attached.detach()
    if (covered && !this.coversView()) instanceUncovered(this.account)
    this.changed()
    return true
  }

  private clear() {
    this.generation++
    this.username = null
    this.viewedId = 'main'
    for (const entry of this.entries.values()) entry.detach()
    this.entries.clear()
    this.changed()
  }

  dispose() {
    this.disposed = true
    this.clear()
    this.listeners.clear()
  }
}
