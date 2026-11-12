import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { ctxFor } from '../actions/ctx'
import { registerAppActions } from '../actions/index'
import { itemFor } from '../actions/menu'
import { actionsFor, runAction } from '../actions/registry'
import { home } from '../instances'
import { AUTO_DEFAULT, parseAuto, autoChoices } from '../p2p/app'
import { LOCAL, localDefaults, RANGES } from '../p2p/limits'
import {
  accountLimits,
  applyUser,
  instanceLimits,
  limitChoices,
  limitText,
  parseUserLimits,
  readUserLimits,
  runtimeLimits,
  USER_LIMITS,
  userLimitsKey,
  writeUserLimits,
} from '../p2p/user_limits'
import { resetSessionCaches, useStore } from '../store'
import { useP2p } from '../p2p/app'
import { me, memoryStorage } from './fixtures'
import { Hub, ManualClock } from './p2p_net'
import {
  deliver,
  general,
  joinWithCode,
  makeMember,
  pump,
  restart,
  stopAll,
  stopMember,
  type Member,
} from './p2p_server_net'
import { startDeps } from '../p2p/app/account'
import type { InstanceInfo } from '../types'
import { RULES_VERSION } from '../p2p/acl/rules'
import { genesisBundle } from '../p2p/acl/binding'
import { b64u, randomBytes } from '../p2p/canonical'
import { blankRoom, UNKNOWN } from '../p2p/dag'
import { buildEvent2 } from '../p2p/event_v2'
import type { Wire } from '../p2p/event_v1'
import { keyId } from '../p2p/keys'

// The user's Advanced overrides on top of the instance's P2P_LIMITS, and where the result goes.

const MIB = 1024 * 1024
const GIB = 1024 * MIB

Object.assign(globalThis, { localStorage: memoryStorage })

afterAll(resetSessionCaches)

afterEach(() => {
  stopAll()
  memoryStorage.clear()
})

