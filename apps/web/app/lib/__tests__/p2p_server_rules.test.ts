import { describe, expect, test } from 'bun:test'
import { authRefs, authStateOf, check, isUnknownRefusal, targetOk } from '../p2p/auth'
import { parentsOf, Resolver, resolveState, RESOLVE, RULES, type Resolved } from '../p2p/resolve'
import {
  channelsOf,
  checkState,
  EVERYONE,
  EVERYONE_PERMS,
  historyOf,
  isPowerChain,
  membershipOf,
  ownerOf,
  P,
  stateKey,
  STATE_LIMITS,
  type StateEvent,
  type StateMap,
} from '../p2p/state'
import { prng } from './p2p_net'
import { base as base0, cert, ik, mk, T0, World, type Chain, type View } from './p2p_server_world'

// Pure tests of the server auth rules and state resolution (rules version 3: Matrix v2 ordering
// with per-member chains). Events here aren't signed (the rules never look at signatures);
// everything else, chains included, is what members build.

const A = ik()
const B = ik()
const C = ik()
const D = ik()

const base = () => base0(A, B)
const loose = (sender: string, type: string, skey: string, content: Record<string, unknown>) =>
  mk(sender, type, skey, content, [], [], { dseq: 0 })

const DAY = 24 * 60 * 60_000

// Whether the event `add` adds ends up rejected (read after it is added).
const rejectedAfter = (w: World, add: () => StateEvent) => {
  const e = add()
  return w.res.rejected.has(e.id)
}

const cand = (
  sender: string,
  type: string,
  content: Record<string, unknown> | null,
  skey?: string
) => ({ id: 'x', type, sender, skey, content, auth: [] })

describe('auth rules', () => {
  const w = base()
  const s = w.state
  const banned = new Map(s)
  banned.set(stateKey('member', C), loose(A, 'member', C, { m: 'ban' }))
  const noInvite = new Map(s)
  noInvite.set(
    stateKey('role', EVERYONE),
    loose(A, 'role', EVERYONE, { name: '@everyone', color: null, perms: 0, pos: 0 })
  )
  const invited = new Map(s)
  invited.set(stateKey('member', C), loose(A, 'member', C, { m: 'invite' }))
  const withCode = new Map(s)
  withCode.set(stateKey('code', 'h'), loose(B, 'code', 'h', { exp: 1 }))
  const gone = new Map(s)
  gone.set(
    stateKey('channel', 'AAAAAAAAAAA'),
    loose(A, 'channel', 'AAAAAAAAAAA', { name: 'general', kind: 'text', pos: 0, gone: true })
  )
  const cases: [string, ReturnType<typeof cand>, StateMap, string | null][] = [
    ['a second create', cand(A, 'create', { creator: A }, ''), s, 'second create'],
    [
      'the creator joins first',
      cand(A, 'member', { m: 'join' }, A),
      new Map([...s].filter(([k]) => k.startsWith('create'))),
      null,
    ],
    [
      'someone else joins without an invite',
      cand(C, 'member', { m: 'join' }, C),
      s,
      'join without invite',
    ],
    ['an invited member joins', cand(C, 'member', { m: 'join' }, C), invited, null],
    ['an invited member turns it down', cand(C, 'member', { m: 'leave' }, C), invited, null],
    ['a member invites (@everyone may)', cand(B, 'member', { m: 'invite' }, C), s, null],
    [
      'a member invites when @everyone may not',
      cand(B, 'member', { m: 'invite' }, C),
      noInvite,
      'Invite',
    ],
    ['inviting someone banned', cand(A, 'member', { m: 'invite' }, C), banned, 'already in'],
    ['a member kicks', cand(B, 'member', { m: 'leave' }, A), s, 'Kick'],
    ['the owner kicks', cand(A, 'member', { m: 'leave' }, B), s, null],
    ['the owner bans', cand(A, 'member', { m: 'ban' }, B), s, null],
    ['a member bans', cand(B, 'member', { m: 'ban' }, A), s, 'Ban'],
    ['banning yourself', cand(A, 'member', { m: 'ban' }, A), s, 'self ban'],
    ['the owner lifts a ban', cand(A, 'member', { m: 'leave' }, C), banned, null],
    ['a member lifts a ban', cand(B, 'member', { m: 'leave' }, C), banned, 'Ban'],
    ['a member renames the server', cand(B, 'name', { name: 'x' }, ''), s, 'ManageServer'],
    ['the owner renames the server', cand(A, 'name', { name: 'x' }, ''), s, null],
    [
      'a member adds a channel',
      cand(B, 'channel', { name: 'x', kind: 'text', pos: 1 }, 'BBBBBBBBBBB'),
      s,
      'ManageChannels',
    ],
    ['a member makes an invite code', cand(B, 'code', { exp: 5 }, 'h'), s, null],
    [
      'a member revokes their own code',
      cand(B, 'code', { exp: 1, revoked: true }, 'h'),
      withCode,
      null,
    ],
    [
      'a member revokes someone else’s code',
      cand(B, 'code', { exp: 1, revoked: true }, 'h'),
      new Map([...withCode, [stateKey('code', 'h'), loose(A, 'code', 'h', { exp: 1 })]]),
      'code',
    ],
    ['a member changes history', cand(B, 'history', { vis: 'joined' }, ''), s, 'ManageServer'],
    ['a message to a channel', cand(B, 'msg', { body: 'hi', ch: 'AAAAAAAAAAA' }), s, null],
    ['a message to no channel', cand(B, 'msg', { body: 'hi', ch: 'CCCCCCCCCCC' }), s, 'no channel'],
    [
      'a message to a deleted channel',
      cand(B, 'msg', { body: 'hi', ch: 'AAAAAAAAAAA' }),
      gone,
      'no channel',
    ],
    [
      'a message from someone not joined',
      cand(C, 'msg', { body: 'hi', ch: 'AAAAAAAAAAA' }),
      invited,
      'not joined',
    ],
    ['a member pins', cand(B, 'pin', { target: 'x', on: true }), s, 'ManageMessages'],
    ['the owner pins', cand(A, 'pin', { target: 'x', on: true }), s, null],
    ['ownership to someone not joined', cand(A, 'owner', { ik: C }, ''), s, 'owner not joined'],
    ['ownership by a member', cand(B, 'owner', { ik: B }, ''), s, 'not owner'],
    ['ownership to a member', cand(A, 'owner', { ik: B }, ''), s, null],
    [
      'a member edits @everyone',
      cand(B, 'role', { name: 'e', color: null, perms: 255, pos: 0 }, EVERYONE),
      s,
      'ManageRoles',
    ],
    [
      'the owner edits @everyone',
      cand(A, 'role', { name: 'e', color: null, perms: 0, pos: 0 }, EVERYONE),
      s,
      null,
    ],
    ['a member gives themselves roles', cand(B, 'roles', { ids: [] }, B), s, 'ManageRoles'],
    ['a type from a newer version', cand(B, 'poll', { q: 'x' }), s, null],
    ['a state type from a newer version', cand(B, 'emoji', { x: 1 }, 'e'), s, null],
  ]
  for (const [name, ev, state, want] of cases)
    test(name, () => {
      expect(check(ev, state)).toBe(want)
    })

  test('targets: own edits only, redactions by the author or a moderator', () => {
    const msg = { type: 'msg', sender: B, fwd: false }
    expect(targetOk({ type: 'edit', sender: A }, msg, s)).toBe(false)
    expect(targetOk({ type: 'edit', sender: B }, msg, s)).toBe(true)
    expect(targetOk({ type: 'redact', sender: B }, msg, s)).toBe(true)
    expect(targetOk({ type: 'redact', sender: A }, msg, s)).toBe(true)
    expect(targetOk({ type: 'redact', sender: B }, { type: 'msg', sender: A, fwd: false }, s)).toBe(
      false
    )
    expect(
      targetOk({ type: 'redact', sender: A }, { type: 'name', sender: A, skey: '', fwd: false }, s)
    ).toBe(false)
    expect(targetOk({ type: 'edit', sender: B }, { ...msg, fwd: true }, s)).toBe(false)
  })

  test('auth references: the create event always, the sender’s membership', () => {
    const w2 = base()
    const e = w2.add(B, 'code', 'h2', { exp: 2 })
    const cited = e.auth.map(id => w2.byId(id) as StateEvent)
    const ok = authStateOf({ ...cand(B, 'code', e.content, 'h2'), auth: e.auth }, cited)
    expect(ok.ok).toBe(true)
    expect(cited.map(x => x.type).sort()).toEqual(['create', 'member', 'role'])
    const noCreate = authStateOf(
      { ...cand(B, 'code', e.content, 'h2'), auth: e.auth.slice(1) },
      cited.slice(1)
    )
    expect(noCreate.ok).toBe(false)
    const twice = authStateOf(
      { ...cand(B, 'code', e.content, 'h2'), auth: [...e.auth, e.auth[0]] },
      [...cited, cited[0]]
    )
    expect(twice.ok).toBe(false)
    const msgCite = cited.filter(x => x.type !== 'member')
    expect(authStateOf({ ...cand(B, 'msg', {}), auth: msgCite.map(x => x.id) }, msgCite).ok).toBe(
      false
    )
  })

  // e76d0e2: `auth type`, so a newer peer citing its new state types got struck (I4).
  test('citing a state type from a newer version is ignored, never refused', () => {
    const w2 = base()
    const chperm = w2.add(B, 'chperm', 'AAAAAAAAAAA/u:x', { view: true })
    expect(w2.res.rejected.has(chperm.id)).toBe(false)
    const msg = { body: 'x', ch: 'AAAAAAAAAAA' }
    const refs = authRefs(w2.state, { type: 'msg', sender: B, content: msg })
    const cited = [...refs, chperm.id].map(id => w2.byId(id) as StateEvent)
    const as = authStateOf({ ...cand(B, 'msg', msg), auth: cited.map(e => e.id) }, cited)
    expect(as.ok).toBe(true)
    if (as.ok) expect(check(cand(B, 'msg', msg), as.state)).toBe(null)
    // A known type that is never cited is still refused.
    const name = w2.add(A, 'name', '', { name: 'n' })
    const bad = [...refs, name.id].map(id => w2.byId(id) as StateEvent)
    expect(authStateOf({ ...cand(B, 'msg', msg), auth: bad.map(e => e.id) }, bad).ok).toBe(false)
  })
})

