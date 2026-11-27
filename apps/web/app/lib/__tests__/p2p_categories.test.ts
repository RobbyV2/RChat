import { afterEach, describe, expect, test } from 'bun:test'
import { AclWorld, devOwner, TestReplica } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import { joinWithCode, makeMember, pump, stopAll, type Member } from './p2p_server_net'
import { Hub, ManualClock } from './p2p_net'
import { CHANNELS, P } from '../p2p/acl/rules'
import { CATEGORIES_MAX, categoriesOf, chcatsOf } from '../p2p/acl/summary'
import { loadPerms } from './helpers/perms'

// Categories in P2P rooms: the `category` and `chcat` registers, who may write them, and the
// writers that copy a category's overwrites to the channels that follow it.

const world = () => {
  const w = new AclWorld({ model: false, agreed: AGREED })
  w.genesis('O1', ['O'])
  w.channel('O1')
  return w
}
const join = (w: AclWorld, dev: string) => {
  w.ok('O1', 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const F = (w: AclWorld) => w.state().facts

describe('the category and chcat registers', () => {
  test('owners and Manage channels holders write them; others and malformed writes count for nothing, without a strike', () => {
    const w = world()
    const MGR = w.ok('O1', 'role_create', { pos: 5, bits: CHANNELS }).id
    for (const d of ['A1', 'B1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: MGR })
    const name = () => F(w).categories.get('k1')?.name ?? null
    const rows: [string, string, Record<string, unknown>, string | null][] = [
      ['the owner', 'O1', { id: 'k1', name: 'Team', pos: 0 }, 'Team'],
      ['a channel manager', 'A1', { id: 'k1', name: 'Crew', pos: 1 }, 'Crew'],
      ['a member without Manage channels', 'B1', { id: 'k1', name: 'Mine', pos: 0 }, 'Crew'],
      ['a malformed name', 'A1', { id: 'k1', name: 7, pos: 0 }, 'Crew'],
      ['a malformed place', 'A1', { id: 'k1', name: 'Bad', pos: 0.5 }, 'Crew'],
    ]
    for (const [what, dev, c, want] of rows) {
      expect([what, w.act(dev, 'category', c).v.s]).toEqual([what, 'A'])
      expect([what, name()]).toEqual([what, want])
    }
    const placed = () => F(w).chcats.get('c0') ?? null
    w.ok('A1', 'chcat', { ch: 'c0', cat: 'k1', sync: true })
    expect(placed()).toMatchObject({ cat: 'k1', sync: true })
    w.ok('B1', 'chcat', { ch: 'c0', cat: null, sync: false })
    w.ok('A1', 'chcat', { ch: 'c0', cat: 5, sync: false })
    expect(placed()).toMatchObject({ cat: 'k1', sync: true })
    w.ok('O1', 'chcat', { ch: 'c0', cat: null, sync: false })
    expect(placed()).toMatchObject({ cat: null, sync: false })
  })

  test('a write whose author loses Manage channels at the same moment does not count, in every order', () => {
    const w = world()
    const MGR = w.ok('O1', 'role_create', { pos: 5, bits: CHANNELS }).id
    join(w, 'A1')
    w.ok('O1', 'assign', { to: 'A', role: MGR })
    w.ok('O1', 'category', { id: 'k1', name: 'Team', pos: 0 })
    const P0 = w.heads()
    w.ok('O1', 'role_bits', { role: MGR, bit: CHANNELS, on: false }, { ap: P0 })
    w.ok('A1', 'category', { id: 'k1', name: 'Mine', pos: 0 }, { ap: P0 })
    expect(F(w).categories.get('k1')?.name).toBe('Team')
    const r = new TestReplica(AGREED)
    for (const e of [...w.all].reverse()) r.receive(e)
    expect(r.state().facts.categories.get('k1')?.name).toBe('Team')
  })

  test("an id a channel has, before or after, is never a category: its overwrites stay the channel's", () => {
    const w = world()
    w.ok('O1', 'category', { id: 'c0', name: 'Fake', pos: 0 })
    expect(F(w).categories.get('c0')).toBeUndefined()
    w.ok('O1', 'category', { id: 'k1', name: 'Team', pos: 0 })
    expect(F(w).categories.get('k1')?.name).toBe('Team')
    w.channel('O1', 'k1')
    expect(F(w).categories.get('k1')).toBeUndefined()
    expect(categoriesOf(F(w))).toEqual({})
  })

  test('a category deleted at the same moment as it is renamed stays deleted', () => {
    const w = world()
    w.ok('O1', 'category', { id: 'k1', name: 'Team', pos: 0 })
    const P0 = w.heads()
    w.ok('O1', 'category', { id: 'k1', name: 'Crew', pos: 0 }, { ap: P0 })
    w.ok('O1', 'category', { id: 'k1', name: 'Team', pos: 0, gone: true }, { ap: P0 })
    expect(F(w).categories.get('k1')?.gone).toBe(true)
    expect(categoriesOf(F(w)).k1).toBeUndefined()
  })

  test('the room shows the 50 lowest live categories and keeps fields it does not know', () => {
    const w = world()
    w.ok('O1', 'category', { id: 'k9', name: 'c9', pos: 4, style: 'dots' })
    w.ok('O1', 'chcat', { ch: 'c0', cat: 'k9', sync: false, note: 'x' })
    expect(categoriesOf(F(w)).k9).toEqual({ name: 'c9', pos: 4, extra: { style: 'dots' } })
    expect(chcatsOf(F(w)).c0).toEqual({ cat: 'k9', sync: false, extra: { note: 'x' } })
    const many = new Map<string, Record<string, unknown>>()
    for (let i = 0; i <= CATEGORIES_MAX + 1; i++)
      many.set(`k${i}`, { id: `k${i}`, name: `c${i}`, pos: CATEGORIES_MAX + 1 - i })
    many.set('k3', { id: 'k3', name: 'c3', pos: 0, gone: true })
    const shown = categoriesOf({ ...F(w), categories: many } as ReturnType<typeof F>)
    expect(Object.keys(shown)).toHaveLength(CATEGORIES_MAX)
    expect(shown.k3).toBeUndefined()
    expect(shown.k0).toBeUndefined()
    expect(shown.k1).not.toBeUndefined()
  })
})

const two = async () => {
  await loadPerms()
  const clock = new ManualClock()
  const hub = new Hub()
  const a = await makeMember(hub, 'Alice', clock)
  const b = await makeMember(hub, 'Bob', clock)
  const room = await a.servers.create('Club')
  await joinWithCode(clock, a, room, b)
  return { clock, a, b, room }
}

const overOf = (m: Member, room: string, ch: string) => m.servers.sumOf(room).overwrites?.[ch] ?? {}

describe('categories in the app', () => {
  test('channels made in a category copy its overwrites and follow them until moved or edited', async () => {
    const { clock, a, b, room } = await two()
    const bob = `u:${b.node.ik}`
    const team = await a.servers.createCategory(room, '  Team  ')
    await a.servers.setCategoryOverwrite(room, team, bob, P.ViewChannel, 0)
    const plans = await a.servers.addChannelIn(room, 'plans', team)
    const secret = await a.servers.addChannelIn(room, 'secret', team, { restrictView: true })
    expect(overOf(a, room, plans)[bob]).toEqual({ allow: P.ViewChannel, deny: 0 })
    expect(overOf(a, room, secret)).toEqual({})
    await pump(clock, () => b.servers.view(room)?.categories.length === 1, 'bob sees the category')
    const seen = b.servers.view(room)!
    expect(seen.categories[0]).toMatchObject({ id: team, name: 'Team' })
    expect(seen.channels.find(c => c.id === plans)).toMatchObject({ cat: team, sync: true })
    expect(a.servers.view(room)!.channels.find(c => c.id === secret)).toMatchObject({
      cat: team,
      sync: false,
    })
    await a.servers.setCategoryOverwrite(room, team, bob, P.ViewChannel | P.SendMessages, 0)
    expect(overOf(a, room, plans)[bob]?.allow).toBe(P.ViewChannel | P.SendMessages)
    expect(overOf(a, room, secret)).toEqual({})
    await a.servers.setOverwrite(room, plans, bob, P.ViewChannel, P.SendMessages)
    expect(a.servers.sumOf(room).chcats[plans]).toMatchObject({ cat: team, sync: false })
    await a.servers.setCategoryOverwrite(room, team, bob, 0, 0)
    expect(overOf(a, room, plans)[bob]).toEqual({ allow: P.ViewChannel, deny: P.SendMessages })
    expect(a.servers.syncWidens(room, plans)).toEqual([bob])
    await a.servers.setCategoryOverwrite(room, team, bob, 0, P.ViewChannel)
    expect(a.servers.syncWidens(room, plans)).toEqual([])
    await a.servers.setCategoryOverwrite(room, team, bob, P.ViewChannel | P.SendMessages, 0)
    expect(a.servers.syncWidens(room, plans)).toEqual([bob])
    await a.servers.syncChannel(room, plans)
    expect(overOf(a, room, plans)[bob]).toEqual({
      allow: P.ViewChannel | P.SendMessages,
      deny: 0,
    })
    expect(a.servers.sumOf(room).chcats[plans]).toMatchObject({ cat: team, sync: true })
    await a.servers.placeChannel(room, plans, null)
    expect(a.servers.sumOf(room).chcats[plans]).toMatchObject({ cat: null, sync: false })
    expect(overOf(a, room, plans)[bob]?.allow).toBe(P.ViewChannel | P.SendMessages)
    await a.servers.placeChannel(room, plans, team)
    await a.servers.deleteCategory(room, team)
    await pump(clock, () => b.servers.view(room)?.categories.length === 0, 'bob sees it gone')
    expect(b.servers.view(room)!.channels.find(c => c.id === plans)).toMatchObject({
      cat: null,
      sync: false,
    })
  })

  test('a manager ranked below a subject of the rules copies nothing, writes nothing and asks first', async () => {
    const { clock, a, b, room } = await two()
    const top = await a.servers.createRole(room, { name: 'Top', color: null, bits: 0 })
    const mgr = await a.servers.createRole(room, {
      name: 'Mgr',
      color: null,
      bits: P.ManageChannels,
    })
    await a.servers.moveRole(room, top, 10)
    await a.servers.moveRole(room, mgr, 5)
    await a.servers.assignRole(room, b.node.ik, mgr)
    const team = await a.servers.createCategory(room, 'Team')
    await a.servers.setCategoryOverwrite(room, team, `r:${top}`, P.ViewChannel, 0)
    const side = await a.servers.addChannel(room, 'side')
    await a.servers.placeChannel(room, side, team)
    await pump(clock, () => b.servers.view(room)?.categories.length === 1, 'bob sees the category')
    await pump(clock, () => b.servers.sumOf(room).chcats[side]?.cat === team, 'bob sees side moved')
    await pump(
      clock,
      () => ((b.servers.view(room)?.perms ?? 0) & P.ManageChannels ? true : false),
      'bob manages channels'
    )
    const count = () => Object.keys(b.servers.sumOf(room).channels).length
    const before = count()
    const fails = (p: Promise<unknown>) =>
      p.then(
        () => 'ok',
        (e: Error) => e.message
      )
    expect(await fails(b.servers.addChannelIn(room, 'more', team))).toBe(
      "You can't copy the rules of a role or member ranked above you."
    )
    expect(count()).toBe(before)
    expect(await fails(b.servers.syncChannel(room, side))).toBe(
      "You can't copy the rules of a role or member ranked above you."
    )
    expect(b.servers.sumOf(room).overwrites?.[side] ?? {}).toEqual({})
    expect(b.servers.sumOf(room).chcats[side]).toMatchObject({ sync: false })
  })

  test('a room makes at most 50 categories', async () => {
    const { a, room } = await two()
    const sv = a.servers as unknown as { sumOf: (room: string) => { categories: object } }
    const full = Object.fromEntries(
      Array.from({ length: CATEGORIES_MAX }, (_, i) => [`k${i}`, { name: `c${i}`, pos: i }])
    )
    const sum = sv.sumOf(room)
    const real = sv.sumOf.bind(a.servers)
    sv.sumOf = (r: string) => (r === room ? { ...sum, categories: full } : real(r))
    expect(
      await a.servers.createCategory(room, 'one more').then(
        () => 'ok',
        (e: Error) => e.message
      )
    ).toBe(`A server can have at most ${CATEGORIES_MAX} categories.`)
  })

  test('writes keep the fields of newer versions', async () => {
    const { a, room } = await two()
    const team = await a.servers.createCategory(room, 'Team')
    const ch = await a.servers.addChannelIn(room, 'plans', team)
    // A newer app's fields, written as that app would.
    const sv = a.servers as unknown as {
      emit: (room: string, t: string, make: () => Record<string, unknown>) => Promise<string>
    }
    await sv.emit(room, 'category', () => ({ id: team, name: 'Team', pos: 0, style: 'dots' }))
    await sv.emit(room, 'chcat', () => ({ ch, cat: team, sync: true, mark: 1 }))
    await a.servers.editCategory(room, team, { name: 'Crew' })
    await a.servers.placeChannel(room, ch, null)
    expect(a.servers.sumOf(room).categories[team]).toEqual({
      name: 'Crew',
      pos: 0,
      extra: { style: 'dots' },
    })
    expect(a.servers.sumOf(room).chcats[ch]).toEqual({
      cat: null,
      sync: false,
      extra: { mark: 1 },
    })
  })
})

afterEach(stopAll)