describe('user P2P limits', () => {
  test('bad stored overrides fall back', () => {
    for (const raw of [null, '', '{', '[]', '{"v":2}', '{"v":1,"roomBytes":"x"}', 'null', '7'])
      expect(parseUserLimits(raw)).toEqual({ v: 1 })
  })

  test('stored overrides keep their good fields and drop the rest', () =>
    expect(
      parseUserLimits(
        JSON.stringify({
          v: 1,
          roomBytes: 64 * MIB,
          serverBytes: Number.MAX_VALUE * 2,
          totalBytes: null,
          hiddenPauseMs: 60_000,
          sessions: 4,
        })
      )
    ).toEqual({ v: 1, roomBytes: 64 * MIB, hiddenPauseMs: 60_000 }))

  test('user values clamp to the registry', () => {
    const l = applyUser(LOCAL, { v: 1, roomBytes: 1, totalBytes: 1e18 })
    expect(l.dag.roomBytes).toBe(RANGES['dag.roomBytes'][0])
    expect(l.dag.totalBytes).toBe(RANGES['dag.totalBytes'][1])
    expect(l.dag.serverBytes).toBe(LOCAL.dag.serverBytes)
    expect(LOCAL.dag.roomBytes).toBe(200 * MIB)
  })

  test('each field maps to its registry name', () => {
    const l = applyUser(LOCAL, {
      v: 1,
      roomBytes: 64 * MIB,
      serverBytes: 2 * GIB,
      totalBytes: 4 * GIB,
      hiddenPauseMs: 15 * 60_000,
    })
    expect([l.dag.roomBytes, l.dag.serverBytes, l.dag.totalBytes, l.node.hiddenPauseMs]).toEqual([
      64 * MIB,
      2 * GIB,
      4 * GIB,
      15 * 60_000,
    ])
    expect(USER_LIMITS).toEqual({
      roomBytes: 'dag.roomBytes',
      serverBytes: 'dag.serverBytes',
      totalBytes: 'dag.totalBytes',
      hiddenPauseMs: 'node.hiddenPauseMs',
    })
  })

  test('instance values are the local names of P2P_LIMITS', () => {
    expect(
      instanceLimits({
        'local.gossip.perRoom': 4,
        'local.node.backoff.1': 90_000,
        'agreed.devCap': 4,
        'gossip.outTarget': 2,
        'local.sync.horizon': '9',
      })
    ).toEqual({ 'gossip.perRoom': 4, 'node.backoff.1': 90_000 })
    for (const bad of [undefined, null, 7, 'x', [1, 2], true])
      expect(instanceLimits(bad)).toEqual({})
  })

  test('an account takes the instance values, then its own', () => {
    const info = {
      limits: {
        p2p: {
          'local.dag.roomBytes': 512 * MIB,
          'local.dag.totalBytes': 4 * GIB,
          'local.gossip.perRoom': 1e9,
        },
      },
    }
    const l = accountLimits(info, JSON.stringify({ v: 1, roomBytes: 64 * MIB }))
    expect(l.dag.roomBytes).toBe(64 * MIB)
    expect(l.dag.totalBytes).toBe(4 * GIB)
    expect(l.gossip.perRoom).toBe(RANGES['gossip.perRoom'][1])
    expect(accountLimits(null, null)).toEqual(localDefaults())
    expect(accountLimits({ limits: { p2p: 'junk' } }, '{')).toEqual(localDefaults())
  })

  test('overrides are kept per account and only when they differ', () => {
    writeUserLimits('ann', { v: 1, roomBytes: 64 * MIB, hiddenPauseMs: LOCAL.node.hiddenPauseMs })
    expect(readUserLimits('ann')).toEqual({ v: 1, roomBytes: 64 * MIB })
    expect(readUserLimits('bob')).toEqual({ v: 1 })
    expect(JSON.parse(localStorage.getItem(home.scoped(userLimitsKey('ann'))) ?? '')).toEqual({
      v: 1,
      roomBytes: 64 * MIB,
    })
    writeUserLimits('ann', { v: 1 })
    expect(localStorage.getItem(home.scoped(userLimitsKey('ann')))).toBeNull()
    localStorage.setItem(home.scoped(userLimitsKey('ann')), '{"v":1,"roomBytes":')
    expect(readUserLimits('ann')).toEqual({ v: 1 })
  })

  test('choices stay inside the range and include the default and the current value', () => {
    for (const field of Object.keys(USER_LIMITS) as (keyof typeof USER_LIMITS)[]) {
      const [lo, hi] = RANGES[USER_LIMITS[field]]
      const list = limitChoices(field, lo + 1, hi)
      expect(list.every(v => lo <= v && v <= hi)).toBe(true)
      expect(list).toContain(lo + 1)
      expect(list).toContain(hi)
      expect([...list].sort((a, b) => a - b)).toEqual(list)
      expect(new Set(list).size).toBe(list.length)
      expect(list.length).toBeGreaterThanOrEqual(4)
    }
  })

  test('choices read as sizes and durations', () => {
    expect(limitText('roomBytes', 200 * MIB)).toBe('200.0 MB')
    expect(limitText('totalBytes', GIB)).toBe('1.00 GB')
    expect(limitText('hiddenPauseMs', 60_000)).toBe('1 minute')
    expect(limitText('hiddenPauseMs', 15 * 60_000)).toBe('15 minutes')
    expect(limitText('hiddenPauseMs', 4 * 60 * 60_000)).toBe('4 hours')
    expect(limitText('hiddenPauseMs', 90_000)).toBe('90 seconds')
  })

  test('P2P server auto-download defaults to 10 MB', () => {
    expect(parseAuto(null).server).toBe(10 * MIB)
    expect(AUTO_DEFAULT.server).toBe(10 * MIB)
    expect(LOCAL.files.autoServer).toBe(10 * MIB)
  })

  test('auto-download choices include the resolved default', () => {
    const l = localDefaults({ 'files.autoServer': 3 * MIB, 'files.autoDm': 7 * MIB })
    expect(parseAuto(null, l)).toEqual({ dm: 7 * MIB, server: 3 * MIB, daily: LOCAL.dm.autoDaily })
    expect(autoChoices(l).server).toEqual([0, MIB, 3 * MIB, 5 * MIB, 10 * MIB])
    expect(autoChoices(l).dm).toContain(7 * MIB)
    expect(parseAuto(JSON.stringify({ v: 1, dm: 0, server: 3 * MIB }), l).server).toBe(3 * MIB)
    expect(parseAuto(JSON.stringify({ v: 1, server: 3 * MIB })).server).toBe(10 * MIB)
  })
})