// ----- Convergence -----

const MOD = 'MODMODMODMM'
const HELP = 'HELPHELPHEL'
const MOD_ROLE = {
  name: 'Mod',
  color: null,
  perms: P.Kick | P.Ban | P.ManageChannels | P.Invite | P.ManageRoles,
  pos: 2,
}
const HELP_ROLE = { name: 'Helper', color: null, perms: P.Kick | P.Invite, pos: 1 }

const ACTIONS = [
  'invite',
  'join',
  'leave',
  'kick',
  'ban',
  'unban',
  'name',
  'code',
  'perms',
  'owner',
  'channel',
  'history',
  'promote',
  'demote',
  'refresh',
  'flood',
] as const

interface Sim {
  events: StateEvent[]
  // Events made from a stale or backdated view, and equivocations.
  forged: number
  forks: number
}

// Members build state events on their own view while partitions decide who hears what; each
// member's chain is theirs. With `adversarial`, members also act from views they had long ago (a
// stale device, or someone backdating on purpose: on their real chain, or equivocating from an
// old point of it), date events 0 or far in the future, cite stale or incomplete auth events, and
// flood up to the rules' caps. Everything still has to pass the receipt check, as a member would
// refuse it otherwise.
const simulate = (seed: number, adversarial = false, steps = 300): Sim => {
  const rand = prng(seed)
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]
  const ids = [A, B, C, D]
  const views = new Map(ids.map(x => [x, new World()]))
  const past = new Map<string, { view: View; chain: Chain }[]>(ids.map(x => [x, []]))
  const chains = new Map<string, Chain>(ids.map(x => [x, { dseq: 0 }]))
  const all = new Map<string, StateEvent>()
  let forged = 0
  let forks = 0
  const hear = (who: string, e: StateEvent) => (views.get(who) as World).hear(e)
  let groups: string[][] = [ids]
  let clock = T0
  const say = (
    who: string,
    type: string,
    skey: string,
    content: Record<string, unknown>,
    opts: { view?: View; chain?: Chain; ts?: number; cite?: (auth: string[]) => string[] } = {}
  ) => {
    const w = views.get(who) as World
    const view = opts.view ?? w.view
    let auth = authRefs(view.state, { type, sender: who, skey, content })
    if (opts.cite) auth = opts.cite(auth)
    clock += 1
    const chain = opts.chain ?? (chains.get(who) as Chain)
    const pprev = isPowerChain({ type, sender: who, skey, content }) ? view.power(who) : undefined
    const depth = 1 + Math.max(0, ...view.heads.map(h => all.get(h)?.depth ?? 0))
    const e = mk(
      who,
      type,
      skey,
      content,
      parentsOf(view.heads),
      auth,
      { ...chain, ...(pprev ? { pprev } : {}) },
      depth,
      opts.ts ?? clock
    )
    const cited = auth.map(id => w.byId(id))
    if (cited.some(x => !x)) return
    const c = { id: e.id, type, sender: who, skey, content, auth }
    const as = authStateOf(c, cited as StateEvent[])
    // Only what passes the receipt check: anything else is refused before it is stored.
    if (!as.ok || check(c, as.state, { at: e.ts }) !== null) return
    if (opts.view) forged += 1
    if (opts.chain) forks += 1
    all.set(e.id, e)
    chains.set(who, { dseq: e.dseq + 1, sprev: e.id })
    for (const g of groups) if (g.includes(who)) for (const x of g) hear(x, e)
  }
  const create = mk(
    A,
    'create',
    '',
    { kind: 'server', v: 1, creator: A, cert: { ...cert, ik: A } },
    [],
    [],
    { dseq: 0 },
    0
  )
  for (const x of ids) hear(x, create)
  all.set(create.id, create)
  chains.set(A, { dseq: 1, sprev: create.id })
  say(A, 'member', A, { m: 'join' })
  say(A, 'role', EVERYONE, { name: '@everyone', color: null, perms: EVERYONE_PERMS, pos: 0 })
  say(A, 'role', MOD, MOD_ROLE)
  say(A, 'role', HELP, HELP_ROLE)
  // Everyone is in, with a three-level hierarchy (owner, Mod, Helper), before the partitions.
  for (const x of [B, C, D]) {
    say(A, 'member', x, { m: 'invite' })
    say(x, 'member', x, { m: 'join' })
  }
  say(A, 'roles', B, { ids: [MOD] })
  say(A, 'roles', C, { ids: [HELP] })
  for (let step = 0; step < steps; step += 1) {
    if (step % 20 === 0) {
      // New partitions; everyone in a group first catches up with each other.
      const shuffled = [...ids].sort(() => rand() - 0.5)
      const cut = 1 + Math.floor(rand() * 3)
      groups = rand() < 0.3 ? [ids] : [shuffled.slice(0, cut), shuffled.slice(cut)]
      for (const g of groups)
        for (const x of g)
          for (const y of g) for (const e of (views.get(y) as World).events) hear(x, e)
    }
    const who = pick(ids)
    const other = pick(ids.filter(x => x !== who))
    const w = views.get(who) as World
    const mine = past.get(who) as { view: View; chain: Chain }[]
    if (step % 3 === 0) mine.push({ view: w.view, chain: { ...(chains.get(who) as Chain) } })
    // An adversarial step: an old view (on the real chain or equivocating), a strange date,
    // stale or incomplete citations.
    let opts: Parameters<typeof say>[4] = {}
    if (adversarial && rand() < 0.35 && mine.length) {
      const old = mine[Math.floor(rand() * mine.length)]
      const stale = mine[Math.floor(rand() * mine.length)]
      const r = rand()
      opts = {
        view: old.view,
        chain: rand() < 0.25 ? old.chain : undefined,
        ts: r < 0.3 ? 0 : r < 0.5 ? Number.MAX_SAFE_INTEGER : undefined,
        cite:
          rand() < 0.3
            ? auth => {
                const s = authRefs(stale.view.state, { type: 'x', sender: who })
                return [...new Set([...s, ...auth])].slice(0, auth.length)
              }
            : rand() < 0.2
              ? auth => auth.filter((_, i) => i !== 1)
              : undefined,
      }
    }
    const s = (opts.view ?? w.view).state
    const action = pick(ACTIONS)
    switch (action) {
      case 'invite':
        say(who, 'member', other, { m: 'invite' }, opts)
        break
      case 'join':
        say(who, 'member', who, { m: 'join' }, opts)
        break
      case 'refresh':
        say(who, 'member', who, { m: 'join', profile: { updated: step } }, opts)
        break
      case 'leave':
        if (rand() < 0.3) say(who, 'member', who, { m: 'leave' }, opts)
        break
      case 'kick':
        say(who, 'member', other, { m: 'leave' }, opts)
        break
      case 'ban':
        say(who, 'member', other, { m: 'ban' }, opts)
        break
      case 'unban':
        if (membershipOf(s, other) === 'ban') say(who, 'member', other, { m: 'leave' }, opts)
        break
      case 'name':
        say(who, 'name', '', { name: `name ${step}` }, opts)
        break
      case 'code':
        say(
          who,
          'code',
          `c${step % 3}`,
          { exp: step, ...(rand() < 0.3 ? { revoked: true } : {}) },
          opts
        )
        break
      case 'perms':
        say(
          who,
          'role',
          EVERYONE,
          { name: '@everyone', color: null, perms: rand() < 0.5 ? P.Invite : 0, pos: 0 },
          opts
        )
        break
      case 'owner':
        if (ownerOf(s) === who && rand() < 0.2) say(who, 'owner', '', { ik: other }, opts)
        break
      case 'channel':
        say(who, 'channel', 'AAAAAAAAAAA', { name: `c${step}`, kind: 'text', pos: 0 }, opts)
        break
      case 'history':
        say(who, 'history', '', { vis: rand() < 0.5 ? 'joined' : 'shared' }, opts)
        break
      case 'promote':
        say(who, 'roles', other, { ids: [rand() < 0.5 ? MOD : HELP] }, opts)
        break
      case 'demote':
        say(who, 'roles', other, { ids: [] }, opts)
        break
      case 'flood':
        // Up to the rules' caps (and a bit past): invites of newcomers, then codes.
        if (adversarial && rand() < 0.3)
          for (let i = 0; i < STATE_LIMITS.invitesPerMember + 2; i += 1)
            say(who, rand() < 0.5 ? 'member' : 'code', `f${step}-${i}`, { m: 'invite', exp: step })
        break
    }
  }
  return { events: [...all.values()], forged, forks }
}

