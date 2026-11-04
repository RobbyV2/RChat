import { decodeJwt } from 'jose'
import { AssertionError, jwksUrl, type BindingClaims } from '../identity'
import type { Contact } from './contacts'
import type { OwnBadge, P2pStore } from './db'
import { isKeyId } from './keys'
import { LOCAL } from './limits'
import { realClock, type Clock } from './session'

// The account badge (note section 2): "Confirmed as alice@host". With it on, the instance signs
// a binding (a JWT) of our identity key to our account, fetched again every day and carried in
// hellos, profile frames and our server member events. Peers check it against the issuer's keys
// when it arrives and again once their check is a day old. A check the issuer can't answer keeps
// the last result ("checked {date}"); a binding past its expiry shows as expired. Each browser
// checks for itself: the results live in its `meta` store (never exported), one key per identity.

export const BADGE = { ...LOCAL.badge }

export type BadgeLimits = typeof BADGE

// A binding that verified: who the instance says holds the key.
export interface Binding {
  token: string
  sub: string
  iss: string
  iat: number
  exp: number
  // When the issuer's keys last confirmed it, and when a later check couldn't reach them (ms).
  checked: number
  tried?: number
}

// What this browser knows of one identity's account badge.
export interface BadgeSlot {
  ik: string
  ok: Binding | null
  // A newer token the issuer couldn't be asked about yet: tried again later.
  todo: { token: string; tried: number } | null
}

export type BadgeState = 'confirmed' | 'expired' | 'unchecked'

export const badgeState = (slot: BadgeSlot | undefined, now: number): BadgeState | null => {
  if (!slot) return null
  if (slot.ok && slot.ok.exp * 1000 > now) return 'confirmed'
  if (slot.todo) return 'unchecked'
  return slot.ok ? 'expired' : null
}

export type Verdict =
  | { kind: 'ok'; claims: BindingClaims }
  | { kind: 'unreachable' }
  | { kind: 'expired' }
  | { kind: 'bad' }

// A failed check: the issuer couldn't be asked (try again later), the binding is past its
// expiry, or it is no binding for this key from this instance.
export const verdictOf = (e: unknown): Verdict => {
  if (!(e instanceof AssertionError) || e.code === 'fetch') return { kind: 'unreachable' }
  return e.code === 'expired' ? { kind: 'expired' } : { kind: 'bad' }
}

export const emptySlot = (ik: string): BadgeSlot => ({ ik, ok: null, todo: null })

// The slot after checking `token`.
export const applyVerdict = (
  slot: BadgeSlot,
  token: string,
  v: Verdict,
  now: number
): BadgeSlot => {
  const held = slot.ok?.token === token
  const todo = slot.todo?.token === token ? null : slot.todo
  switch (v.kind) {
    case 'ok': {
      const { sub, iss, iat, exp } = v.claims
      // An older binding than the one held changes nothing.
      if (slot.ok && !held && iat < slot.ok.iat) return { ...slot, todo }
      return { ik: slot.ik, ok: { token, sub, iss, iat, exp, checked: now }, todo }
    }
    case 'unreachable':
      if (held && slot.ok) return { ...slot, ok: { ...slot.ok, tried: now } }
      return { ...slot, todo: { token, tried: now } }
    case 'expired':
      return { ...slot, todo }
    case 'bad':
      // The issuer no longer vouches for the binding held (its key was withdrawn).
      return { ...slot, ok: held ? null : slot.ok, todo }
  }
}

// Members we never connect to see our badge only in our server member event: it is posted again
// when the badge is on and the event has no binding, or one with less than half its life left
// (about every 4 days while the badge stays on; turning it off posts nothing).
export const memberBindingDue = (posted: unknown, current: string | null, now: number) => {
  if (current === null || posted === current) return false
  if (typeof posted !== 'string') return true
  try {
    const { exp } = decodeJwt(posted)
    return typeof exp !== 'number' || exp * 1000 - now < BADGE.memberLeftMs
  } catch {
    return true
  }
}

const sameAccount = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()

