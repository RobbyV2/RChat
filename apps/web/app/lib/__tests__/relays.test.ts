import { describe, expect, test } from 'bun:test'
import {
  AUTO,
  DECLARED_MAX,
  GONE,
  RelayBook,
  allowHost,
  cleanHost,
  cleanRelaysSection,
  declaredHosts,
  defaultRelays,
  displayHost,
  exportRelays,
  failedText,
  hidesIp,
  knownHosts,
  mergeRelays,
  parseRelayPrefs,
  parseRelayUrl,
  promptText,
  relayPrefsValue,
  relaysText,
  resolveIce,
  UNREADABLE,
  PROMPTS,
  unknownHosts,
  type Decision,
  type IceInputs,
  type RelayPrefs,
} from '../relays'
import { buildConfig, decodeConfig, encodeConfig, linkDoc, SECTIONS } from '../config_transfer'
import hostCases from './fixtures/relay_hosts.json'

// URLs are built from parts so no ICE URL literal sits in the app tree (see ice.test.ts).
const T = 'turn'
const S = 'stun'
const url = (scheme: string, rest: string) => `${scheme}:${rest}`

const prefs = (over: Partial<RelayPrefs> = {}): RelayPrefs => ({ ...defaultRelays(), ...over })

const inputs = (over: Partial<IceInputs> = {}): IceInputs => ({
  instance: [
    { urls: [url(S, 'inst.example:3478')] },
    { urls: url(T, 'inst.example:3478?transport=udp'), username: 'x', credential: 'y' },
  ],
  helpers: true,
  relayOnly: false,
  instanceTurn: true,
  forced: null,
  ...over,
})

describe('relay URLs', () => {
  test('stun, turn and turns with a host, optional port and transport', () => {
    const ok = (text: string, want: string, host: string) => {
      const p = parseRelayUrl(text)
      expect(p).toEqual({ ok: true, url: want, scheme: p.ok ? p.scheme : S, host })
    }
    ok(url(S, 'Stun.Example.com'), url(S, 'stun.example.com'), 'stun.example.com')
    ok(url('TURN', 'relay.example.com:3478'), url(T, 'relay.example.com:3478'), 'relay.example.com')
    ok(
      `  ${url(T, 'relay.example.com:3478?transport=TCP')} `,
      url(T, 'relay.example.com:3478?transport=tcp'),
      'relay.example.com'
    )
    ok(
      url('turns', 'relay.example.com:5349?transport=tcp'),
      url('turns', 'relay.example.com:5349?transport=tcp'),
      'relay.example.com'
    )
    ok(url(T, '10.0.0.5:3478'), url(T, '10.0.0.5:3478'), '10.0.0.5')
    ok(url(T, '[2001:DB8::1]:3478'), url(T, '[2001:db8::1]:3478'), '[2001:db8::1]')
    ok(url(T, 'bücher.example'), url(T, 'xn--bcher-kva.example'), 'xn--bcher-kva.example')
  })

  test('anything else is refused', () => {
    for (const bad of [
      '',
      'relay.example.com',
      'http://relay.example.com',
      url('stuns', 'relay.example.com'),
      url(T, '//relay.example.com'),
      url(T, 'user:pw@relay.example.com'),
      url(T, 'relay.example.com:0'),
      url(T, 'relay.example.com:65536'),
      url(T, 'relay.example.com:03478'),
      url(T, 'relay.example.com/path'),
      url(T, 'relay.example.com?transport=sctp'),
      url(T, 'relay.example.com?transport=udp&x=1'),
      url(S, 'relay.example.com?transport=udp'),
      url('turns', 'relay.example.com?transport=udp'),
      url(T, '-bad.example'),
      url(T, 'a..b'),
      url(T, '1.2.3'),
      url(T, '0x7f.0.0.1'),
      url(T, '999.1.1.1'),
      url(T, '[not-v6]'),
      url(T, '<b>x</b>'),
      url(T, 'relay example'),
      url(T, `${'a'.repeat(64)}.example`),
      url(T, `${'a.'.repeat(200)}example`),
    ])
      expect(parseRelayUrl(bad).ok).toBe(false)
  })

  test('hosts are plain lowercase ASCII and shown cut down', () => {
    // The same cases as the server's relay_host (p2p.rs).
    for (const [raw, clean] of hostCases.good) expect(cleanHost(raw)).toBe(clean)
    for (const bad of [...hostCases.bad, 7, null]) expect(cleanHost(bad)).toBeNull()
    const long = `${'a'.repeat(60)}.example`
    expect(displayHost(long).length <= 48).toBe(true)
    expect(displayHost(long)).toContain('...')
    expect(displayHost('<b>x</b>.example')).toBe('bxb.example')
    expect(promptText('relay.example')).toBe(
      'Connect through relay.example? That relay can see your IP address unless you use relay only.'
    )
    // The prompt shows the whole host, so two long hosts that differ in the middle never match.
    const a = `${'a'.repeat(30)}.evil.${'b'.repeat(30)}.example`
    const b = `${'a'.repeat(30)}.good.${'b'.repeat(30)}.example`
    expect(promptText(a)).toContain(a)
    expect(promptText(a) === promptText(b)).toBe(false)
    expect(displayHost(a)).toBe(displayHost(b))
    expect(failedText('relay.example')).toBe('Could not connect through relay.example')
  })
})