const fingerprint = (r: Resolved) =>
  JSON.stringify({
    state: [...r.state].map(([k, e]) => [k, e.id]).sort(),
    rejected: [...r.rejected].sort(),
    heads: [...r.heads].sort(),
    joins: [...r.joins].sort(),
    transitions: [...r.transitions].sort(),
    flagged: [...r.flagged].sort(),
  })

const depsOf = (e: StateEvent) =>
  [...e.pstate, ...e.auth, e.sprev, e.pprev].filter((x): x is string => x !== undefined)

// Delivers events in a random order the way members store them (an event only once its auth
// events and its sender's previous state event are stored), resolving incrementally as it goes.
// Along the way, every stored event whose ancestry is all here (and holds no equivocator's
// events, whose picks wait for both branches) must already have its final verdict: acceptance
// never depends on what else a device holds.
const deliver = (events: StateEvent[], rand: () => number, ref: Resolved) => {
  const shuffled = [...events].sort(() => rand() - 0.5)
  const known = new Set(events.map(e => e.id))
  const byId = new Map(events.map(e => [e.id, e]))
  const have = new Set<string>()
  const r = new Resolver()
  const closed = new Map<string, boolean>()
  // Whether an event's whole ancestry is held, and free of equivocators.
  const isClosed = (id: string): boolean => {
    const hit = closed.get(id)
    if (hit !== undefined) return hit
    const e = byId.get(id) as StateEvent
    let ok = have.has(id) && !ref.flagged.has(e.sender)
    for (const d of depsOf(e)) if (ok && known.has(d)) ok = isClosed(d)
    if (ok) closed.set(id, true)
    return ok
  }
  let waiting = shuffled
  let checks = 0
  while (waiting.length) {
    const next: StateEvent[] = []
    for (const e of waiting) {
      if (!e.auth.every(id => have.has(id)) || (e.sprev && !have.has(e.sprev))) {
        next.push(e)
        continue
      }
      have.add(e.id)
      r.add([e])
      if (rand() < 0.1) {
        const now = r.resolved()
        for (const id of have)
          if (isClosed(id)) {
            checks += 1
            expect(now.rejected.has(id)).toBe(ref.rejected.has(id))
          }
      }
    }
    if (next.length === waiting.length) throw new Error('auth events never arrived')
    waiting = next
  }
  return { res: r.resolved(), checks }
}