describe('P2P limits actions', () => {
  beforeAll(registerAppActions)
  const ctx = () => ctxFor(useStore.getState(), { kind: 'none' }, 'menu')
  const ids = () => actionsFor(ctx(), 'p2p').map(a => a.id)
  test('open the settings, and reset only when something was changed', async () => {
    useStore.setState({ me: me('ann'), guest: false, activeDialog: null })
    useP2p.setState({ account: 'ann', enabled: false })
    expect(ids()).toEqual([])
    useP2p.setState({ enabled: true })
    expect(ids()).toEqual(['p2p_limits'])
    expect(itemFor('p2p_limits', ctx())?.label).toBe('P2P storage settings')
    await runAction('p2p_limits', ctx())
    expect(useStore.getState().activeDialog).toEqual({
      kind: 'settings',
      section: 'settings',
      focus: 'p2p_limits',
    })
    writeUserLimits('ann', { v: 1, totalBytes: 4 * GIB })
    expect(ids()).toEqual(['p2p_limits', 'p2p_limits_reset'])
    expect(itemFor('p2p_limits_reset', ctx())?.label).toBe('Reset P2P limits')
    await runAction('p2p_limits_reset', ctx())
    expect(readUserLimits('ann')).toEqual({ v: 1 })
    expect(ids()).toEqual(['p2p_limits'])
    useStore.setState({ me: null, guest: true })
    expect(ids()).toEqual([])
    useP2p.setState({ account: null, enabled: false })
  })
})