describe('relay prefs', () => {
  test('stored per account, versioned and read defensively', () => {
    const p = prefs({
      relays: [{ url: url(T, 'mine.example:3478'), username: 'u', credential: 'c' }],
      allowed: ['other.example'],
      ask: false,
      choice: url(T, 'mine.example:3478'),
    })
    expect(parseRelayPrefs(relayPrefsValue(p))).toEqual(p)
    for (const raw of [null, '', '{', '[]', '{"v":2}', 'null'])
      expect(parseRelayPrefs(raw)).toEqual(defaultRelays())
    expect(
      parseRelayPrefs(
        JSON.stringify({
          v: 1,
          relays: [
            { url: url(T, 'Mine.example') },
            { url: url(T, 'mine.example') },
            { url: 'nope' },
            { url: url(S, 'stun.example'), username: 5 },
            'junk',
          ],
          allowed: ['ok.example', 'bad host', 'OK.example'],
          ask: 'yes',
          choice: url(S, 'stun.example'),
        })
      )
    ).toEqual({
      relays: [{ url: url(T, 'mine.example') }, { url: url(S, 'stun.example') }],
      allowed: ['ok.example'],
      ask: true,
      choice: AUTO,
    })
  })
})

describe('ICE config per P2P action', () => {
  const mine = { url: url(T, 'mine.example:3478'), username: 'u', credential: 'c' }
  const stun = { url: url(S, 'mystun.example') }

  test('auto merges the instance servers and ours, and declares our TURN hosts only', () => {
    const r = resolveIce(AUTO, prefs({ relays: [mine, stun] }), inputs())
    expect(r.ok && r.config.iceServers?.length).toBe(4)
    expect(r.ok && r.config.iceServers?.slice(2)).toEqual([
      { urls: mine.url, username: 'u', credential: 'c' },
      { urls: stun.url },
    ])
    expect(r.ok && r.config.iceTransportPolicy).toBeUndefined()
    expect(r.ok && r.declared).toEqual(['mine.example'])
    expect(r.ok && r.manual).toBeNull()
    expect(hidesIp(r)).toBe(false)
  })

  test('auto connects through exactly the TURN relays of ours it declares', () => {
    const own = Array.from({ length: 6 }, (_, i) => ({ url: url(T, `r${i}.example:3478`) }))
    const same = { url: url(T, 'inst.example:9999') }
    const r = resolveIce(AUTO, prefs({ relays: [...own, same, stun] }), inputs())
    if (!r.ok) throw new Error('not ok')
    expect(r.declared).toEqual(['r0.example', 'r1.example', 'r2.example', 'r3.example'])
    const instance = new Set(['inst.example'])
    const turnHosts = (r.config.iceServers ?? [])
      .flatMap(s => (Array.isArray(s.urls) ? s.urls : [s.urls]))
      .filter(u => /^turns?:/.test(u))
      .map(u => /^turns?:([^:?]+)/.exec(u)?.[1] ?? '')
    expect(turnHosts.filter(h => !instance.has(h)).sort()).toEqual([...r.declared].sort())
    expect(turnHosts.filter(h => instance.has(h)).length).toBe(2)
    expect(r.config.iceServers?.some(s => s.urls === stun.url)).toBe(true)
    const only = resolveIce(
      AUTO,
      prefs({ relays: own }),
      inputs({ relayOnly: true, instanceTurn: false, instance: [] })
    )
    expect(only.ok && only.config.iceServers?.length).toBe(4)
    expect(only.ok && only.config.iceTransportPolicy).toBe('relay')
  })

  test("auto never declares the instance's own relay, and helpers off means no servers", () => {
    const same = { url: url(T, 'inst.example:9999') }
    const r = resolveIce(AUTO, prefs({ relays: [same] }), inputs())
    expect(r.ok && r.declared).toEqual([])
    const off = resolveIce(AUTO, prefs({ relays: [mine] }), inputs({ helpers: false }))
    expect(off).toEqual({ ok: true, config: { iceServers: [] }, declared: [], manual: null })
  })

  test('relay only applies to the merged list, with our TURN relay even without the instance one', () => {
    const r = resolveIce(AUTO, prefs({ relays: [mine] }), inputs({ relayOnly: true }))
    expect(r.ok && r.config.iceTransportPolicy).toBe('relay')
    const ours = resolveIce(
      AUTO,
      prefs({ relays: [mine] }),
      inputs({ relayOnly: true, instanceTurn: false, instance: [] })
    )
    expect(ours.ok && ours.config.iceTransportPolicy).toBe('relay')
    const none = resolveIce(
      AUTO,
      prefs({ relays: [stun] }),
      inputs({ relayOnly: true, instanceTurn: false, instance: [] })
    )
    expect(none.ok && none.config.iceTransportPolicy).toBeUndefined()
    const forced = resolveIce(AUTO, prefs(), inputs({ forced: 'relay' }))
    expect(forced.ok && forced.config.iceTransportPolicy).toBe('relay')
  })

  test('manual uses that relay alone with relayed candidates only', () => {
    const r = resolveIce(mine.url, prefs({ relays: [mine, stun] }), inputs())
    expect(r).toEqual({
      ok: true,
      config: {
        iceServers: [{ urls: mine.url, username: 'u', credential: 'c' }],
        iceTransportPolicy: 'relay',
      },
      declared: ['mine.example'],
      manual: 'mine.example',
    })
    expect(hidesIp(r)).toBe(true)
    expect(resolveIce(url(T, 'gone.example'), prefs({ relays: [mine] }), inputs())).toEqual({
      ok: false,
      error: GONE,
    })
    expect(resolveIce(stun.url, prefs({ relays: [stun] }), inputs()).ok).toBe(false)
    const helpersOff = resolveIce(mine.url, prefs({ relays: [mine] }), inputs({ helpers: false }))
    expect(helpersOff.ok && helpersOff.manual).toBe('mine.example')
  })
})

