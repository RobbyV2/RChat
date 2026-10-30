import { sha256 } from '@noble/hashes/sha2.js'
import { authRefs } from '../p2p/auth'
import { b64u, canonical, utf8 } from '../p2p/canonical'
import { keyId, newKeyPair, signCert } from '../p2p/keys'
import { EMPTY_RESOLVED, parentsOf, Resolver, type Resolved } from '../p2p/resolve'
import {
  EVERYONE,
  EVERYONE_PERMS,
  isPowerChain,
  type StateEvent,
  type StateMap,
} from '../p2p/state'

// What a member builds on: a state, its heads, and each member's latest power event there.
export interface View {
  state: StateMap
  heads: string[]
  power: (ik: string) => string | undefined
}

export const viewOf = (r: Resolved): View => ({
  state: r.state,
  heads: r.heads,
  power: ik => r.power.get(ik),
})

// Pure state-resolution worlds for the server rules tests: events aren't signed (the rules
// never look at signatures); everything else, chains included, is what members build.

export const ik = () => keyId(newKeyPair().pk)

export const T0 = 1_700_000_000_000

let tick = 0

export interface Chain {
  dseq: number
  sprev?: string
}

export const mk = (
  sender: string,
  type: string,
  skey: string,
  content: Record<string, unknown>,
  pstate: string[],
  auth: string[],
  chain: Chain & { pprev?: string },
  depth = 1,
  ts?: number
): StateEvent => {
  tick += 1
  const body = {
    sender,
    type,
    skey,
    content,
    pstate,
    auth,
    tick,
    chain,
    ...(ts === undefined ? {} : { ts }),
  }
  const e: StateEvent = {
    id: b64u(sha256(utf8(canonical(body)))),
    type,
    skey,
    sender,
    ts: ts ?? T0 + tick,
    depth,
    content,
    pstate,
    auth,
    dseq: chain.dseq,
  }
  if (chain.sprev !== undefined) e.sprev = chain.sprev
  if (chain.pprev !== undefined) e.pprev = chain.pprev
  return e
}

export const cert = (() => {
  const k = newKeyPair()
  return signCert(k, newKeyPair().pk, 1, 'Browser')
})()

// A server built step by step through the rules, like members would. Each member's chain is
// kept here (one device each).
export class World {
  events: StateEvent[] = []
  ids = new Map<string, StateEvent>()
  resolver = new Resolver()
  private cached: Resolved | null = EMPTY_RESOLVED
  now = T0
  // Each member's latest state event (whether accepted or not) and next number.
  chains = new Map<string, Chain>()

  chainOf(sender: string): Chain {
    return this.chains.get(sender) ?? { dseq: 0 }
  }

  private note(e: StateEvent) {
    const c = this.chainOf(e.sender)
    if (e.dseq >= c.dseq) this.chains.set(e.sender, { dseq: e.dseq + 1, sprev: e.id })
  }

  get res(): Resolved {
    this.cached ??= this.resolver.resolved()
    return this.cached
  }

  // The current view, without building a full result.
  get view(): View {
    return this.events.length ? this.resolver.view() : viewOf(EMPTY_RESOLVED)
  }

  add(sender: string, type: string, skey: string, content: Record<string, unknown>) {
    this.now += 1
    const e = this.build(this.view, sender, type, skey, content, this.now)
    this.hear(e)
    return e
  }

  // An event built on `view` (a stale view, or a backdated one), on the sender's real chain
  // unless `chain` says otherwise (an equivocation).
  from(
    view: Resolved | View,
    sender: string,
    type: string,
    skey: string,
    content: Record<string, unknown>,
    ts: number,
    chain?: Chain
  ) {
    return this.build(view, sender, type, skey, content, ts, chain)
  }

  build(
    from: Resolved | View,
    sender: string,
    type: string,
    skey: string,
    content: Record<string, unknown>,
    ts: number,
    chain?: Chain
  ) {
    const view = 'rejected' in from ? viewOf(from) : from
    const auth = type === 'create' ? [] : authRefs(view.state, { type, sender, skey, content })
    const c = chain ?? this.chainOf(sender)
    const powerish = isPowerChain({ type, sender, skey, content })
    const pprev = powerish ? view.power(sender) : undefined
    const depth = 1 + Math.max(0, ...view.heads.map(h => this.byId(h)?.depth ?? 0))
    return mk(
      sender,
      type,
      skey,
      content,
      type === 'create' ? [] : parentsOf(view.heads),
      auth,
      { ...c, ...(pprev ? { pprev } : {}) },
      depth,
      ts
    )
  }

  byId(id: string) {
    return this.ids.get(id)
  }

  hear(e: StateEvent) {
    if (this.ids.has(e.id)) return
    this.events.push(e)
    this.ids.set(e.id, e)
    this.note(e)
    this.resolver.add([e])
    this.cached = null
  }

  // The chain a member had at some point (for equivocating from it).
  snapshot(sender: string): Chain {
    return { ...this.chainOf(sender) }
  }

  get state() {
    return this.res.state
  }
}

export const base = (A: string, B: string) => {
  const w = new World()
  w.add(A, 'create', '', { kind: 'server', v: 1, creator: A, cert: { ...cert, ik: A } })
  w.add(A, 'member', A, { m: 'join' })
  w.add(A, 'role', EVERYONE, { name: '@everyone', color: null, perms: EVERYONE_PERMS, pos: 0 })
  w.add(A, 'channel', 'AAAAAAAAAAA', { name: 'general', kind: 'text', pos: 0 })
  w.add(A, 'member', B, { m: 'invite' })
  w.add(B, 'member', B, { m: 'join' })
  return w
}
