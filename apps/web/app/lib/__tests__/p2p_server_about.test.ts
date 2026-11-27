import { describe, expect, test } from 'bun:test'
import { AclWorld, devOwner, TestReplica } from './p2p_acl_world'
import { AGREED } from '../p2p/limits'
import { KICK, SERVER, type AclContent } from '../p2p/acl/rules'
import { CANT_TEXT, actParts, effectHolds } from '../p2p/flows'
import { emptySummary } from '../p2p/acl/summary'
import { roomColor } from '../p2p/state'
import { NO_ABOUT, p2pAbout, type ServerAbout } from '../server_about'
import { Hub, ManualClock } from './p2p_net'
import { joinWithCode, makeMember, pump } from './p2p_server_net'

const world = () => {
  const w = new AclWorld({ model: false, agreed: AGREED })
  w.genesis('O1', ['O'])
  w.channel('O1')
  return w
}
const role = (w: AclWorld, pos: number, bits: number) => w.ok('O1', 'role_create', { pos, bits }).id
const join = (w: AclWorld, dev: string) => {
  w.ok('O1', 'add', { to: devOwner(dev) })
  return w.ok(dev, 'join')
}
const about = (w: AclWorld) => p2pAbout(w.state().facts.about ?? null)

describe('about: a server keeps its description and icon in a register', () => {
  test('admitted by the generic rule; only owners and Manage server holders change it', () => {
    const w = world()
    const MGR = role(w, 5, SERVER)
    const MOD = role(w, 4, KICK)
    for (const d of ['A1', 'B1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: MGR })
    w.ok('O1', 'assign', { to: 'B', role: MOD })
    expect(about(w)).toEqual(NO_ABOUT)
    const rows: [string, string, Record<string, unknown>, string, ServerAbout][] = [
      [
        'the owner',
        'O1',
        { text: 'Book talk', icon: 'identicon' },
        'A',
        { text: 'Book talk', icon: 'identicon' },
      ],
      [
        'Manage server',
        'A1',
        { text: 'Books and tea', icon: 'identicon' },
        'A',
        { text: 'Books and tea', icon: 'identicon' },
      ],
      [
        'a moderator without it',
        'B1',
        { text: 'Mine', icon: 'letter' },
        'A',
        { text: 'Books and tea', icon: 'identicon' },
      ],
      ['malformed fields, no strike', 'A1', { text: 7, icon: 'square', more: 1 }, 'A', NO_ABOUT],
    ]
    for (const [what, dev, c, verdict, want] of rows) {
      expect([what, w.act(dev, 'about', c).v.s]).toEqual([what, verdict])
      expect([what, about(w)]).toEqual([what, want])
    }
    expect(w.state().facts.about as unknown).toEqual({ text: 7, icon: 'square', more: 1 })
    w.ok('O1', 'add', { to: 'C' })
    expect(w.act('C1', 'about', { text: 'x' }).v.s).toBe('R')
  })

  test('the same writes read the same in every order; a demoted writer’s does not count', () => {
    const w = world()
    const MGR = role(w, 5, SERVER)
    for (const d of ['A1', 'B1']) join(w, d)
    w.ok('O1', 'assign', { to: 'A', role: MGR })
    w.ok('O1', 'assign', { to: 'B', role: MGR })
    const P0 = w.heads()
    const a = w.ok('A1', 'about', { text: 'alpha' }, { ap: P0 })
    const b = w.ok('B1', 'about', { text: 'beta' }, { ap: P0 })
    const want = a.id < b.id ? 'alpha' : 'beta'
    expect(about(w).text).toBe(want)
    let s = 7
    for (let k = 0; k < 6; k++) {
      const order = [...w.all]
      for (let i = order.length - 1; i > 0; i--) {
        s = (s * 1103515245 + 12345) & 0x7fffffff
        const j = s % (i + 1)
        ;[order[i], order[j]] = [order[j], order[i]]
      }
      const r = new TestReplica(AGREED)
      for (const e of order) r.receive(e)
      expect(p2pAbout(r.state().facts.about ?? null).text).toBe(want)
    }
    w.ok('A1', 'about', { text: 'gamma' })
    expect(about(w).text).toBe('gamma')
    // B writes while the owner, concurrently, takes B's role: it stays live and doesn't count.
    const P1 = w.heads()
    w.ok('O1', 'revoke', { to: 'B', role: MGR })
    const late = w.ok('B1', 'about', { text: 'delta' }, { ap: P1 })
    expect(w.state().cut.has(late.id)).toBe(false)
    expect(about(w).text).toBe('gamma')
  })
})

describe('about between devices', () => {
  test('an owner’s change reaches members, keeps fields it does not know, and others may not write', async () => {
    const hub = new Hub()
    const clock = new ManualClock()
    const a = await makeMember(hub, 'Alice', clock)
    const b = await makeMember(hub, 'Bob', clock)
    const room = await a.servers.create('Readers')
    await joinWithCode(clock, a, room, b)
    await a.servers.setAbout(room, { text: '  Monthly books\n\n\n\nand tea ', icon: 'identicon' })
    expect(a.servers.view(room)?.about).toEqual({
      text: 'Monthly books\n\nand tea',
      icon: 'identicon',
    })
    await pump(clock, () => b.servers.view(room)?.about.icon === 'identicon', 'b sees the icon')
    expect(b.servers.view(room)?.about.text).toBe('Monthly books\n\nand tea')
    await a.servers.setAbout(room, { text: null })
    expect(a.servers.view(room)?.about).toEqual({ text: null, icon: 'identicon' })
    expect(a.servers.sumOf(room).about as unknown).toEqual({ icon: 'identicon' })
    const refused = await b.servers.setAbout(room, { text: 'mine' }).then(
      () => 'ok',
      (e: Error) => e.message
    )
    expect(refused).toBe(CANT_TEXT)
  })
})

describe('about after a lost device', () => {
  test('our about write holds while the server shows it, and lists by name', () => {
    const c = { text: 'Hi', icon: 'identicon' }
    const s = { ...emptySummary(), about: c as unknown as AclContent }
    expect(effectHolds('about', c, 'x', 'me', s, 0)).toBe(true)
    expect(effectHolds('about', { text: 'Old' }, 'x', 'me', s, 0)).toBe(false)
    expect(actParts('about')).toEqual({ act: 'Change the server description and icon' })
  })

  test('a room colour reads only when it is a valid one', () => {
    const at = (color: unknown) =>
      roomColor({ ...emptySummary(), settings: { name: 'x', color } as unknown as AclContent })
    expect(at(0x112233)).toBe(0x112233)
    expect(at(-1)).toBeNull()
    expect(at(0x1000000)).toBeNull()
    expect(at('#112233')).toBeNull()
    expect(roomColor(emptySummary())).toBeNull()
  })
})
