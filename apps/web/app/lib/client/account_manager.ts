import { isClientHost, readLocal, writeLocal } from '../instances'
import { createSavedSession, savedConnection } from './saved_session'
import type { Book } from './book'
import type { AccountSession } from './session'
import { accountStorage } from './keys'

const FIVE_MINUTES = 5 * 60_000
const BUDGET_KEY = 'rchat_live_budget'
const limit = (n: number) => (Number.isFinite(n) ? Math.max(1, Math.min(20, Math.floor(n))) : 8)
type Ports = {
  book: () => Book
  shown: () => AccountSession
  live: () => readonly AccountSession[]
  watch: (fn: () => void) => () => void
  protected: () => AccountSession | undefined
  protectedIdentity: () => string | undefined
  publish: () => void
}
interface Entry {
  session: AccountSession
  username: string | null
  origin: string
  unshownSince: number
  lastShown: number
  lastPoll: number
  credential: string
  started: boolean
  unsubscribe: () => void
}
function usernameOf(session: AccountSession) {
  const state = session.store.getState()
  return state.me?.username ?? (state.guest ? null : session.credentialTarget)
}
const key = (origin: string, username: string | null) => JSON.stringify([origin, username])
export class AccountManager {
  private entries = new Map<string, Entry>()
  private refs = 0
  private release?: () => void
  private queued = false
  private reconciling = false
  private previous?: AccountSession
  private recency = 0
  private keeping = new Set<AccountSession>()
  budget = 8
  constructor(private ports: Ports) {}
  // Keeps a session signed in here while it finishes what it started, even after another tab
  // signs the account out, until the returned release.
  keep(session: AccountSession) {
    this.keeping.add(session)
    return () => {
      if (this.keeping.delete(session)) this.schedule()
    }
  }
  lastShown(account: AccountSession) {
    const username = usernameOf(account)
    return username === undefined
      ? 0
      : (this.entries.get(key(account.conn.origin, username))?.lastShown ?? 0)
  }
  mode = (account: AccountSession) => account.mode
  setBudget = (value: number) => {
    this.budget = limit(value)
    writeLocal(BUDGET_KEY, String(this.budget))
    this.schedule()
  }
  schedule = () => {
    if (!this.refs || this.queued) return
    this.queued = true
    queueMicrotask(() => {
      this.queued = false
      this.reconcile()
    })
  }
  private poll: (account: AccountSession) => void | Promise<void> = () => {}
  start = (poll?: (account: AccountSession) => void | Promise<void>) => {
    if (poll) this.poll = poll
    if (++this.refs === 1 && !this.release) {
      const readBudget = () => {
        const raw = readLocal(BUDGET_KEY)
        this.budget = raw === null ? 8 : limit(Number(raw))
      }
      readBudget()
      const stop = this.ports.watch(this.schedule)
      const timer = setInterval(() => this.reconcile(), 30_000)
      const storage = (event: StorageEvent) => {
        if (event.key === null || event.key === BUDGET_KEY) readBudget()
        if (
          event.key === null ||
          event.key === BUDGET_KEY ||
          event.key.startsWith('rchat_token:') ||
          event.key.startsWith('rchat_guest')
        )
          this.schedule()
      }
      const page = window
      page.addEventListener('storage', storage)
      this.release = () => {
        clearInterval(timer)
        stop()
        page.removeEventListener('storage', storage)
      }
      this.reconcile()
    }
    let active = true
    return () => {
      if (!active) return
      active = false
      if (--this.refs) return
      // Strict Mode may remount the same shell immediately. Preserve ongoing
      // calls across shell transitions and avoid a socket churn during remount.
      queueMicrotask(() => {
        if (this.refs) return
        this.release?.()
        this.release = undefined
        for (const entry of this.entries.values()) {
          entry.unsubscribe()
          entry.session.deliveryLock.stop()
          entry.session.tabLock.stop()
          if (entry.session !== this.ports.shown() && entry.session !== this.ports.protected()) {
            entry.session.store.setSocket(false)
            entry.session.identities.setRunning(new Set())
          }
        }
        this.entries.clear()
        this.previous = undefined
      })
    }
  }
  reconcile = () => {
    if (!this.refs || this.reconciling) return
    this.reconciling = true
    try {
      this.apply()
    } finally {
      this.reconciling = false
    }
  }
  private apply() {
    const { ports } = this
    const shown = ports.shown()
    const now = Date.now()
    const wanted = new Map<
      string,
      { origin: string; username: string | null; connect: boolean; credential: string }
    >()
    for (const instance of ports.book().instances) {
      if (isClientHost(instance.origin)) continue
      const existing = ports.live().find(a => a.conn.origin === instance.origin)
      const conn = existing?.conn ?? savedConnection(instance.origin)
      const keys = accountStorage(conn)
      for (const a of instance.accounts) {
        const credential = readLocal(keys.token(a.username))
        if (credential)
          wanted.set(key(instance.origin, a.username), {
            origin: instance.origin,
            username: a.username,
            connect: a.connect,
            credential,
          })
      }
      if (instance.guest && readLocal(keys.key('rchat_guest')) === '1')
        wanted.set(key(instance.origin, null), {
          origin: instance.origin,
          username: null,
          connect: true,
          credential: 'guest',
        })
    }
    for (const [id, e] of this.entries)
      if (this.keeping.has(e.session) && !wanted.has(id))
        wanted.set(id, {
          origin: e.origin,
          username: e.username,
          connect: true,
          credential: e.credential,
        })
    let changed = false
    for (const [id, entry] of this.entries) {
      if (wanted.get(id)?.credential === entry.credential && ports.live().includes(entry.session))
        continue
      this.entries.delete(id)
      entry.unsubscribe()
      const account = entry.session
      if (!ports.live().includes(account)) continue
      const current = usernameOf(account)
      if (
        account.conn.origin !== entry.origin ||
        (current !== undefined && current !== entry.username)
      )
        continue
      account.deliveryLock.stop()
      account.tabLock.stop()
      account.store.setSocket(false)
      if (account === shown || account.isHome) {
        if (current !== undefined || wanted.has(id)) account.credentialTarget = entry.username
        account.store.retireCredentials()
        account.store.setSocket(account === shown)
      } else account.store.dispose()
      changed = true
    }
    for (const [id, target] of wanted) {
      if (this.entries.has(id)) continue
      const matches = (a: AccountSession) =>
        a.conn.origin === target.origin && usernameOf(a) === target.username
      // The lone legacy home can still be waiting for /me to verify its bearer.
      if (
        shown.conn.origin === target.origin &&
        shown.credentialTarget === undefined &&
        !shown.store.getState().me &&
        !shown.store.getState().guest &&
        ![...this.entries.values()].some(e => e.session === shown)
      )
        continue
      const account =
        ports.live().find(matches) ?? createSavedSession(target.origin, target.username)
      const signal = account.tabLock.subscribe(this.schedule)
      const identities = account.identities.subscribe(this.schedule)
      const state = account.store.subscribe((s, p) => {
        if (
          s.me !== p.me ||
          s.guest !== p.guest ||
          s.authExpired !== p.authExpired ||
          s.settings.p2p !== p.settings.p2p
        )
          this.schedule()
      })
      this.entries.set(id, {
        session: account,
        origin: target.origin,
        username: target.username,
        lastShown: account === shown ? ++this.recency : 0,
        unshownSince: now,
        lastPoll: now,
        credential: target.credential,
        started: false,
        unsubscribe: () => {
          signal()
          identities()
          state()
        },
      })
      account.tabLock.start(target.origin, target.username)
      changed = true
    }
    const media = ports.protected()
    const entries = Array.from(this.entries.values())
    if (this.previous !== shown) {
      for (const e of entries)
        if (e.session === shown) e.lastShown = ++this.recency
        else if (e.session === this.previous) e.unshownSince = now
      this.previous = shown
    }
    const candidates = entries.filter(
      e =>
        e.session === shown ||
        e.session === media ||
        (wanted.get(key(e.origin, e.username))?.connect &&
          e.session.tabLock.holds(e.origin, e.username))
    )
    const ranked = candidates.sort(
      (a, b) =>
        Number(b.session === shown) - Number(a.session === shown) ||
        Number(b.session === media) - Number(a.session === media) ||
        b.lastShown - a.lastShown
    )
    const admitted = new Set(ranked.slice(0, this.budget).map(e => e.session))
    for (const e of entries) {
      const a = e.session
      const foreground = a === shown
      const locked = a.tabLock.holds(e.origin, e.username)
      const connect = wanted.get(key(e.origin, e.username))!.connect
      const allowed = foreground || a === media || admitted.has(a)
      const lite = !foreground && a !== media && now - e.unshownSince >= 2 * FIVE_MINUTES
      const mode = foreground
        ? 'shown'
        : (!connect || locked) && !allowed
          ? 'parked'
          : !allowed || lite
            ? 'lite'
            : 'live'
      const old = a.mode
      if (old !== mode) {
        a.mode = mode
        a.counts.modeChanged()
        if (mode === 'lite' || mode === 'parked') a.store.trimWindows()
        changed = true
      }
      if (allowed) a.deliveryLock.start(e.origin, e.username)
      else a.deliveryLock.stop()
      a.store.setSocket(allowed)
      if (
        allowed &&
        !e.started &&
        (!foreground || a.store.getState().signedOut || old === 'parked' || old === 'lite')
      ) {
        if (a.store.getState().signedOut) a.store.setState({ signedOut: false, authExpired: false })
        e.started = true
        void a.store
          .getState()
          .bootstrap()
          .catch(() => {})
      }
      if (
        foreground &&
        (old === 'parked' || old === 'lite') &&
        (a.store.getState().me || a.store.getState().guest)
      )
        a.store.resumeView()
      if (mode !== 'parked') e.lastPoll = now
      if (mode === 'parked' && locked && now - e.lastPoll >= FIVE_MINUTES) {
        e.lastPoll = now
        void Promise.resolve(this.poll(a)).catch(() => {})
      }
    }
    // Peer nodes have their own budget. Keep an ongoing peer call first, then the
    // selected identity and remaining enabled slots in account recency order.
    const peers = ranked
      .filter(
        e =>
          e.session.socketAllowed &&
          e.session.store.getState().settings.p2p &&
          e.username &&
          e.session.store.getState().me?.username === e.username
      )
      .flatMap(e => {
        const a = e.session
        const config = ports
          .book()
          .instances.find(i => i.origin === e.origin)
          ?.accounts.find(user => user.username === e.username)?.identities
        return a.identities.enabledIds(e.username!).flatMap(id => {
          const call = a === media && id === ports.protectedIdentity()
          const viewed = a === shown && (a.identities.viewed()?.localId ?? 'main') === id
          if (!call && !viewed && config?.find(i => i.local === id)?.background === false) return []
          return [{ a, id, priority: call ? 2 : viewed ? 1 : 0 }]
        })
      })
      .sort((a, b) => b.priority - a.priority)
      .slice(0, this.budget)
    for (const { session } of entries)
      session.identities.setRunning(new Set(peers.filter(p => p.a === session).map(p => p.id)))
    if (changed) ports.publish()
  }
}