describe('the P2P runtime', () => {
  test('instance values reach the runtime', async () => {
    const info = {
      limits: { p2p: { 'local.gossip.perRoom': 4, 'local.node.hiddenPauseMs': 2 * 60_000 } },
    }
    const rt = runtimeLimits(accountLimits(info, JSON.stringify({ v: 1, roomBytes: 64 * MIB })))
    const clock = new ManualClock()
    const hub = new Hub()
    const names = ['Alice', 'Bob', 'Carol', 'Dave', 'Erin', 'Fay']
    const members: Member[] = []
    for (const name of names)
      members.push(
        await makeMember(hub, name, clock, { node: rt.node, dms: rt.dms, servers: rt.servers })
      )
    const [a, ...rest] = members
    expect(a.node.limits.hiddenPauseMs).toBe(2 * 60_000)
    expect(a.servers.gossip.limits.perRoom).toBe(4)
    expect(a.dms.sync.limits.horizon).toBe(LOCAL.sync.horizon)
    const room = await a.servers.create('Budget')
    for (const m of rest) await joinWithCode(clock, a, room, m)
    // Everyone has joined: links settle within the budget, and someone uses all of it.
    const end = clock.now() + 2 * 60_000
    let most = 0
    await pump(
      clock,
      () => {
        for (const m of members) {
          const n = m.servers.sync.linksOf(room).length
          expect(n).toBeLessThanOrEqual(4)
          most = Math.max(most, n)
        }
        return clock.now() >= end
      },
      'the links',
      5_000,
      60_000
    )
    expect(most).toBe(4)
  }, 120_000)

  test('P2P starts with the instance values and the account overrides', () => {
    const was = home.info
    const p2p = { 'local.gossip.perRoom': 4 }
    home.info = { ...was, limits: { ...was?.limits, p2p } } as InstanceInfo
    try {
      writeUserLimits('ann', { v: 1, roomBytes: 64 * MIB, hiddenPauseMs: 60_000 })
      const d = startDeps('ann')
      expect(d.limits.gossip.perRoom).toBe(4)
      expect(d.servers.gossip.perRoom).toBe(4)
      expect([d.dms.roomBytes, d.servers.roomBytes]).toEqual([64 * MIB, 64 * MIB])
      expect([d.dms.totalBytes, d.servers.serverBytes]).toEqual([
        LOCAL.dag.totalBytes,
        LOCAL.dag.serverBytes,
      ])
      expect(d.node.limits.hiddenPauseMs).toBe(60_000)
      expect(d.node.session).toEqual(LOCAL.session)
      expect(d.dms.limits).toEqual(LOCAL.sync)
      expect(d.node.host).toBe(home.host)
      expect(startDeps('bob').dms.roomBytes).toBe(LOCAL.dag.roomBytes)
    } finally {
      home.info = was
    }
  })

  test('a server marked full is not full after a start with a higher limit', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const room = await a.servers.create('Budget')
    const fill = () =>
      a.store.updateRoom(room, cur => (cur ? { ...cur, full: true, fullWhy: 'bytes' } : null))
    await fill()
    // Content that fits is stored, and the room isn't full any more.
    await a.servers.send(room, { ch: general(a, room), body: 'hi' })
    expect((await a.store.room(room))?.full).toBe(false)
    const bytes = (await a.store.room(room))!.bytes!
    await fill()
    let m = a
    for (const [roomBytes, full] of [
      [bytes, true],
      [10 * bytes, false],
    ] as const) {
      stopMember(m)
      m.store.close()
      m = await makeMember(hub, 'Alice', clock, { db: m.db, servers: { roomBytes } })
      expect(m.servers.view(room)?.full).toBe(full)
      expect((await m.store.room(room))?.full).toBe(full)
    }
  }, 60_000)

  test('a full server of unknown rules stays full after a start', async () => {
    const clock = new ManualClock()
    const hub = new Hub()
    const a = await makeMember(hub, 'Alice', clock)
    const author = a.node.author()!
    const dk = keyId(author.dk.pk)
    const bare = {
      rules: RULES_VERSION + 1,
      nonce: b64u(randomBytes(16)),
      owners: [{ ik: a.node.ik, dk }],
    }
    const g = buildEvent2(
      author,
      null,
      'genesis',
      'a',
      { ...bare, owners: [genesisBundle(author.ik, dk, bare)] },
      { seq: 0 },
      clock.now()
    )
    const room = g.id
    await (a.servers as unknown as { putRoom: (r: unknown) => Promise<void> }).putRoom({
      ...blankRoom(room, '', 0),
      kind: 'server',
      name: 'Future',
    })
    const kick = (i: number) =>
      buildEvent2(author, room, 'kick', 'a', { to: i }, { seq: i, ap: [room] }, 1)
        .wire as unknown as Wire
    const was = UNKNOWN.events
    UNKNOWN.events = 3
    try {
      const out: string[] = []
      for (const w of [g.wire as unknown as Wire, kick(1), kick(2), kick(3)])
        out.push(await deliver(a, room, w, clock.now()))
      expect(out).toEqual(['new', 'new', 'new', 'full'])
      stopMember(a)
      let m = await restart(hub, a, clock)
      expect((await m.store.room(room))?.full).toBe(true)
      expect(m.servers.view(room)?.full).toBe(true)
      expect(await deliver(m, room, kick(3), clock.now())).toBe('full')
      // It is judged by what this build stores of such a server.
      stopMember(m)
      UNKNOWN.events = 10
      m = await restart(hub, m, clock)
      expect((await m.store.room(room))?.full).toBe(false)
      expect(m.servers.view(room)?.full).toBe(false)
      expect(await deliver(m, room, kick(3), clock.now())).toBe('new')
    } finally {
      UNKNOWN.events = was
    }
  }, 60_000)
})
