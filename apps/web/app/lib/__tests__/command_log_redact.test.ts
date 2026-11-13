import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { hiddenValues, type LogStep } from '../command_log/policy'
import {
  HIDDEN,
  MAX_CHARS,
  scrub,
  scrubEntry,
  stripSpans,
  stripValues,
} from '../command_log/redact'
import type { LogEntry } from '../command_log/types'

type Case =
  | { text: string; out: string; spans?: undefined; echo?: undefined }
  | { spans: true; text: string; out: string; echo?: undefined }
  | { echo: string; out: string; text?: undefined; spans?: undefined }

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../crates/automation/vectors/redact.json', import.meta.url)),
    'utf8'
  )
) as { v: number; cases: Case[] }

const phrase =
  'abandon ability able about above absent absorb abstract absurd abuse access accident'

describe('the shared vectors', () => {
  test('there are 33 of them', () => {
    expect(vectors.v).toBe(1)
    expect(vectors.cases.length).toBe(33)
    expect(vectors.cases.filter(c => c.echo !== undefined).length).toBe(1)
    expect(vectors.cases.filter(c => c.spans).length).toBe(1)
  })

  for (const c of vectors.cases.filter(c => c.text !== undefined && !c.spans))
    test(`scrub ${JSON.stringify(c.text).slice(0, 60)}`, () => {
      expect(scrub(c.text ?? '')).toBe(c.out)
    })

  test('the echoed hidden argument', () => {
    const c = vectors.cases.find(c => c.echo !== undefined)
    const steps: LogStep[] = [{ name: 'code', kind: 'text' }]
    const values = hiddenValues(steps, { code: 'X7Q-993-ALPHA' }, false, true)
    expect(stripValues(c?.echo ?? '', values)).toBe(c?.out ?? '')
  })

  test('the span case', () => {
    const c = vectors.cases.find(c => c.spans)
    const spans = [{ start: 12, end: 21, arg: 'args.code' }]
    expect(stripSpans(c?.text ?? '', spans, new Set(['args.code']))).toBe(c?.out ?? '')
  })
})

