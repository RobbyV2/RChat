import { own } from './helpers/fixture'
import { Hub, makeNode, ManualClock, prng, waitFor } from './p2p_net'
import { CHANNEL_CONTENT } from '../p2p/event_v2'
import { chainKey, type DevChain } from '../p2p/dag'
import { Dms } from '../p2p/dm'
import { buildEvent2, type ChainFields } from '../p2p/event_v2'
import { type Wire } from '../p2p/event_v1'
import { keyId } from '../p2p/keys'
import { Servers } from '../p2p/server'
import type { AclHost } from '../p2p/resolve_host'
import type { NodeDeps, P2pNode } from '../p2p/node'
import type { P2pStore } from '../p2p/db'
import { localDefaults, type Local } from '../p2p/limits'

// Test members of P2P servers: a real node, DMs and servers over the in-memory hub, stopped after
// the test that made them. Each member's DMs and servers share one copy of the limits
// (`limits(m)`), which a test may change as it runs.

export interface Member {
  name: string
  node: P2pNode
  store: P2pStore
  dms: Dms
  servers: Servers
  db: string
}

export const running: Member[] = []

const tuners: ((l: Local) => void)[] = []

// Every member made while `fn` runs starts with `tune` applied to its limits.
export const withLimits = async <T>(tune: (l: Local) => void, fn: () => Promise<T>) => {
  tuners.push(tune)
  try {
    return await fn()
  } finally {
    tuners.splice(tuners.indexOf(tune), 1)
  }
}

export const stopAll = () => {
  for (const m of running.splice(0)) stopMember(m)
}

export const stopMember = (m: Member) => {
  m.servers.stop()
  m.dms.stop()
  m.node.stop()
}

export const makeMember = async (
  hub: Hub,
  name: string,
  clock: ManualClock,
  opts: {
    seed?: number
    db?: string
    node?: Pick<NodeDeps, 'limits' | 'session' | 'contacts'> & { transport?: NodeDeps['transport'] }
    dms?: Partial<ConstructorParameters<typeof Dms>[0]>
    servers?: Partial<ConstructorParameters<typeof Servers>[0]>
  } = {}
): Promise<Member> => {
  const n = await makeNode(hub, name, { clock, db: opts.db, ...opts.node })
  const local = localDefaults()
  for (const t of tuners) t(local)
  const dms = new Dms({ node: n.node, store: n.store, clock, local, ...opts.dms })
  const servers = new Servers({
    node: n.node,
    store: n.store,
    dms,
    clock,
    local,
    random: prng(opts.seed ?? name.length * 7919),
    autoMax: () => 5 * 1024 * 1024,
    ...opts.servers,
  })
  await dms.start()
  await servers.start()
  await n.node.start()
  const m = { name, ...n, dms, servers }
  running.push(m)
  return own(m, member => {
    const at = running.indexOf(member)
    if (at >= 0) running.splice(at, 1)
    stopMember(member)
  })
}

// Restarts a member on its own database (it was stopped).
export const restart = async (hub: Hub, m: Member, clock: ManualClock) => {
  m.store.close()
  const again = await makeMember(hub, m.name, clock, { db: m.db })
  return again
}

// A member's running limits, to change while a test runs.
export const limits = (m: Member) => m.servers.local as Local

export const eventually = async (
  ok: () => Promise<boolean> | boolean,
  what: string,
  ms = 20_000
) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await new Promise(r => setTimeout(r, 2))
  }
}

// Advances the manual clock in steps while waiting, so gossip ticks and dials run.
export const pump = async (
  clock: ManualClock,
  ok: () => Promise<boolean> | boolean,
  what: string,
  step = 5_000,
  ms = 30_000
) => {
  const end = Date.now() + ms
  while (!(await ok())) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await clock.advance(step)
    await new Promise(r => setTimeout(r, 2))
  }
}

// What shows: messages, not join and leave lines or the line in place of a hidden message.
export const bodies = async (m: Member, room: string, ch: string) =>
  (await m.servers.loadChannel(room, ch, { limit: 10_000 })).messages
    .filter(x => !x.system && !x.removed)
    .map(x => x.body)

export const general = (m: Member, room: string) => m.servers.view(room)?.channels[0]?.id as string

// `owner` creates a server with co-owners, each of whom agrees when asked.
export const createWith = async (clock: ManualClock, owner: Member, name: string, co: Member[]) => {
  const made = owner.servers.create(
    name,
    co.map(m => m.node.ik)
  )
  for (const m of co) {
    await pump(
      clock,
      () => m.servers.coOwnerAsks().some(x => x.from === owner.node.ik),
      `${m.name} asked`,
      1_000
    )
    m.servers.answerCoOwner(m.servers.coOwnerAsks().find(x => x.from === owner.node.ik)!.key, true)
  }
  return made
}

// A creates a server and B joins it with a code.
export const joinWithCode = async (
  clock: ManualClock,
  owner: Member,
  room: string,
  who: Member
) => {
  const code = await owner.servers.issueCode(room, 60 * 60_000)
  await who.servers.redeem(code)
  await pump(clock, () => who.servers.myMembership(room) === 'join', `${who.name} joined`)
  await pump(
    clock,
    () =>
      owner.servers.view(room)?.members.some(m => m.ik === who.node.ik && m.m === 'join') === true,
    `${owner.name} sees ${who.name} join`
  )
  return code
}

export { Hub, ManualClock, waitFor }

// The evaluator's plan for an event of `m` (parents, chain fields, watermark).
export const planOf = (m: Member, room: string, t: string, L: 'a' | 'c' = 'a', to?: string) =>
  (m.servers as unknown as { host: AclHost }).host.plan(room, {
    t,
    L,
    a: m.node.ik,
    dev: keyId(m.node.author()!.dk.pk),
    to,
  })

// An event `m` signs as an honest client would, with `over` replacing chain fields (a backdated
// position, a reused seq), not yet received anywhere.
export const signed = async (
  m: Member,
  room: string,
  t: string,
  content: Record<string, unknown>,
  over: Partial<ChainFields> & { ts?: number } = {}
) => {
  const L = CHANNEL_CONTENT.includes(t) ? 'c' : 'a'
  const plan = await planOf(m, room, t, L)
  const fields: ChainFields = { seq: plan.seq + 1, ap: plan.ap }
  const chain =
    (await m.store.meta<DevChain>(chainKey(room, keyId(m.node.author()!.dk.pk)))) ?? null
  if (L === 'c' && chain?.cprev) fields.cprev = chain.cprev
  if (L === 'a' && plan.aprev) fields.aprev = plan.aprev
  if (L === 'a' && plan.iprev) fields.iprev = plan.iprev
  const { ts, ...rest } = over
  const out = buildEvent2(
    m.node.author()!,
    room,
    t,
    L,
    content,
    { ...fields, ...rest },
    ts ?? plan.ts + 1
  )
  return { id: out.id, wire: out.wire as unknown as Wire }
}

// Delivers an event to `m` as sync would: the wire checks, then admission and storage.
export const deliver = async (m: Member, room: string, wire: Wire, now: number) => {
  const v = await m.servers.check(room, wire)
  if (!v.ok) return v.later ? 'later' : 'malformed'
  return (await m.servers.insert(room, v.id, v.wire, now)).status
}