describe('consent to relays of others', () => {
  const book = (answers: Decision[], over: Partial<RelayPrefs> = {}) => {
    const b = new RelayBook(() => inputs())
    b.prefs = prefs(over)
    const asked: string[] = []
    b.prompt = async host => {
      asked.push(host)
      return answers.shift() ?? 'deny'
    }
    return { b, asked }
  }

  test("only hosts that aren't the instance's, ours or allowed are unknown", () => {
    const p = prefs({ relays: [{ url: url(T, 'mine.example') }], allowed: ['ok.example'] })
    const known = knownHosts(inputs().instance, p)
    expect(
      unknownHosts(['inst.example', 'mine.example', 'New.example', 'new.example'], known)
    ).toEqual(['new.example'])
    expect(unknownHosts(undefined, known)).toEqual([])
    // A list that can't be read is one unknown relay, never skipped.
    for (const bad of [
      'junk',
      ['ok.example', 'bad host'],
      ['1.2.3'],
      ['999.1.1.1'],
      [7],
      Array.from({ length: DECLARED_MAX + 1 }, (_, i) => `r${i}.example`),
    ]) {
      expect(declaredHosts(bad)).toBeNull()
      expect(unknownHosts(bad, known)).toEqual([UNREADABLE])
    }
    expect(allowHost(p, 'ok.example')).toBe(p)
    expect(allowHost(p, 'x.example').allowed).toEqual(['ok.example', 'x.example'])
  })

  test('Allow once lets this one through and asks again next time', async () => {
    const { b, asked } = book(['once', 'deny'])
    let t = 1_000_000
    b.now = () => t
    expect(await b.consent(['new.example'])).toBeNull()
    expect(b.prefs.allowed).toEqual([])
    // What happens with it right away (the call after the offer) needs no second answer.
    expect(await b.consent(['new.example'])).toBeNull()
    t += PROMPTS.recentMs
    expect(await b.consent(['new.example'])).toBe('new.example')
    expect(asked).toEqual(['new.example', 'new.example'])
  })

  test('Always allow adds the host to the allow-list, which is never asked about', async () => {
    const { b, asked } = book(['always'])
    expect(await b.consent(['new.example', 'inst.example'])).toBeNull()
    expect(b.prefs.allowed).toEqual(['new.example'])
    expect(await b.consent(['new.example'])).toBeNull()
    expect(asked).toEqual(['new.example'])
  })

  test('a declared list with an invalid host is refused without asking', async () => {
    const { b, asked } = book(['always'])
    expect(await b.consent(['new.example', '1.2.3'])).toBe(UNREADABLE)
    expect(await b.consent('x')).toBe(UNREADABLE)
    expect(asked).toEqual([])
  })

  test('Deny stops at the first denied host', async () => {
    const { b, asked } = book(['deny', 'once'])
    expect(await b.consent(['a.example', 'b.example'])).toBe('a.example')
    expect(asked).toEqual(['a.example'])
  })

  test('with asking off nothing is asked; without a prompt everything unknown is refused', async () => {
    const { b, asked } = book([], { ask: false })
    expect(await b.consent(['new.example'])).toBeNull()
    expect(asked).toEqual([])
    const bare = new RelayBook(() => inputs())
    expect(await bare.consent(['new.example'])).toBe('new.example')
    expect(await bare.consent([])).toBeNull()
  })

  test('prompts come one at a time, and an Always answer covers a waiting request', async () => {
    const b = new RelayBook(() => inputs())
    const pending: ((d: Decision) => void)[] = []
    b.prompt = () => new Promise(resolve => pending.push(resolve))
    const first = b.consent(['new.example'])
    const second = b.consent(['new.example'])
    await Promise.resolve()
    expect(pending.length).toBe(1)
    pending[0]('always')
    expect(await first).toBeNull()
    expect(await second).toBeNull()
    expect(pending.length).toBe(1)
  })

  test("a peer's prompts: a Deny is kept for that list, a few per peer and in all", async () => {
    const { b, asked } = book([])
    let t = 1_000_000
    b.now = () => t
    // Denied once, the same peer and list is refused without asking, also later.
    expect(await b.consent(['a.example'], 'mallory')).toBe('a.example')
    t += PROMPTS.recentMs
    expect(await b.consent(['a.example'], 'mallory')).toBe('a.example')
    expect(asked).toEqual(['a.example'])
    // Fresh hosts: a few prompts per peer, then refused silently until the window passes.
    for (let i = 0; i < 20; i++)
      expect(await b.consent([`h${i}.example`], 'mallory')).not.toBeNull()
    expect(asked.length).toBe(PROMPTS.perPeer)
    // Others still get theirs, up to the cap for all peers together.
    for (let i = 0; i < 30; i++) await b.consent([`o${i}.example`], `peer${i}`)
    expect(asked.length).toBe(PROMPTS.all)
    // The user's own actions are always asked.
    expect(await b.consent(['mine.example'])).toBe('mine.example')
    expect(asked.length).toBe(PROMPTS.all + 1)
    t += PROMPTS.windowMs
    await b.consent(['later.example'], 'mallory')
    expect(asked.at(-1)).toBe('later.example')
  })

  test('the same peer asking about the same list again while asked waits for the one answer', async () => {
    const b = new RelayBook(() => inputs())
    const pending: ((d: Decision) => void)[] = []
    b.prompt = () => new Promise(resolve => pending.push(resolve))
    const asks = [1, 2, 3].map(() => b.consent(['new.example'], 'bob'))
    const other = b.consent(['new.example'], 'carol')
    await Promise.resolve()
    expect(pending.length).toBe(1)
    pending[0]('once')
    expect(await Promise.all([...asks, other])).toEqual([null, null, null, null])
    expect(pending.length).toBe(1)
  })

  test('a manual relay is checked before use, with a clear error', async () => {
    const mine = { url: url(T, 'mine.example:3478') }
    const b = new RelayBook(() => inputs())
    b.prefs = prefs({ relays: [mine] })
    let probed = 0
    b.probe = async () => {
      probed += 1
      return false
    }
    expect(await b.check(mine.url).catch((e: Error) => e.message)).toBe(
      'Could not connect through mine.example'
    )
    expect(await b.check(url(T, 'gone.example')).catch((e: Error) => e.message)).toBe(GONE)
    b.probe = async () => {
      probed += 1
      return true
    }
    expect((await b.check(mine.url)).manual).toBe('mine.example')
    expect((await b.check(AUTO)).manual).toBeNull()
    expect(probed).toBe(2)
  })
})