describe('scrub', () => {
  test('webhook URLs lose their token', () => {
    expect(scrub('Copied https://chat.example.com/api/v1/webhooks/12/abcDEF123secret')).toBe(
      `Copied https://chat.example.com/api/v1/webhooks/12/${HIDDEN}`
    )
  })

  test('secret query values and fragments', () => {
    expect(scrub('GET /api/v1/x?token=abc&limit=50')).toBe(`GET /api/v1/x?token=${HIDDEN}&limit=50`)
    expect(scrub('https://a.b/join?invite_code=xyz#k=1')).toBe(
      `https://a.b/join?invite_code=${HIDDEN}#${HIDDEN}`
    )
    expect(scrub('https://a.b/c?page=2')).toBe('https://a.b/c?page=2')
  })

  test('backup phrases: QR payloads, full and abbreviated word runs, numbered lists', () => {
    expect(scrub(`rchat-backup:1:${phrase}`)).toBe(HIDDEN)
    expect(scrub(`phrase: ${phrase}`)).toBe(`phrase: ${HIDDEN}`)
    expect(scrub('aban abil able abou abov abse')).toBe(HIDDEN)
    expect(scrub('1. abandon 2. ability 3. able 4. about 5. above 6. absent')).toBe(`1. ${HIDDEN}`)
    expect(scrub('Time out carol for 1 hour')).toBe('Time out carol for 1 hour')
    expect(scrub('abandon ability able about above')).toBe('abandon ability able about above')
  })

  test('bearer tokens and long random runs', () => {
    expect(scrub('Authorization: Bearer abc.def')).toBe(`Authorization: ${HIDDEN}`)
    expect(scrub('Bearer 0123')).toBe(`Bearer ${HIDDEN}`)
    expect(scrub('key 9f8e7d6c5b4a39281706f5e4d3c2b1a0')).toBe(`key ${HIDDEN}`)
    expect(scrub('internationalization_and_localization_rules')).toBe(HIDDEN)
    expect(scrub('Open #general-announcements-archive')).toBe('Open #general-announcements-archive')
  })

  test('long strings are cut', () => {
    const out = scrub('a '.repeat(150))
    expect(Array.from(out).length).toBe(MAX_CHARS)
    expect(out.endsWith('…')).toBe(true)
    expect(scrub('a'.repeat(23))).toBe('a'.repeat(23))
  })

  test('phrase words joined by - / . _', () => {
    expect(scrub('abandon-ability-able-about-above-absent')).toBe(HIDDEN)
    expect(scrub('abandon/ability/able/about/above/absent')).toBe(HIDDEN)
    expect(scrub('abandon.ability.able about_above absent')).toBe(HIDDEN)
    expect(scrub('well-known re-run')).toBe('well-known re-run')
  })

  test('URL userinfo and the extra secret keys', () => {
    expect(scrub('https://user:hunter2@a.b/x')).toBe(`https://${HIDDEN}@a.b/x`)
    for (const k of ['otp', 'auth', 'session', 'sid', 'jwt', 'state', 'nonce'])
      expect(scrub(`/api/v1/x?${k}=abc123&page=2`)).toBe(`/api/v1/x?${k}=${HIDDEN}&page=2`)
  })

  test('userinfo ends at the last @ before the path, as browsers read it', () => {
    expect(scrub('https://u:hun@ter2@a.b/x')).toBe(`https://${HIDDEN}@a.b/x`)
    expect(scrub('see <rchat://u:p@q@r@a.b/x?token=1>')).toBe(
      `see <rchat://${HIDDEN}@a.b/x?token=${HIDDEN}>`
    )
    expect(scrub('https://a.b/x@y?q=a@b')).toBe('https://a.b/x@y?q=a@b')
    expect(scrub('https://u:p@a.b#x@y')).toBe(`https://${HIDDEN}@a.b#${HIDDEN}`)
  })

  test('a URL inside a word loses its userinfo, secret values and fragment', () => {
    expect(scrub('see <https://user:hunter2@a.b/x>')).toBe(`see <https://${HIDDEN}@a.b/x>`)
    expect(scrub('(https://user:hunter2@a.b/x)')).toBe(`(https://${HIDDEN}@a.b/x)`)
    expect(scrub('url=https://a.b/x?token=abc#frag')).toBe(
      `url=https://a.b/x?token=${HIDDEN}#${HIDDEN}`
    )
    expect(scrub('join:rchat://chat.example/invite/club/#password=hunter2')).toBe(
      `join:rchat://chat.example/invite/club/#${HIDDEN}`
    )
    expect(scrub('"HTTPS://u@a.b/#k","https://c.d/?sid=1"')).toBe(
      `"HTTPS://${HIDDEN}@a.b/#${HIDDEN}","https://c.d/?sid=${HIDDEN}"`
    )
    expect(scrub('see:https://a.b/c?page=2')).toBe('see:https://a.b/c?page=2')
    expect(scrub('key 9f8e7d6c5b4a39281706f5e4d3c2b1a0,https://a.b/x#k')).toBe(
      `key ${HIDDEN},https://a.b/x#${HIDDEN}`
    )
  })

  test('padded and slashed base64', () => {
    expect(scrub('dG9rZW4gaGVyZQ==')).toBe(HIDDEN)
    expect(scrub('key ab12/CD34+ef56/gh78ij90kl')).toBe(`key ${HIDDEN}`)
    expect(scrub('/api/v1/servers/pixel/automations/123/runs')).toBe(
      '/api/v1/servers/pixel/automations/123/runs'
    )
    expect(scrub('https://chat.example.com/api/v1/servers/pixel/automations/123/runs')).toBe(
      'https://chat.example.com/api/v1/servers/pixel/automations/123/runs'
    )
  })

  test('scrubbing twice changes nothing more', () => {
    for (const c of vectors.cases) expect(scrub(c.out)).toBe(c.out)
  })

  test('the word test can be swapped', () => {
    expect(scrub('one two three four five six', () => 'x')).toBe(HIDDEN)
    expect(scrub(phrase, () => null)).toBe(phrase)
  })
})

