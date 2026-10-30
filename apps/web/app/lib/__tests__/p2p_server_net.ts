import { Hub, makeNode, ManualClock, prng, waitFor } from './p2p_net'
import { Dms } from '../p2p/dm'
import { Servers } from '../p2p/server'
import type { P2pNode } from '../p2p/node'
import type { P2pStore } from '../p2p/db'

// Test members of P2P servers: a real node, DMs and servers over the in-memory hub.

export interface Member {
  name: string
  node: P2pNode
  store: P2pStore
  dms: Dms
  servers: Servers
  db: string
}

export const running: Member[] = []

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
    servers?: Partial<ConstructorParameters<typeof Servers>[0]>
  } = {}
): Promise<Member> => {
  const n = await makeNode(hub, name, { clock, db: opts.db })
  const dms = new Dms({ node: n.node, store: n.store, clock })
  const servers = new Servers({
    node: n.node,
    store: n.store,
    dms,
    clock,
    random: prng(opts.seed ?? name.length * 7919),
    autoMax: () => 5 * 1024 * 1024,
    ...opts.servers,
  })
  await servers.start()
  await n.node.start()
  const m = { name, ...n, dms, servers }
  running.push(m)
  return m
}

// Restarts a member on its own database (it was stopped).
export const restart = async (hub: Hub, m: Member, clock: ManualClock) => {
  m.store.close()
  const again = await makeMember(hub, m.name, clock, { db: m.db })
  return again
}

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

export const bodies = async (m: Member, room: string, ch: string) =>
  (await m.servers.loadChannel(room, ch, { limit: 10_000 })).messages
    .filter(x => !x.system)
    .map(x => x.body)

export const general = (m: Member, room: string) => m.servers.view(room)?.channels[0]?.id as string

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