describe('relays in the config export', () => {
  const secret = 'hunter2-relay-secret'
  const p = prefs({
    relays: [
      { url: url(T, 'mine.example:3478'), username: 'relay-user', credential: secret },
      { url: url(S, 'mystun.example') },
    ],
    allowed: ['other.example'],
    choice: url(T, 'mine.example:3478'),
  })

  test('carries relay URLs and the allow-list, never credentials', async () => {
    expect(exportRelays(p)).toEqual({
      servers: [url(T, 'mine.example:3478'), url(S, 'mystun.example')],
      allowed: ['other.example'],
      ask: true,
    })
    const src = {
      theme: 'dark' as const,
      streamer: false,
      appearOffline: null,
      layout: null,
      notify: null,
      emoji: null,
      calls: null,
      typing: null,
      profanity: null,
      spoilers: null,
      relays: p,
    }
    const doc = buildConfig(src, new Set(SECTIONS.map(s => s.key)))
    const text = JSON.stringify(doc)
    expect(text.includes(secret)).toBe(false)
    expect(text.includes('relay-user')).toBe(false)
    expect(doc.relays?.servers.length).toBe(2)
    expect(linkDoc(doc).relays).toBeUndefined()
    const back = await decodeConfig(await encodeConfig(doc))
    expect(back.ok && back.doc.relays).toEqual(exportRelays(p))
  })

  test('imported sections are cleaned, and merging adds relays without credentials', () => {
    expect(cleanRelaysSection('x')).toBeUndefined()
    expect(
      cleanRelaysSection({
        servers: [url(T, 'A.example'), 'bad', url(T, 'a.example')],
        allowed: ['x.example', '<b>'],
        ask: false,
        credential: secret,
      })
    ).toEqual({ servers: [url(T, 'a.example')], allowed: ['x.example'], ask: false })
    const merged = mergeRelays(p, {
      servers: [url(T, 'mine.example:3478'), url(T, 'new.example')],
      allowed: ['other.example', 'x.example'],
      ask: false,
    })
    expect(merged.relays).toEqual([...p.relays, { url: url(T, 'new.example') }])
    expect(merged.allowed).toEqual(['other.example', 'x.example'])
    // An import can turn asking on but never off, and its summary names every host.
    expect(merged.ask).toBe(true)
    expect(mergeRelays({ ...p, ask: false }, { servers: [], allowed: [], ask: true }).ask).toBe(
      true
    )
    expect(
      relaysText({
        servers: [url(S, 'spy.example'), url(T, 'r.example')],
        allowed: ['x.example'],
        ask: false,
      })
    ).toBe('2 relays (spy.example, r.example), 1 allowed host (x.example)')
  })
})