describe('echo removal', () => {
  test('a reply that echoes a hidden argument is stored without it', () => {
    const steps: LogStep[] = [{ name: 'code', kind: 'text' }]
    const values = hiddenValues(steps, { code: 'X7Q-993-ALPHA' }, false, true)
    expect(stripValues('Linked with code X7Q-993-ALPHA. Done.', values)).toBe(
      `Linked with code ${HIDDEN}. Done.`
    )
    expect(hiddenValues(steps, { code: 'ok' }, false, true)).toEqual([])
  })

  test('the longest value goes first, and an empty one is skipped', () => {
    expect(stripValues('abcd abcdef', ['abcd', 'abcdef', ''])).toBe(`${HIDDEN} ${HIDDEN}`)
  })

  test('a hidden argument echoed after the word joiners and the cut is hidden', () => {
    const text = 'Linked with @⁠X7Q-993. Done.'
    const spans = [{ start: 12, end: 21, arg: 'args.code' }]
    expect(text.slice(12, 21)).toBe('@⁠X7Q-993')
    expect(stripSpans(text, spans, new Set(['args.code']))).toBe(`Linked with ${HIDDEN}. Done.`)
    expect(stripSpans(text, spans, new Set())).toBe(text)
  })

  test('several spans, in any order, and only the hidden ones', () => {
    const text = 'a=AAAA b=BBBB c=CCCC'
    const spans = [
      { start: 16, end: 20, arg: 'c' },
      { start: 2, end: 6, arg: 'a' },
      { start: 9, end: 13, arg: 'b' },
    ]
    expect(stripSpans(text, spans, new Set(['a', 'c']))).toBe(`a=${HIDDEN} b=BBBB c=${HIDDEN}`)
  })

  test('spans the text does not have never throw and never leave a marked part', () => {
    const text = 'code SECRET here'
    const hidden = new Set(['x'])
    expect(stripSpans(text, [{ start: 5, end: 99, arg: 'x' }], hidden)).toBe(`code ${HIDDEN}`)
    expect(stripSpans(text, [{ start: 50, end: 60, arg: 'x' }], hidden)).toBe(text)
    expect(stripSpans(text, [{ start: 8, end: 5, arg: 'x' }], hidden)).toBe(text)
    expect(stripSpans(text, [{ start: -1, end: 5, arg: 'x' }], hidden)).toBe(text)
    expect(stripSpans(text, [{ start: 0.5, end: 5, arg: 'x' }], hidden)).toBe(text)
    expect(
      stripSpans(
        text,
        [
          { start: 5, end: 9, arg: 'x' },
          { start: 7, end: 11, arg: 'x' },
        ],
        hidden
      )
    ).toBe(`code ${HIDDEN}${HIDDEN} here`)
  })
})

describe('a whole entry', () => {
  test('every string of it is scrubbed, and the rest is kept', () => {
    const entry: LogEntry = {
      v: 1,
      id: 'e1',
      at: 5,
      actor: { account: 'alice@a.example', identity: 'p1' },
      via: 'palette',
      action: 'core.webhook.copy',
      title: 'Copied https://a.example/api/v1/webhooks/3/tok',
      target: { kind: 'channel', label: `Room7 ${phrase}`, ref: { server: 'pixel', channel: 4 } },
      args: [{ name: 'note', value: 'Bearer abc' }],
      outcome: 'ok',
      text: 'see https://u:p@a.example/x',
      ms: 12,
      undo: 'available',
    }
    expect(scrubEntry(entry)).toEqual({
      ...entry,
      title: `Copied https://a.example/api/v1/webhooks/3/${HIDDEN}`,
      target: { kind: 'channel', label: `Room7 ${HIDDEN}`, ref: { server: 'pixel', channel: 4 } },
      args: [{ name: 'note', value: `Bearer ${HIDDEN}` }],
      text: `see https://${HIDDEN}@a.example/x`,
    })
    const bare: LogEntry = {
      v: 1,
      id: 'e2',
      at: 6,
      actor: { account: 'a' },
      via: 'key',
      action: 'core.x',
      title: 'Plain',
      outcome: 'ok',
    }
    expect(scrubEntry(bare)).toEqual(bare)
    expect(Object.keys(scrubEntry(bare)).sort()).toEqual(Object.keys(bare).sort())
  })
})
