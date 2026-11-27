import { describe, expect, test } from 'bun:test'
import { everyoneSees, EVERYONE, P, type ChanFacts } from '../p2p/acl/rules'
import { b64u } from '../p2p/canonical'
import {
  checkContent,
  fitForward,
  LIMITS,
  readFwdSrc,
  sizeOf,
  type MsgContent,
} from '../p2p/content'

const EV = b64u(new Uint8Array(32).fill(7))
const NOTHING = { ev: null, dm: false, rn: null, cn: null, ts: 0, body: '', atts: [] }
const COPY = { name: 'Zed', ts: 1, body: 'q' }
const SAID = { ts: 1, body: 'q' }

describe('where a forwarded P2P copy is from', () => {
  test('reads the original’s event id, what the copy says of it, and the place shown', () => {
    expect(readFwdSrc({ ...COPY, ev: EV, src: { rn: 'Garden', cn: 'beds' } })).toEqual({
      ...NOTHING,
      ...SAID,
      ev: EV,
      rn: 'Garden',
      cn: 'beds',
    })
    expect(readFwdSrc({ ev: EV, src: { dm: true } })).toEqual({ ...NOTHING, ev: EV, dm: true })
    expect(readFwdSrc({ src: { rn: 'Pub Hall', cn: 'bar' } })).toEqual({
      ...NOTHING,
      rn: 'Pub Hall',
      cn: 'bar',
    })
  })

  test('each malformed part reads as nothing, the rest stays', () => {
    expect(readFwdSrc(undefined)).toEqual(NOTHING)
    expect(readFwdSrc('fwd')).toEqual(NOTHING)
    expect(readFwdSrc(COPY)).toEqual({ ...NOTHING, ...SAID })
    const file = { h: EV, size: 1, blocks: 1, name: 'beds.png', mime: 'image/png' }
    expect(readFwdSrc({ ...COPY, att: [file] }).atts).toEqual([file])
    expect(readFwdSrc({ ...COPY, att: [file, { h: 'a' }] }).atts).toBeNull()
    expect(readFwdSrc({ ...COPY, att: 'files' }).atts).toBeNull()
    expect(
      readFwdSrc({ ev: 'nope', ts: 1.5, name: 4, src: { rn: 'x'.repeat(65), cn: '  ', extra: 1 } })
    ).toEqual(NOTHING)
    expect(readFwdSrc({ ev: EV, src: [] })).toEqual({ ...NOTHING, ev: EV })
    expect(readFwdSrc({ src: { rn: 'Garden', cn: { x: 1 } } })).toEqual({
      ...NOTHING,
      rn: 'Garden',
    })
    expect(readFwdSrc({ src: { dm: true, rn: 'Garden' } })).toEqual({ ...NOTHING, dm: true })
    expect(readFwdSrc({ src: { dm: 'yes', rn: 'Garden' } })).toEqual({ ...NOTHING, rn: 'Garden' })
    expect(readFwdSrc({ src: { rn: 'é'.repeat(64) } }).rn).toBe('é'.repeat(64))
  })

  test('a message stays valid whatever its source says', () => {
    for (const fwd of [
      { ...COPY, ev: EV, src: { dm: true } },
      { ...COPY, ev: 5, src: 'there' },
      { ...COPY, src: { rn: 5, room: [], ch: null, dm: 'yes' } },
    ])
      expect(checkContent('msg', { body: '', fwd })).toBe(true)
  })

  test('a copy too big to send leaves out where it is from, then its original', () => {
    const src = { rn: 'g'.repeat(64), cn: 'c'.repeat(64) }
    const msg = (body: string, keep: ('ev' | 'src')[] = ['ev', 'src']): MsgContent => ({
      body: '',
      fwd: {
        name: 'Zed',
        ts: 1,
        body,
        ...(keep.includes('ev') ? { ev: EV } : {}),
        ...(keep.includes('src') ? { src } : {}),
      },
    })
    const size = (keep?: ('ev' | 'src')[]) => sizeOf(msg('', keep))
    const over = (keep?: ('ev' | 'src')[]) => 'x'.repeat(LIMITS.content - size(keep) + 1)
    expect(fitForward(msg('short'))).toEqual(msg('short'))
    expect(fitForward(msg(over()))).toEqual(msg(over(), ['ev']))
    expect(fitForward(msg(over(['ev'])))).toEqual(msg(over(['ev']), []))
    expect(sizeOf(fitForward(msg(over(['ev']))))).toBeLessThanOrEqual(LIMITS.content)
    const plain: MsgContent = { body: 'plain' }
    expect(fitForward(plain)).toEqual(plain)
  })
})

describe('everyoneSees', () => {
  const facts = (
    everyone: number,
    overwrites: Record<string, Record<string, { allow: number; deny: number }>> = {},
    channels: Record<string, { restrict_view?: true }> = {}
  ) =>
    ({
      owners: new Set(['O']),
      bits: {
        get: (R: string) => (R === EVERYONE ? everyone : R === 'verified' ? P.ViewChannel : 0),
      },
      holds: { get: (ik: string) => (ik === 'V' ? ['verified'] : undefined) },
      overwrites: new Map(
        Object.entries(overwrites).map(([ch, o]) => [ch, new Map(Object.entries(o))])
      ),
      channels: new Map(Object.entries({ c1: {}, ...channels })),
    }) as unknown as ChanFacts
  const BASE = P.ViewChannel | P.SendMessages

  test('a channel every member sees', () => {
    expect(everyoneSees(facts(BASE), 'c1')).toBe(true)
    expect(everyoneSees(facts(P.ManageChannels), 'c1')).toBe(true)
  })

  test('@everyone without View: only channels that let everyone in', () => {
    const lobby = { [`r:${EVERYONE}`]: { allow: P.ViewChannel, deny: 0 } }
    const F = facts(P.SendMessages, { lobby })
    expect(everyoneSees(F, 'c1')).toBe(false)
    expect(everyoneSees(F, 'lobby')).toBe(true)
  })

  test('restrict_view or any overwrite that denies View', () => {
    expect(everyoneSees(facts(BASE, {}, { c1: { restrict_view: true } }), 'c1')).toBe(false)
    expect(
      everyoneSees(facts(BASE, { c1: { 'r:newbies': { allow: 0, deny: P.ViewChannel } } }), 'c1')
    ).toBe(false)
    expect(
      everyoneSees(facts(BASE, { c1: { 'u:Z': { allow: 0, deny: P.ViewChannel } } }), 'c1')
    ).toBe(false)
    expect(
      everyoneSees(facts(BASE, { c1: { 'r:mods': { allow: P.ManageMessages, deny: 0 } } }), 'c1')
    ).toBe(true)
    expect(
      everyoneSees(facts(BASE, { c1: { 'r:quiet': { allow: 0, deny: P.SendMessages } } }), 'c1')
    ).toBe(true)
  })
})