const converges = (seeds: number[], adversarial: boolean, orders: number) => {
  let rejected = 0
  let lost = 0
  let forged = 0
  let forks = 0
  let flagged = 0
  let checks = 0
  for (const seed of seeds) {
    const sim = simulate(seed, adversarial)
    forged += sim.forged
    forks += sim.forks
    const ref = resolveState(sim.events)
    const reference = fingerprint(ref)
    rejected += ref.rejected.size
    lost += ref.lost.size
    flagged += ref.flagged.size
    const rand = prng(seed * 1000)
    try {
      expect(sim.events.length).toBeGreaterThan(15)
      for (let order = 0; order < orders; order += 1) {
        const got = deliver(sim.events, rand, ref)
        checks += got.checks
        expect(fingerprint(got.res)).toBe(reference)
      }
    } catch (e) {
      console.error(`convergence seed ${seed}`)
      throw e
    }
  }
  return { rejected, lost, forged, forks, flagged, checks }
}

describe('state resolution', () => {
  test('convergence fuzz: 4 members, roles, partitions, 30 delivery orders, the same state every time', () => {
    const r = converges([1, 2, 3, 4, 5], false, 30)
    // Something actually conflicted: events were rejected where they sat, or lost when merged.
    expect(r.rejected + r.lost).toBeGreaterThan(0)
    expect(r.checks).toBeGreaterThan(100)
  }, 240_000)

  test('adversarial convergence fuzz: stale views, equivocation, backdating, floods at the caps, devices holding different subsets', () => {
    const r = converges([11, 12, 13, 14, 15, 16], true, 20)
    expect(r.forged).toBeGreaterThan(20)
    expect(r.forks).toBeGreaterThan(0)
    expect(r.flagged).toBeGreaterThan(0)
    expect(r.rejected).toBeGreaterThan(0)
    expect(r.lost).toBeGreaterThan(0)
    expect(r.checks).toBeGreaterThan(100)
  }, 240_000)

  test('the result is the same whatever order the events are listed in', () => {
    const { events } = simulate(7, true)
    const ref = fingerprint(resolveState(events))
    const rand = prng(99)
    for (let i = 0; i < 10; i += 1)
      expect(fingerprint(resolveState([...events].sort(() => rand() - 0.5)))).toBe(ref)
  }, 120_000)

  test('a ban takes back what the banned member did concurrently around it', () => {
    const w = base()
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const fork = w.res
    // C invites D while A bans C, a moment apart, neither knowing of the other.
    const cInvite = w.from(fork, C, 'member', D, { m: 'invite' }, w.now + 1)
    const ban = w.from(fork, A, 'member', C, { m: 'ban' }, w.now + 2)
    const merged = resolveState([...w.events, cInvite, ban])
    expect(membershipOf(merged.state, C)).toBe('ban')
    expect(membershipOf(merged.state, D)).toBe(null)
    expect(merged.lost.has(cInvite.id)).toBe(true)
    // D's join on top of the invite that was taken back fails too.
    const at = new World()
    for (const e of [...w.events, cInvite]) at.hear(e)
    const dJoin = at.from(at.res, D, 'member', D, { m: 'join' }, w.now + 3)
    const after = resolveState([...w.events, cInvite, ban, dJoin])
    expect(membershipOf(after.state, D)).toBe(null)
    // C's invite from before the ban (an ancestor of it) stands.
    const w2 = base()
    w2.add(A, 'member', C, { m: 'invite' })
    w2.add(C, 'member', C, { m: 'join' })
    w2.add(C, 'member', D, { m: 'invite' })
    w2.add(A, 'member', C, { m: 'ban' })
    expect(membershipOf(w2.state, D)).toBe('invite')
  })

  test('incremental resolution gives what a replay gives', () => {
    const w = base()
    w.add(A, 'name', '', { name: 'x' })
    w.add(B, 'code', 'q', { exp: 3 })
    w.add(A, 'member', B, { m: 'ban' })
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
    expect(membershipOf(w.state, B)).toBe('ban')
    expect(RULES).toBe(3)
  })
})

const S = ik()
const N = ik()
const N2 = ik()
const M = ik()
const V = ik()

const profile = (w: World) => ({ m: 'join', profile: { name: 'x', updated: w.now } })