// A contact added before `ik` that was confirmed as the same account: the identity warning goes to
// `ik`, the newer key (it may be them after a reset, or someone else). Null when `ik` is no contact.
export const accountTwin = (
  contacts: Contact[],
  slots: ReadonlyMap<string, BadgeSlot>,
  ik: string,
  sub: string
): string | null => {
  const me = contacts.find(c => c.ik === ik)
  if (!me) return null
  return (
    contacts.find(c => {
      const other = slots.get(c.ik)?.ok
      return (
        c.ik !== ik &&
        c.state !== 'blocked' &&
        !c.ignored &&
        (c.added < me.added || (c.added === me.added && c.ik < ik)) &&
        !!other &&
        sameAccount(other.sub, sub)
      )
    })?.ik ?? null
  )
}

const KEY = 'badge:'

const isBinding = (x: unknown): x is Binding => {
  const b = x as Binding | null
  return (
    typeof b === 'object' &&
    b !== null &&
    typeof b.token === 'string' &&
    typeof b.sub === 'string' &&
    typeof b.iss === 'string' &&
    Number.isSafeInteger(b.iat) &&
    Number.isSafeInteger(b.exp) &&
    Number.isSafeInteger(b.checked)
  )
}

// A stored slot, or null when it is unreadable.
export const parseSlot = (x: unknown): BadgeSlot | null => {
  const s = x as BadgeSlot | null
  if (typeof s !== 'object' || s === null || !isKeyId(s.ik)) return null
  const ok = isBinding(s.ok) ? s.ok : null
  const todo =
    typeof s.todo?.token === 'string' && Number.isSafeInteger(s.todo.tried) ? s.todo : null
  return ok || todo ? { ik: s.ik, ok, todo } : null
}

export const readSlots = async (store: P2pStore) => {
  const range = IDBKeyRange.bound(KEY, `${KEY}￿`)
  const out = new Map<string, BadgeSlot>()
  for (const raw of await store.db.getAll('meta', range)) {
    const slot = parseSlot(raw)
    if (slot) out.set(slot.ik, slot)
  }
  return out
}

export interface BadgesDeps {
  store: P2pStore
  // verifyBinding for this identity key; throws an AssertionError.
  verify: (token: string, ik: string) => Promise<BindingClaims>
  contacts: () => Contact[]
  // The identity warning for a contact confirmed as an account another contact has.
  warn: (ik: string, other: string) => Promise<void>
  clock?: Clock
  limits?: Partial<BadgeLimits>
}

// The badges of everyone we hear from (contacts, requests, server members).
export class Badges {
  readonly limits: BadgeLimits
  private slots = new Map<string, BadgeSlot>()
  private checking = new Map<string, Set<string>>()
  private refused = new Map<string, number>()
  private fns = new Set<(ik: string) => void>()
  private timer: unknown = null
  private stopped = false
  private clock: Clock

  constructor(private deps: BadgesDeps) {
    this.limits = { ...BADGE, ...deps.limits }
    this.clock = deps.clock ?? realClock
  }

  async start() {
    this.stopped = false
    this.slots = await readSlots(this.deps.store)
    this.tick()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
  }

  onChange(fn: (ik: string) => void) {
    this.fns.add(fn)
    return () => void this.fns.delete(fn)
  }

  get(ik: string) {
    return this.slots.get(ik)
  }

  all(): Record<string, BadgeSlot> {
    return Object.fromEntries(this.slots)
  }

  // A token someone sent for `ik` (hello, profile frame, member event). Anything but a string
  // of sane size is ignored (a newer version may send something else).
  offer(ik: string, token: unknown) {
    if (this.stopped || typeof token !== 'string' || !token || !isKeyId(ik)) return
    if (token.length > this.limits.tokenMax || this.refused.has(token)) return
    const slot = this.slots.get(ik)
    const now = this.clock.now()
    // Checked already: someone confirmed as a server member may only now become a contact.
    if (slot?.ok?.token === token && !this.stale(slot.ok, now)) return void this.warnTwin(ik)
    if (slot?.todo?.token === token && now - slot.todo.tried < this.limits.retryMs) return
    void this.check(ik, token)
  }

