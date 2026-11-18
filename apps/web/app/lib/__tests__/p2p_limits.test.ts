import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MAX_PARENTS } from '../p2p/acl_room'
import { LIMITS2 } from '../p2p/event_v2'
import {
  AGREED,
  fit,
  flatLocal,
  LOCAL,
  localDefaults,
  RANGES,
  REFRESH,
  registryJson,
  START_ONLY,
  WHOLE,
  type RefreshRule,
} from '../p2p/limits'
import { LIMITS as STATE_LIMITS } from '../p2p/state'
import pinned from './fixtures/p2p_local_limits.json'

// The P2P limits registry: AGREED holds the agreed values, the copies outside it follow it, LOCAL holds
// every device-local value as fixtures/p2p_local_limits.json pins it (but for the P2P server
// auto-download, 10 MB), and the instance's copy of the registry is current.

const ASSET = fileURLToPath(new URL('../../../../../assets/p2p_limits.json', import.meta.url))
const flat = flatLocal

describe('P2P limits registry', () => {
  test('AGREED holds the agreed values', () =>
    expect(AGREED).toEqual({
      devCap: 8,
      w3: 60,
      w3mod: 600,
      win: 3_600_000,
      day: 86_400_000,
      freshCap: 2,
      idCap: 8,
      rotCap: 4,
      classes: 3,
      pendingPerDev: 20,
      codesPerDev: 20,
      codesPerDevServer: 100,
      roles: 250,
      totU: 24,
      rotTot: 4,
      poolU: 384,
      ap: 10,
      channels: 500,
      overwrites: 100,
      w4: 500,
    }))

  test('copies derive from AGREED', () => {
    expect(LIMITS2.ap).toBe(AGREED.ap)
    expect(MAX_PARENTS).toBe(AGREED.ap)
    expect(STATE_LIMITS.codesPerMember).toBe(AGREED.codesPerDev)
  })

  test('LOCAL holds the pinned values, with a 10 MB server auto-download', () =>
    expect(flat(LOCAL)).toEqual({ ...pinned, 'files.autoServer': 10 * 1024 * 1024 }))

  test('every default is inside its range', () => {
    expect(Object.keys(RANGES).sort()).toEqual(Object.keys(flat(LOCAL)).sort())
    for (const [k, v] of Object.entries(flat(LOCAL))) {
      const [lo, hi] = RANGES[k]
      expect(lo <= v && v <= hi).toBe(true)
    }
  })

  test('localDefaults overrides, clamps and ignores', () => {
    const l = localDefaults({
      'sync.statePerMin': 5000,
      'gossip.perRoom': 1e12,
      'no.such': 3,
      'dag.roomCap': Number.NaN,
      'node.sessions': -4,
    })
    expect(l.sync.statePerMin).toBe(5000)
    expect(l.gossip.perRoom).toBe(RANGES['gossip.perRoom'][1])
    expect(l.dag.roomCap).toBe(LOCAL.dag.roomCap)
    expect(l.node.sessions).toBe(RANGES['node.sessions'][0])
    expect(LOCAL.sync.statePerMin).toBe(2000)
  })

  test('localDefaults takes array items and refuses strings and inherited names', () => {
    const l = localDefaults(
      JSON.parse(
        '{"node.backoff.1": 90000, "sync.horizon": "9", "__proto__": 1, "constructor": 2, "toString": 3}'
      )
    )
    expect(l.node.backoff).toEqual([30_000, 90_000, 120_000, 300_000, 600_000])
    expect(l.sync.horizon).toBe(LOCAL.sync.horizon)
    expect(({} as Record<string, unknown>).undefined).toBeUndefined()
    expect(flat(localDefaults())).toEqual(flat(LOCAL))
    expect(Object.isFrozen(localDefaults().sync)).toBe(false)
    expect(Object.isFrozen(LOCAL.sync)).toBe(true)
  })

  describe('localDefaults keeps the default where a whole-number limit gets a fraction', () => {
    // `whole` is taken as it is; `whole + 0.25` leaves the default.
    const takesOnlyWhole = (name: string, whole: number) => {
      expect(flat(localDefaults({ [name]: whole }))[name]).toBe(whole)
      expect(flat(localDefaults({ [name]: whole + 0.25 }))[name]).toBe(flat(LOCAL)[name])
    }

    test('a count', () => {
      takesOnlyWhole('gossip.perRoom', 4)
      takesOnlyWhole('bulk.batch', 1)
      takesOnlyWhole('transfer.kdfDesktopT', 4)
    })

    test('a size', () => {
      takesOnlyWhole('dag.roomBytes', 64 * 1024 * 1024)
      takesOnlyWhole('transfer.kdfDesktopM', 65_536)
      expect(localDefaults({ 'dag.roomBytes': 5.36870912e8 }).dag.roomBytes).toBe(536_870_912)
    })

    test('a time', () => takesOnlyWhole('sync.typingMs', 1500))

    test('an item of a list', () => {
      takesOnlyWhole('node.backoff.1', 90_000)
      expect(localDefaults({ 'node.backoff.1': 90_000.5 }).node.backoff).toEqual(LOCAL.node.backoff)
    })

    test('every whole-number name', () => {
      for (const name of WHOLE)
        expect(flat(localDefaults({ [name]: RANGES[name][0] + 0.5 }))[name]).toBe(flat(LOCAL)[name])
    })

    test('a share takes a fraction', () => {
      expect(localDefaults({ 'share.room': 0.5 }).share.room).toBe(0.5)
      expect(localDefaults({ 'bulk.batch': 1.5, 'share.room': 0.5 })).toMatchObject({
        bulk: { batch: LOCAL.bulk.batch },
        share: { room: 0.5 },
      })
    })
  })

  describe('a refresh and the expiry it renews', () => {
    const d = flat(LOCAL)
    const sum = (l: Record<string, number>, names: readonly string[]) =>
      names.reduce((total, name) => total + l[name], 0)
    const holds = (l: Record<string, number>, { refresh, expiry, times, below }: RefreshRule) =>
      below ? sum(l, refresh) * times < l[expiry] : sum(l, refresh) * times <= l[expiry]

    test('each refresh fits in its expiry by default', () => {
      expect(REFRESH).toEqual([
        { refresh: ['gossip.typingRelayMs'], expiry: 'gossip.typingMs', times: 2 },
        { refresh: ['session.pingMs'], expiry: 'session.deadMs', times: 2 },
        { refresh: ['gossip.presenceMs'], expiry: 'gossip.presenceTtl', times: 2 },
        { refresh: ['voice.refreshMs'], expiry: 'voice.ttlMs', times: 2 },
        { refresh: ['voice.relayMs'], expiry: 'voice.ttlMs', times: 2 },
        { refresh: ['voice.refreshMs', 'voice.relayMs'], expiry: 'voice.lostMs', times: 1 },
        { refresh: ['voice.gapMs'], expiry: 'voice.ttlMs', times: 2 },
        {
          refresh: ['voice.gapMs', 'voice.refreshMs'],
          expiry: 'voice.lostMs',
          times: 1,
          below: true,
        },
      ])
      for (const rule of REFRESH) expect(holds(d, rule)).toBe(true)
    })

    for (const rule of REFRESH) {
      const { refresh, expiry, times, below } = rule
      const names = [...refresh, expiry]
      const bound = `${below ? 'below' : 'at most'} ${times === 2 ? 'half of ' : ''}`
      const said = `${refresh.join(' plus ')} ${bound}${expiry}`
      // Every other rule's expiry at its largest, so only this rule decides.
      const roomy = Object.fromEntries(
        REFRESH.filter(r => !names.includes(r.expiry)).map(r => [r.expiry, RANGES[r.expiry][1]])
      )
      const inRange = (name: string, v: number) => fit(name, v) === v
      // `name` alone at the edge of the rule, the others at their defaults: a millisecond inside
      // where the sum has to stay below the expiry.
      const inside = below ? 1 : 0
      const edge = (name: string) =>
        name === expiry
          ? sum(d, refresh) * times + inside
          : d[expiry] / times - (sum(d, refresh) - d[name]) - inside
      // This rule broken: it and every other rule the values break are back at their defaults,
      // whichever comes first in the list, and the rest keeps what was given.
      const kept = (given: Record<string, number>) => {
        const broken = REFRESH.filter(r => !holds({ ...d, ...roomy, ...given }, r))
        expect(broken).toContain(rule)
        const l = flat(localDefaults({ ...roomy, ...given, 'gossip.perRoom': 4 }))
        const back = broken.flatMap(r => [...r.refresh, r.expiry])
        expect(back.map(n => l[n])).toEqual(back.map(n => d[n]))
        const rest = Object.keys(roomy).filter(n => !back.includes(n))
        expect(rest.map(n => l[n])).toEqual(rest.map(n => roomy[n]))
        expect(l['gossip.perRoom']).toBe(4)
        for (const r of REFRESH) expect(holds(l, r)).toBe(true)
      }
      const taken = (given: Record<string, number>) => {
        const l = flat(localDefaults({ ...roomy, ...given }))
        expect(Object.keys(given).map(n => l[n])).toEqual(Object.values(given))
      }

      test(`${said}: every name of the rule keeps its default when it is broken`, () => {
        for (const name of refresh)
          if (inRange(name, edge(name) + 1)) kept({ [name]: edge(name) + 1 })
        const under = edge(expiry) - 1
        if (inRange(expiry, under)) kept({ [expiry]: under })
        const [lo] = RANGES[expiry]
        if (sum(d, refresh) * times > lo) kept({ [expiry]: lo - 1e6 })
        const his = Object.fromEntries(refresh.map(n => [n, RANGES[n][1]]))
        kept({ ...his, [expiry]: lo })
        kept({ ...his, [expiry]: sum(his, refresh) * times - 1 })
      })

      test(`${said}: the edge of the rule is taken`, () => {
        // An edge another rule breaks first (a name it shares, at a default stricter there) is
        // that rule's to test.
        const alone = (name: string) =>
          REFRESH.every(r => holds({ ...d, ...roomy, [name]: edge(name) }, r))
        for (const name of names)
          if (inRange(name, edge(name)) && alone(name)) taken({ [name]: edge(name) })
        const wider = Object.fromEntries(refresh.map(n => [n, d[n] + 20_000]))
        taken({ ...wider, [expiry]: sum(wider, refresh) * times + inside })
        if (below) kept({ ...wider, [expiry]: sum(wider, refresh) * times })
        taken({ ...Object.fromEntries(refresh.map(n => [n, d[n] - 1])), [expiry]: d[expiry] + 1 })
      })
    }

    test('a default one rule brings back is checked against the other rules again', () => {
      const l = localDefaults({
        'voice.ttlMs': 110_000,
        'voice.refreshMs': 55_000,
        'voice.relayMs': 60_000,
        'voice.lostMs': 300_000,
      }).voice
      expect([l.refreshMs, l.relayMs, l.ttlMs, l.lostMs]).toEqual([20_000, 5000, 60_000, 300_000])
    })
  })

  test('a start-only name keeps its value whatever the instance gives', () => {
    const names = [...START_ONLY].flatMap(n =>
      Object.keys(RANGES).filter(k => k === n || k.startsWith(`${n}.`))
    )
    expect(names).toContain('contacts.v1Checks')
    expect(names).toContain('misc.chainChecks')
    for (const d of [-1, 1])
      expect(
        flat(localDefaults(Object.fromEntries(names.map(k => [k, flat(LOCAL)[k] + d]))))
      ).toEqual(flat(LOCAL))
  })

  test('only the shares and the preview qualities take fractions', () =>
    expect(
      Object.keys(RANGES)
        .filter(name => !WHOLE.has(name))
        .sort()
    ).toEqual([
      'files.qualities.0',
      'files.qualities.1',
      'files.qualities.2',
      'files.qualities.3',
      'files.qualities.4',
      'share.room',
      'share.server',
    ]))

  test('assets/p2p_limits.json is the registry', () => {
    expect(JSON.parse(readFileSync(ASSET, 'utf8'))).toEqual(registryJson())
    expect(registryJson().refresh).toEqual([...REFRESH])
  })
})