// The review's reproductions (C1, I1, I2): each failed on e76d0e2's resolution.
describe('stale and backdated events (review C1, I1, I2)', () => {
  // e76d0e2: C `join` (the ban by the re-joined moderator was lost).
  test('a stale profile refresh never undoes a ban by a moderator who was kicked and came back', () => {
    const w = base()
    w.add(A, 'role', MOD, { ...MOD_ROLE, perms: P.Kick | P.Ban | P.Invite })
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    w.add(A, 'roles', M, { ids: [MOD] })
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const fork = w.res
    w.add(A, 'member', M, { m: 'leave' })
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    w.add(M, 'member', C, { m: 'ban' })
    expect(membershipOf(w.state, C)).toBe('ban')
    const stale = w.from(fork, B, 'member', B, profile(w), w.now)
    w.hear(stale)
    expect(membershipOf(w.state, C)).toBe('ban')
    expect(w.res.lost.size).toBe(0)
    expect(w.state.get(stateKey('member', B))?.id).toBe(stale.id)
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  // e76d0e2: C `join`, owner A (a second kick and an ownership transfer undone).
  test('a stale refresh never undoes a second kick or an ownership transfer', () => {
    const w = base()
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const fork = w.res
    w.add(A, 'member', C, { m: 'leave' })
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    w.add(A, 'member', C, { m: 'leave' })
    w.add(A, 'member', B, { m: 'leave' })
    w.add(A, 'member', B, { m: 'invite' })
    w.add(B, 'member', B, { m: 'join' })
    w.add(A, 'owner', '', { ik: B })
    expect(membershipOf(w.state, C)).toBe('leave')
    expect(ownerOf(w.state)).toBe(B)
    // C's own stale refresh, relayed by anyone: on C's chain it must follow C's last state
    // event (the rejoin), which its position doesn't hold.
    const own = w.from(fork, C, 'member', C, profile(w), w.now)
    w.hear(own)
    expect(w.res.rejected.has(own.id)).toBe(true)
    // Equivocating from where C's chain was at the fork: a fork of C's chain, and the branch with
    // C's later leave... C has none of its own, so the lowest id wins; either way nothing else.
    const forked = w.from(fork, C, 'member', C, profile(w), w.now, {
      dseq: 1,
      sprev: fork.state.get(stateKey('member', C))?.id,
    })
    w.hear(forked)
    expect(membershipOf(w.state, C)).toBe('leave')
    expect(ownerOf(w.state)).toBe(B)
    expect(membershipOf(w.state, B)).toBe('join')
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  // e76d0e2: owner A, B `ban`, N `join` (the former owner's backdated ban won).
  test('a former owner can’t take ownership back by backdating, weeks later', () => {
    for (const how of ['chain', 'equivocate'] as const) {
      const w = base()
      w.add(A, 'member', C, { m: 'invite' })
      w.add(C, 'member', C, { m: 'join' })
      w.add(A, 'member', N, { m: 'invite' })
      w.add(N, 'member', N, { m: 'join' })
      const fork = w.res
      const forkTs = w.now
      const atFork = w.snapshot(A)
      w.now += DAY
      w.add(A, 'owner', '', { ik: B })
      w.now += DAY
      w.add(B, 'member', N, { m: 'ban' })
      w.now += 14 * DAY
      const chain = how === 'equivocate' ? atFork : undefined
      const ban = w.from(fork, A, 'member', B, { m: 'ban' }, forkTs + 1, chain)
      w.hear(ban)
      expect(ownerOf(w.state)).toBe(B)
      expect(membershipOf(w.state, B)).toBe('join')
      expect(membershipOf(w.state, N)).toBe('ban')
      expect(w.res.rejected.has(ban.id)).toBe(true)
      if (how === 'equivocate') expect(w.res.flagged.has(A)).toBe(true)
      // Nor by a kick, a demotion, or a role from then.
      const kick = w.from(fork, A, 'member', N, { m: 'leave' }, forkTs + 2, chain && { ...chain })
      const role = w.from(fork, A, 'roles', C, { ids: [MOD] }, forkTs + 3, chain && { ...chain })
      w.hear(kick)
      w.hear(role)
      expect(membershipOf(w.state, N)).toBe('ban')
      expect(w.state.get(stateKey('roles', C))).toBeUndefined()
      expect(ownerOf(w.state)).toBe(B)
      expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
    }
  })

  test('a former owner’s backdated transfer to a sockpuppet: one of the two transfers wins, never the former owner', () => {
    const w = base()
    w.add(A, 'member', S, { m: 'invite' })
    w.add(S, 'member', S, { m: 'join' })
    const fork = w.res
    const forkTs = w.now
    const atFork = w.snapshot(A)
    w.now += DAY
    w.add(A, 'owner', '', { ik: B })
    w.now += 14 * DAY
    // Two transfers from one point of A's chain: an equivocation where both branches give
    // ownership away. The pick is deterministic (lowest id); A never keeps it.
    w.hear(w.from(fork, A, 'owner', '', { ik: S }, forkTs + 1, atFork))
    expect([B, S]).toContain(ownerOf(w.state) as string)
    expect(w.res.flagged.has(A)).toBe(true)
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  test('two power events of one member from one point of their chain: the branch giving power up wins', () => {
    const w = base()
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    w.add(A, 'role', MOD, MOD_ROLE)
    w.add(A, 'roles', M, { ids: [] })
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    w.add(A, 'roles', M, { ids: [MOD] })
    const fork = w.res
    const atFork = w.snapshot(M)
    // One copy of M leaves; another (same point of the chain) bans C, then keeps going.
    const leave = w.from(fork, M, 'member', M, { m: 'leave' }, w.now + 1)
    w.hear(leave)
    const ban = w.from(fork, M, 'member', C, { m: 'ban' }, w.now + 2, atFork)
    w.hear(ban)
    w.hear(w.from(w.res, M, 'member', B, { m: 'leave' }, w.now + 3))
    expect(membershipOf(w.state, M)).toBe('leave')
    expect(membershipOf(w.state, C)).toBe('join')
    expect(membershipOf(w.state, B)).toBe('join')
    expect(w.res.flagged.get(M)).not.toBeUndefined()
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  // e76d0e2: V `ban`, 37 of 45 new identities joined.
  test('a banned or demoted recruiter can’t keep admitting members by backdating invites', () => {
    const setup = (how: 'ban' | 'demote') => {
      const w = base()
      w.add(A, 'role', EVERYONE, { name: '@everyone', color: null, perms: 0, pos: 0 })
      w.add(A, 'role', 'RECRECRECRE', { name: 'Rec', color: null, perms: P.Invite, pos: 1 })
      w.add(A, 'member', V, { m: 'invite' })
      w.add(V, 'member', V, { m: 'join' })
      w.add(A, 'roles', V, { ids: ['RECRECRECRE'] })
      const fork = w.res
      const forkTs = w.now
      // V's side of things: the server as V last saw it.
      const side = new World()
      for (const e of w.events) side.hear(e)
      w.now += DAY
      if (how === 'ban') w.add(A, 'member', V, { m: 'ban' })
      else w.add(A, 'roles', V, { ids: [] })
      return { w, fork, forkTs, side }
    }
    for (const how of ['ban', 'demote'] as const) {
      // The review's script: every invite from the fork, every join on the merged state. V's
      // chain gives every invite after the first away.
      {
        const { w, fork, forkTs } = setup(how)
        const news: string[] = []
        for (let i = 0; i < 45; i += 1) {
          const n = ik()
          news.push(n)
          w.hear(w.from(fork, V, 'member', n, { m: 'invite' }, forkTs))
          w.add(n, 'member', n, { m: 'join' })
        }
        expect(news.filter(n => membershipOf(w.state, n) === 'join').length).toBeLessThanOrEqual(1)
        expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
      }
      // A smarter one: each invite on V's own side branch, with the newcomers joining there too
      // (so the pending-invite cap never bites). The grace stops at RESOLVE.grace.
      {
        const { w, forkTs, side } = setup(how)
        const news: string[] = []
        for (let i = 0; i < 80; i += 1) {
          const n = ik()
          news.push(n)
          const inv = side.from(side.view, V, 'member', n, { m: 'invite' }, forkTs + i)
          side.hear(inv)
          w.hear(inv)
          const j = side.from(side.view, n, 'member', n, { m: 'join' }, forkTs + i)
          side.hear(j)
          w.hear(j)
        }
        const joined = news.filter(n => membershipOf(w.state, n) === 'join').length
        expect(joined).toBeLessThanOrEqual(RESOLVE.grace)
        expect(membershipOf(w.state, V)).toBe(how === 'ban' ? 'ban' : 'join')
        expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
      }
    }
  }, 60_000)

  test('a stale kick takes back what its target did around it, not their earlier weeks', () => {
    const w = base()
    w.add(A, 'member', V, { m: 'invite' })
    w.add(V, 'member', V, { m: 'join' })
    const fork = w.res
    w.add(V, 'member', N, { m: 'invite' })
    w.add(N, 'member', N, { m: 'join' })
    w.add(N, 'member', N2, { m: 'invite' })
    w.add(N2, 'member', N2, { m: 'join' })
    w.now += 14 * DAY
    // A's phone, which never synced (and made nothing since), kicks V.
    w.hear(w.from(fork, A, 'member', V, { m: 'leave' }, w.now))
    expect(membershipOf(w.state, V)).toBe('leave')
    expect(membershipOf(w.state, N)).toBe('join')
    expect(membershipOf(w.state, N2)).toBe('join')
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  test('a removed permission can’t be used by building on a state from before', () => {
    const w = base()
    w.add(A, 'role', EVERYONE, {
      name: '@everyone',
      color: null,
      perms: P.Invite | P.ManageChannels,
      pos: 0,
    })
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    const fork = w.res
    w.add(A, 'role', EVERYONE, { name: '@everyone', color: null, perms: P.Invite, pos: 0 })
    const pwned = w.from(
      fork,
      M,
      'channel',
      'PWNEDPWNEDP',
      { name: 'pwned', kind: 'text', pos: 1 },
      1
    )
    w.hear(pwned)
    expect(channelsOf(w.state).some(c => c.name === 'pwned')).toBe(false)
    expect(w.res.lost.has(pwned.id) || w.res.rejected.has(pwned.id)).toBe(true)
  })

  test('a demoted moderator’s concurrent kick and role grant lose to the demotion', () => {
    const w = base()
    w.add(A, 'role', MOD, MOD_ROLE)
    w.add(A, 'role', HELP, HELP_ROLE)
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    w.add(A, 'roles', M, { ids: [MOD] })
    const fork = w.res
    w.add(A, 'roles', M, { ids: [] })
    const kick = w.from(fork, M, 'member', B, { m: 'leave' }, 0)
    w.hear(kick)
    const side = new World()
    for (const e of w.events) if (e.id !== w.events[w.events.length - 2].id) side.hear(e)
    const grant = side.from(side.view, M, 'roles', B, { ids: [HELP] }, 0)
    w.hear(grant)
    expect(membershipOf(w.state, B)).toBe('join')
    expect(w.state.get(stateKey('roles', B))).toBeUndefined()
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })

  test('a power event naming the wrong latest power event of its sender is rejected', () => {
    const w = base()
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const old = w.res.power.get(A)
    w.add(A, 'name', '', { name: 'x' })
    w.add(A, 'member', D, { m: 'invite' })
    const right = w.from(w.res, A, 'member', C, { m: 'ban' }, w.now + 1)
    expect(right.pprev).toBe(w.res.power.get(A))
    const wrong = mk(A, 'member', C, { m: 'ban' }, right.pstate, right.auth, {
      dseq: right.dseq,
      ...(right.sprev ? { sprev: right.sprev } : {}),
      pprev: w.byId(old as string)?.pprev ?? 'x',
    })
    w.hear(wrong)
    expect(w.res.rejected.has(wrong.id)).toBe(true)
    expect(membershipOf(w.state, C)).toBe('join')
  })

  test('merging an accepted non-power event from an older position changes nothing else', () => {
    // Fuzz: honest histories with kicks, bans, rejoins, promotions and transfers, then any
    // member's accepted refresh or invite from any older position (one who did nothing since, so
    // their chain allows it); every other key stays.
    let tried = 0
    for (let seed = 1; seed <= 40; seed += 1) {
      const rand = prng(seed)
      const w = base()
      const people = [A, B, ...Array.from({ length: 10 }, ik)]
      w.add(A, 'role', MOD, MOD_ROLE)
      for (const p of people.slice(2)) {
        w.add(A, 'member', p, { m: 'invite' })
        w.add(p, 'member', p, { m: 'join' })
      }
      const acted = new Map<string, number>()
      const views: { res: Resolved; at: number }[] = []
      for (let k = 0; k < 60; k += 1) {
        if (rand() < 0.3) views.push({ res: w.res, at: k })
        const who = people[Math.floor(rand() * people.length)]
        const other = people[Math.floor(rand() * people.length)]
        const owner = ownerOf(w.state) as string
        const r = rand()
        w.now += 1
        if (r < 0.3) w.add(who, 'member', who, profile(w))
        else if (r < 0.45) w.add(who, 'member', ik(), { m: 'invite' })
        else if (r < 0.55) w.add(owner, 'member', other, { m: rand() < 0.5 ? 'leave' : 'ban' })
        else if (r < 0.65) {
          w.add(owner, 'member', other, { m: 'invite' })
          w.add(other, 'member', other, { m: 'join' })
          acted.set(other, k)
        } else if (r < 0.75) w.add(owner, 'roles', other, { ids: rand() < 0.5 ? [MOD] : [] })
        else if (r < 0.8) w.add(owner, 'owner', '', { ik: other })
        else if (r < 0.9) w.add(who, 'member', other, { m: 'leave' })
        else w.add(owner, 'member', other, { m: 'leave' })
        acted.set(who, k)
        acted.set(owner, k)
      }
      if (!views.length) continue
      const before = w.res
      const at = views[Math.floor(rand() * views.length)]
      const quiet = people.filter(p => (acted.get(p) ?? -1) < at.at)
      if (!quiet.length) continue
      const who = quiet[Math.floor(rand() * quiet.length)]
      const ev =
        rand() < 0.5
          ? w.from(at.res, who, 'member', who, profile(w), w.now + 1)
          : w.from(at.res, who, 'member', ik(), { m: 'invite' }, w.now + 1)
      w.hear(ev)
      // Accepted where it sits (or there is nothing to check).
      if (w.res.rejected.has(ev.id)) continue
      tried += 1
      const key = stateKey(ev.type, ev.skey)
      for (const [k, e] of before.state) if (k !== key) expect(w.state.get(k)?.id).toBe(e.id)
      for (const [k] of w.state) if (k !== key) expect(before.state.has(k)).toBe(true)
      expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
    }
    expect(tried).toBeGreaterThan(10)
  }, 120_000)
})

// A state with one key set (for views built by hand).
const withKey = (s: StateMap, key: string, e: StateEvent): StateMap => {
  const get = (k: string) => (k === key ? e : s.get(k))
  return { get, has: (k: string) => get(k) !== undefined } as unknown as StateMap
}

describe('chains and equivocation', () => {
  test('a member can’t fork themselves: a state event must sit on their previous one', () => {
    const w = base()
    const fork = w.res
    w.add(B, 'member', B, profile(w))
    w.now += 1
    const stale = w.from(fork, B, 'member', B, profile(w), w.now)
    w.hear(stale)
    expect(w.res.rejected.has(stale.id)).toBe(true)
    expect(w.res.flagged.has(B)).toBe(false)
  })

  test('equivocation: the lowest id wins without a self-revocation, the member is flagged, and their later power events are ignored', () => {
    const w = base()
    w.add(A, 'role', MOD, MOD_ROLE)
    w.add(A, 'member', M, { m: 'invite' })
    w.add(M, 'member', M, { m: 'join' })
    w.add(A, 'roles', M, { ids: [MOD] })
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    const fork = w.res
    const atFork = w.snapshot(M)
    const x = w.from(fork, M, 'name', '', { name: 'x' }, w.now + 1)
    const y = w.from(fork, M, 'member', M, profile(w), w.now + 1, atFork)
    w.hear(x)
    w.hear(y)
    const win = x.id < y.id ? x : y
    const lose = win === x ? y : x
    expect(w.res.rejected.has(lose.id)).toBe(true)
    // The fork point: M's join (the first of M's state events).
    expect(w.res.flagged.get(M)).toBe(0)
    // On the winning branch, a later kick by M is ignored; leaving still counts.
    w.chains.set(M, { dseq: win.dseq + 1, sprev: win.id })
    const kick = w.add(M, 'member', C, { m: 'leave' })
    expect(w.res.rejected.has(kick.id)).toBe(true)
    expect(membershipOf(w.state, C)).toBe('join')
    w.add(M, 'member', M, { m: 'leave' })
    expect(membershipOf(w.state, M)).toBe('leave')
    expect(fingerprint(w.res)).toBe(fingerprint(resolveState(w.events)))
  })
})

describe('caps and codes', () => {
  test('flooding state never truncates it: the create, owner, roles and bans survive in any order', () => {
    const w = base()
    w.add(A, 'member', C, { m: 'invite' })
    w.add(C, 'member', C, { m: 'join' })
    w.add(A, 'member', C, { m: 'ban' })
    const honest = [...w.events]
    // B posts 20,100 state events (invites, and refreshes that change nothing).
    for (let i = 0; i < 20_100; i += 1)
      if (i % 2) w.add(B, 'member', ik(), { m: 'invite' })
      else w.add(B, 'member', B, { m: 'join' })
    const flood = w.events.slice(honest.length)
    const res = resolveState([...flood, ...honest])
    expect(ownerOf(res.state)).toBe(A)
    expect(membershipOf(res.state, C)).toBe('ban')
    expect(membershipOf(res.state, B)).toBe('join')
    // Pending invites of a member who can't moderate are capped by the rules.
    const pending = [...res.state.values()].filter(
      e => e.type === 'member' && e.sender === B && e.content.m === 'invite'
    )
    expect(pending.length).toBe(STATE_LIMITS.invitesPerMember)
    expect(fingerprint(res)).toBe(fingerprint(w.res))
  }, 120_000)

  test('a citation must be complete: leaving out the owner (after a transfer) is rejected', () => {
    const w = base()
    w.add(A, 'owner', '', { ik: B })
    const good = w.from(w.res, A, 'name', '', { name: 'mine' }, w.now + 1)
    const cited = good.auth.filter(id => w.byId(id)?.type !== 'owner')
    const e = mk(
      A,
      'name',
      '',
      { name: 'mine' },
      good.pstate,
      cited,
      { dseq: good.dseq, sprev: good.sprev },
      9,
      w.now + 1
    )
    w.hear(e)
    expect(w.res.rejected.has(e.id)).toBe(true)
    // A roles citation without the roles it names isn't a valid citation at all.
    const w2 = base()
    w2.add(A, 'role', MOD, MOD_ROLE)
    w2.add(A, 'roles', B, { ids: [MOD] })
    const auth = authRefs(w2.state, { type: 'code', sender: B, skey: 'k' })
    expect(auth.some(id => w2.byId(id)?.skey === MOD)).toBe(true)
    const noRole = auth.filter(id => w2.byId(id)?.skey !== MOD)
    const as = authStateOf(
      { ...cand(B, 'code', { exp: 1 }, 'k'), auth: noRole },
      noRole.map(id => w2.byId(id) as StateEvent)
    )
    expect(as.ok).toBe(false)
  })

  test('caps of the rules: refreshes that change nothing, codes and pending invites', () => {
    const w = base()
    const same = w.add(B, 'member', B, { m: 'join' })
    expect(w.res.rejected.has(same.id)).toBe(true)
    const newer = w.add(B, 'member', B, { m: 'join', profile: { updated: 5 } })
    expect(w.res.rejected.has(newer.id)).toBe(false)
    for (let i = 0; i < STATE_LIMITS.codesPerMember; i += 1) w.add(B, 'code', `k${i}`, { exp: 9 })
    const extra = w.add(B, 'code', 'over', { exp: 9 })
    expect(w.res.rejected.has(extra.id)).toBe(true)
    // Revoking one makes room.
    w.add(B, 'code', 'k0', { exp: 9, revoked: true })
    expect(rejectedAfter(w, () => w.add(B, 'code', 'again', { exp: 9 }))).toBe(false)
    // The owner isn't capped.
    expect(rejectedAfter(w, () => w.add(A, 'code', 'owner', { exp: 9 }))).toBe(false)
  })

  test('a lower moderator can’t lift a ban the owner put there', () => {
    const w = base()
    w.add(A, 'role', HELP, { ...HELP_ROLE, perms: P.Ban | P.Kick })
    w.add(A, 'roles', B, { ids: [HELP] })
    w.add(A, 'member', C, { m: 'ban' })
    const lift = w.add(B, 'member', C, { m: 'leave' })
    expect(w.res.rejected.has(lift.id)).toBe(true)
    expect(membershipOf(w.state, C)).toBe('ban')
  })

  // e76d0e2: invites signed for a code carried nothing of it (autoscan 7).
  test('an invite signed for a code dies with the code, and lapses', () => {
    const code = 'Q'.repeat(43)
    const w = base()
    w.add(B, 'code', code, { exp: w.now + DAY })
    const exp = w.now + 10 * 60_000
    const inv = w.add(A, 'member', C, { m: 'invite', code, exp })
    expect(membershipOf(w.state, C)).toBe('invite')
    expect(inv.auth.some(id => w.byId(id)?.type === 'code')).toBe(true)
    // Joining after it lapsed: rejected.
    w.now = exp + 1
    const late = w.add(C, 'member', C, { m: 'join' })
    expect(w.res.rejected.has(late.id)).toBe(true)
    // Once the code is revoked, a new invite for it is rejected; so is one that outlives it, or
    // one made after the code expired.
    w.add(B, 'code', code, { exp: w.now + DAY, revoked: true })
    expect(
      rejectedAfter(w, () => w.add(A, 'member', D, { m: 'invite', code, exp: w.now + 1 }))
    ).toBe(true)
    const w2 = base()
    w2.add(B, 'code', code, { exp: w2.now + 1000 })
    expect(
      rejectedAfter(w2, () => w2.add(A, 'member', C, { m: 'invite', code, exp: w2.now + 5000 }))
    ).toBe(true)
    w2.now += 2000
    expect(
      rejectedAfter(w2, () => w2.add(A, 'member', D, { m: 'invite', code, exp: w2.now }))
    ).toBe(true)
    // A revocation concurrent with the invite, earlier in time: the invite loses.
    const w3 = base()
    w3.add(B, 'code', code, { exp: w3.now + DAY })
    const fork = w3.res
    w3.add(B, 'code', code, { exp: w3.now + DAY, revoked: true })
    const conc = w3.from(
      fork,
      A,
      'member',
      C,
      { m: 'invite', code, exp: w3.now + 60_000 },
      w3.now + 5
    )
    w3.hear(conc)
    expect(membershipOf(w3.state, C)).toBe(null)
  })

  test('values from a newer version are stored and inert, never refused with a strike', () => {
    expect(checkState('channel', 'AAAAAAAAAAA', { name: 's', kind: 'stage', pos: 1 })).toBe(true)
    expect(checkState('member', B, { m: 'knock' })).toBe(true)
    expect(checkState('history', '', { vis: 'invited' })).toBe(true)
    expect(
      checkState('role', 'AAAAAAAAAAA', { name: 'r', color: null, perms: 256 | P.Kick, pos: 1 })
    ).toBe(true)
    const w = base()
    const knock = w.add(C, 'member', C, { m: 'knock' })
    expect(isUnknownRefusal(check(cand(C, 'member', { m: 'knock' }, C), w.state))).toBe(true)
    expect(w.res.rejected.has(knock.id)).toBe(true)
    w.add(A, 'channel', 'STAGESTAGES', { name: 'stage', kind: 'stage', pos: 2 })
    expect(channelsOf(w.state).some(c => c.id === 'STAGESTAGES')).toBe(false)
    expect(isUnknownRefusal(check(cand(B, 'msg', { body: 'x', ch: 'STAGESTAGES' }), w.state))).toBe(
      true
    )
    w.add(A, 'history', '', { vis: 'invited' })
    expect(historyOf(w.state)).toBe('joined')
  })
})

// The performance budget of the rulings: a full replay of 20,000 state events with the most
// forking the chain rules allow stays under 500 ms. e76d0e2 took 6.9 s for 16,208 events with 100
// forks (the review's table).
describe('performance', () => {
  test('20,000 state events with every member forking as far as the chains allow: replay under 500 ms', () => {
    const w = base()
    const members: string[] = []
    // 1,500 honest members join.
    for (let i = 0; i < 1500; i += 1) {
      const n = ik()
      members.push(n)
      w.add(A, 'member', n, { m: 'invite' })
      w.add(n, 'member', n, { m: 'join' })
    }
    w.add(A, 'role', MOD, MOD_ROLE)
    const mods = members.slice(0, 20)
    for (const m of mods) w.add(A, 'roles', m, { ids: [MOD] })
    // From now on 300 members keep a side branch each from an old position (their own chain
    // forces each step to follow their previous one), 40 equivocate once, moderators kick from
    // stale views, while everyone else carries on and merges whatever heads they see.
    const forkers = members.slice(100, 400)
    const sides = new Map<string, View>()
    const old = w.view
    for (const f of forkers) sides.set(f, old)
    let k = 0
    while (w.events.length < 20_000) {
      k += 1
      const r = k % 10
      if (r < 4) {
        const f = forkers[k % forkers.length]
        const side = sides.get(f) as View
        w.now += 1
        const e = w.from(side, f, 'member', f, profile(w), w.now)
        w.hear(e)
        sides.set(f, {
          state: withKey(side.state, stateKey('member', f), e),
          heads: [e.id],
          power: side.power,
        })
      } else if (r === 4 && k % 250 === 4) {
        const f = forkers[Math.floor(k / 10) % forkers.length]
        const snap = w.snapshot(f)
        const before = w.chainOf(f)
        if (before.sprev && snap.dseq > 1) {
          const prev = w.byId(before.sprev) as StateEvent
          w.hear(
            w.from(old, f, 'member', f, profile(w), w.now, { dseq: prev.dseq, sprev: prev.sprev })
          )
        }
      } else if (r === 5 && k % 100 === 5) {
        const m = mods[k % mods.length]
        w.hear(w.from(old, m, 'member', members[1000 + (k % 400)], { m: 'leave' }, w.now))
      } else {
        const n = members[400 + (k % 1100)]
        w.add(n, 'member', n, profile(w))
      }
    }
    const events = w.events
    expect(events.length).toBeGreaterThanOrEqual(20_000)
    // Warm up once, then time the best of five replays (each after a full collection, so what
    // the rest of the test run left on the heap doesn't count).
    resolveState(events)
    let best = Infinity
    let res: Resolved = resolveState(events)
    for (let i = 0; i < 5; i += 1) {
      ;(globalThis as { Bun?: { gc: (full: boolean) => void } }).Bun?.gc(true)
      const t = performance.now()
      res = resolveState(events)
      best = Math.min(best, performance.now() - t)
    }
    const r = new Resolver()
    r.add(events)
    console.log(
      `replay of ${events.length} state events: ${best.toFixed(0)} ms (${r.stats.merges} merges, ${r.stats.full} full, ${res.rejected.size} rejected, ${res.flagged.size} flagged)`
    )
    expect(best).toBeLessThan(500)
    expect(ownerOf(res.state)).toBe(A)
    expect(fingerprint(res)).toBe(fingerprint(w.res))
  }, 300_000)
})