  // Confirmed as an account an older contact was confirmed as: the identity warning. The node
  // raises it once and keeps it until the contact is verified.
  private async warnTwin(ik: string) {
    const sub = this.slots.get(ik)?.ok?.sub
    if (!sub) return
    const twin = accountTwin(this.deps.contacts(), this.slots, ik, sub)
    if (twin) await this.deps.warn(ik, twin).catch(() => {})
  }

  // Checks every badge again (Couldn't check: Check again).
  recheck(ik: string) {
    const slot = this.slots.get(ik)
    for (const token of [slot?.todo?.token, slot?.ok?.token]) if (token) void this.check(ik, token)
  }

  // A day since the issuer confirmed it, and not tried lately. An expired one stays expired.
  private stale(b: Binding, now: number) {
    return (
      b.exp * 1000 > now &&
      now - b.checked > this.limits.staleMs &&
      now - (b.tried ?? 0) > this.limits.retryMs
    )
  }

  private tick() {
    if (this.stopped) return
    const now = this.clock.now()
    for (const slot of [...this.slots.values()]) {
      if (slot.todo && now - slot.todo.tried >= this.limits.retryMs)
        void this.check(slot.ik, slot.todo.token)
      else if (slot.ok && this.stale(slot.ok, now)) void this.check(slot.ik, slot.ok.token)
      else if (!slot.todo && slot.ok && now - slot.ok.exp * 1000 > this.limits.keepExpiredMs)
        void this.forget(slot.ik)
    }
    this.timer = this.clock.set(() => this.tick(), this.limits.tickMs)
  }

  private async forget(ik: string) {
    this.slots.delete(ik)
    await this.deps.store.db.delete('meta', KEY + ik).catch(() => {})
    this.changed(ik)
  }

  private async check(ik: string, token: string) {
    const busy = this.checking.get(ik) ?? new Set<string>()
    if (busy.has(token)) return
    busy.add(token)
    this.checking.set(ik, busy)
    let v: Verdict
    try {
      v = { kind: 'ok', claims: await this.deps.verify(token, ik) }
    } catch (e) {
      v = verdictOf(e)
    } finally {
      busy.delete(token)
      if (!busy.size) this.checking.delete(ik)
    }
    if (this.stopped) return
    const now = this.clock.now()
    if (v.kind === 'bad' || v.kind === 'expired') this.remember(token, now)
    const before = this.slots.get(ik) ?? emptySlot(ik)
    const next = applyVerdict(before, token, v, now)
    if (next.ok || next.todo) this.slots.set(ik, next)
    else this.slots.delete(ik)
    try {
      if (next.ok || next.todo) await this.deps.store.setMeta(KEY + ik, next)
      else await this.deps.store.db.delete('meta', KEY + ik)
    } catch {
      // The database is closing (sign out, Remove P2P data).
    }
    this.changed(ik)
    if (v.kind === 'ok') await this.warnTwin(ik)
  }

  private remember(token: string, now: number) {
    this.refused.delete(token)
    this.refused.set(token, now)
    while (this.refused.size > this.limits.refusedMax) {
      const oldest = this.refused.keys().next().value
      if (oldest === undefined) break
      this.refused.delete(oldest)
    }
  }

  private changed(ik: string) {
    for (const fn of this.fns) fn(ik)
  }
}

// ----- Our own badge -----

export interface Issued {
  token: string
  sub: string
  expires_at: number
}

// The parts of the node the keeper uses.
export interface BadgeNode {
  readonly ik: string
  readonly badge: OwnBadge | null
  setBadge: (b: OwnBadge | null) => Promise<void>
  bindingProof: (sub: string, ts: number) => string | null
}

export const UNCHECKABLE =
  "Peers can't check badges from this instance. It needs HTTPS on the default port and a public address."

// Whether peers can check bindings this instance signs: the same rule as their check.
export const peersCanCheck = (iss: string, allowLocal = false) => {
  try {
    jwksUrl(iss, allowLocal)
    return true
  } catch {
    return false
  }
}

