import { beforeAll, describe, expect, test } from 'bun:test'
import { flatLocal, LOCAL, RANGES, registryJson, START_ONLY } from '../p2p/limits'
import { USER_LIMITS } from '../p2p/user_limits'
import { scanLimits, type LimitScan, type Site } from './limit_readers'

// Every device-local P2P limit is read from the limits the account's P2P started with, so an
// instance value or a user's choice for it takes effect. A name may only be read from the
// registry if the registry marks it start-only: read once as the app starts, with a range that
// allows no other value, and listed as such in the instance's copy of the registry. The registry
// only stands in for limits a caller leaves out, and no call outside the tests leaves them out.

const NAMES = [...new Set(Object.keys(flatLocal(LOCAL)).map(n => n.replace(/\.\d+$/, '')))]

const where = (x: { name: string | null; at: Site }) =>
  `${x.at.file}:${x.at.line} ${x.name ?? ''} ${x.at.text}`

describe('P2P limit readers', () => {
  let scan: LimitScan
  beforeAll(() => {
    scan = scanLimits()
  }, 900_000)

  test('every device-local limit has a reader of the account limits', () => {
    expect(NAMES.length).toBeGreaterThan(250)
    expect(NAMES.filter(n => !scan.readers.has(n) && !START_ONLY.has(n))).toEqual([])
  })

  test('no module reads a limit from the registry instead', () =>
    expect(scan.registry.filter(r => !START_ONLY.has(r.name)).map(where)).toEqual([]))

  test('no module reads the registry while it loads', () =>
    expect(scan.atLoad.filter(r => !(r.name && START_ONLY.has(r.name))).map(where)).toEqual([]))

  test('the registry only stands in for limits a caller hands in', () =>
    expect(scan.uses.filter(r => !(r.name && START_ONLY.has(r.name))).map(where)).toEqual([]))

  test('every call hands in the limits its callee would take from the registry', () => {
    for (const x of [
      'new PeerTransport(limits)',
      'new OfferGate(limits)',
      'new Calls(deps.limits)',
      'new PingLog(deps.limits)',
      'new Badges(deps.limits)',
      'new BadgeKeeper(deps.limits)',
      'new TabLeader(lim)',
      'new Dms(deps.local)',
      'new Servers(deps.local)',
      'new LocalHost(opts.local)',
      'new WorkerHost(limits)',
      'new ContactClaims(lim)',
      'parse(lim)',
      'pastFit(fit)',
      'exportP2p(kdf)',
    ])
      expect(scan.inputs).toContain(x)
    expect(scan.unset.map(where)).toEqual([])
  })

  test('start-only names are marked and allow no other value', () => {
    expect(START_ONLY.has('misc.infoWaitMs')).toBe(true)
    expect(START_ONLY.has('misc.chainChecks')).toBe(true)
    expect(START_ONLY.has('contacts.v1Checks')).toBe(true)
    for (const n of START_ONLY) {
      expect(NAMES).toContain(n)
      const items = Object.keys(RANGES).filter(k => k === n || k.startsWith(`${n}.`))
      for (const k of items) expect(RANGES[k][0]).toBe(RANGES[k][1])
    }
    expect(registryJson().start).toEqual([...START_ONLY].sort())
    expect(Object.values(USER_LIMITS).filter(n => START_ONLY.has(n))).toEqual([])
  })
})

const HOLES = `import { LOCAL, type Local } from './limits'

export class Part {
  limits: Local['calls']
  constructor(limits?: Partial<Local['calls']>) {
    this.limits = { ...LOCAL.calls, ...limits }
  }
}

export class Held {
  limits: Local['badge']
  constructor(deps: { limits?: Partial<Local['badge']> }) {
    this.limits = { ...LOCAL.badge, ...deps.limits }
  }
}

export const Fit = ({ fit = LOCAL.voice }: { fit?: Local['voice'] }) => <p>{fit.fitAudio}</p>

export let held: Local = LOCAL
export const hold = (l: Local) => {
  held = l
}

let kept: Local = LOCAL
export const fromKept = () => kept.voice.fitVideo

export const inside = () => {
  let lim = LOCAL
  return lim.voice.fitAudio
}

export const parts = (l: Local) => [
  new Part(l.calls),
  new Held({ limits: l.badge }),
  <Fit fit={l.voice} />,
  new Part(undefined),
  new Part(void 0),
  new Held({ limits: undefined }),
  new Held({ limits: void 0 }),
  <Fit fit={undefined} />,
]
`

const lineOf = (text: string) => HOLES.split('\n').findIndex(l => l.includes(text)) + 1

describe('the limit reader scan', () => {
  let scan: LimitScan
  beforeAll(() => {
    scan = scanLimits({ 'lib/p2p/limit_holes.tsx': HOLES })
  }, 300_000)

  test('only a module holder the account limits replace may start as the registry', () => {
    expect(scan.uses.map(x => x.at.line)).toEqual([
      lineOf('let kept: Local = LOCAL'),
      lineOf('let lim = LOCAL'),
    ])
    expect(scan.atLoad.map(x => x.at.line)).toEqual([lineOf('let kept: Local = LOCAL')])
  })

  test('limits handed in as undefined are left out', () =>
    expect(scan.unset.map(x => `${x.at.text} ${x.name.split('(')[0]}`)).toEqual([
      'new Part(undefined) new Part',
      'new Part(void 0) new Part',
      'new Held({ limits: undefined }) new Held',
      'new Held({ limits: void 0 }) new Held',
      '<Fit fit={undefined} /> Fit',
    ]))
})