export interface KeeperDeps {
  node: BadgeNode
  // Whether peers can check this instance's bindings (peersCanCheck on its issuer).
  checkable?: () => boolean
  // POST /api/identity/p2p_binding.
  request: (ik: string, ts: number, proof: string) => Promise<Issued>
  // This account as `user@host`, or null when signed out.
  sub: () => string | null
  // A new binding was stored (turned on, renewed).
  onIssued?: () => void
  clock?: Clock
  limits?: Partial<BadgeLimits>
}

// Fetches our binding when the badge is turned on, again every day while it stays on, and
// right away after an identity reset (the binding names the old key).
export class BadgeKeeper {
  readonly limits: BadgeLimits
  private timer: unknown = null
  private failedAt = 0
  private running: Promise<void> | null = null
  private stopped = false
  private clock: Clock

  constructor(private deps: KeeperDeps) {
    this.limits = { ...BADGE, ...deps.limits }
    this.clock = deps.clock ?? realClock
  }

  start() {
    this.stopped = false
    this.tick()
  }

  stop() {
    this.stopped = true
    if (this.timer !== null) this.clock.clear(this.timer)
    this.timer = null
  }

  // The badge was turned on for another account (the identity moved here): it needs a new
  // opt-in, and our key is never sent to this account's instance.
  private foreign() {
    const b = this.deps.node.badge
    const sub = this.deps.sub()
    return !!b?.on && !!sub && b.sub.toLowerCase() !== sub.toLowerCase()
  }

  // Whether our binding should be fetched now.
  due() {
    const b = this.deps.node.badge
    const now = this.clock.now()
    return (
      !this.foreign() &&
      !!b?.on &&
      (b.token === null ||
        b.ik !== this.deps.node.ik ||
        now - b.at >= this.limits.refreshMs ||
        b.exp * 1000 <= now)
    )
  }

  private tick() {
    if (this.stopped) return
    if (this.foreign()) void this.disable().catch(() => {})
    else if (this.due() && this.clock.now() - this.failedAt >= this.limits.retryMs)
      void this.refresh().catch(() => {})
    this.timer = this.clock.set(() => this.tick(), this.limits.tickMs)
  }

  private async fetch(): Promise<OwnBadge> {
    const { node } = this.deps
    const sub = this.deps.sub()
    const ik = node.ik
    const ts = Math.floor(this.clock.now() / 1000)
    const proof = sub ? node.bindingProof(sub, ts) : null
    if (!sub || !proof) throw new Error("This browser can't sign for your P2P identity")
    const res = await this.deps.request(ik, ts, proof)
    return {
      on: true,
      token: res.token,
      ik,
      sub: res.sub,
      at: this.clock.now(),
      exp: res.expires_at,
    }
  }

  // Asks for a new binding while the badge is on; a failure keeps the one we have (it is still
  // valid for days) and is tried again later.
  refresh(): Promise<void> {
    this.running ??= (async () => {
      try {
        if (!this.deps.node.badge?.on) return
        if (this.foreign()) return await this.disable()
        const next = await this.fetch()
        const cur = this.deps.node.badge
        // Turned off, or a new identity, while the request ran.
        if (!cur?.on || next.ik !== this.deps.node.ik) return
        await this.deps.node.setBadge(next)
        this.failedAt = 0
        this.deps.onIssued?.()
      } catch (e) {
        this.failedAt = this.clock.now()
        throw e
      } finally {
        this.running = null
      }
    })()
    return this.running
  }

  // Turning it on: only once the instance signed a binding (the error says why not).
  async enable() {
    if (this.deps.checkable?.() === false) throw new Error(UNCHECKABLE)
    const next = await this.fetch()
    if (next.ik !== this.deps.node.ik) throw new Error('Your P2P identity changed. Try again.')
    await this.deps.node.setBadge(next)
    this.failedAt = 0
    this.deps.onIssued?.()
  }

  // Turning it off drops the binding here; peers who have it may show it until it expires.
  async disable() {
    const cur = this.deps.node.badge
    if (!cur) return
    await this.deps.node.setBadge({ ...cur, on: false, token: null })
  }
}
