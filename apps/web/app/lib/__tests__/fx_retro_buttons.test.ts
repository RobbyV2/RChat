import { describe, expect, test } from 'bun:test'
import {
  SECURITY_EMBLEMS,
  SECURITY_WORDS,
  VGA,
  retroButtonLabel,
  profileRetroButtons,
  serverRetroButtons,
  type RetroButton,
} from '../fx/retro_buttons'
import { contrast } from '../fx/vintage_tokens'

const day = 86_400
const created = Date.UTC(2024, 10, 9) / 1000
const at = (y: number, m: number, d: number, h = 12) => Date.UTC(y, m - 1, d, h) / 1000

const every = (): RetroButton[] => [
  ...profileRetroButtons({
    createdAt: created,
    now: at(2026, 11, 9),
    member: { joinedAt: created + day },
    friend: true,
    contact: true,
  }),
  ...serverRetroButtons({ createdAt: created, now: at(2026, 11, 9), members: 12_345 }),
]

describe('derived web buttons', () => {
  test('profile: since, the anniversary cake, membership', () => {
    const ids = profileRetroButtons({
      createdAt: created,
      now: at(2026, 11, 9),
      member: { joinedAt: created + day },
    }).map(b => b.id)
    expect(ids).toEqual(['since', 'cake', 'member'])
    expect(
      profileRetroButtons({ createdAt: created, now: at(2026, 11, 10) }).map(b => b.id)
    ).toEqual(['since'])
    expect(profileRetroButtons({ createdAt: created, now: created + 3600 }).map(b => b.id)).toEqual(
      ['since']
    )
    expect(profileRetroButtons({ createdAt: created, now: at(2025, 11, 9) })[1].line1).toBe(
      '1 YEAR'
    )
  })
  test('29 February anniversaries show on 28 February in other years', () => {
    const leap = Date.UTC(2024, 1, 29, 12) / 1000
    expect(profileRetroButtons({ createdAt: leap, now: at(2025, 2, 28) }).map(b => b.id)).toContain(
      'cake'
    )
    expect(profileRetroButtons({ createdAt: leap, now: at(2028, 2, 29) }).map(b => b.id)).toContain(
      'cake'
    )
    expect(
      profileRetroButtons({ createdAt: leap, now: at(2028, 2, 28) }).map(b => b.id)
    ).not.toContain('cake')
  })
  test("dates follow the viewer's local calendar", () => {
    const lateUtc = Date.UTC(2024, 10, 9, 23) / 1000
    expect(
      profileRetroButtons({ createdAt: lateUtc, now: at(2026, 11, 10, 2) }, 180).map(b => b.id)
    ).toContain('cake')
  })
  test('server buttons', () => {
    const b = serverRetroButtons({ createdAt: created, now: at(2026, 6, 1), members: 12_345 })
    expect(b.map(x => x.id)).toEqual(['est', 'members', 'any'])
    expect(b[1].line1).toBe('12K')
    expect(
      serverRetroButtons({ createdAt: created, now: at(2026, 6, 1), members: 1 })[1].line2
    ).toBe('MEMBER')
  })
  test('the site admin flag changes nothing', () => {
    const plain = profileRetroButtons({ createdAt: created, now: at(2026, 11, 9) })
    const admin = profileRetroButtons({
      createdAt: created,
      now: at(2026, 11, 9),
      is_site_admin: true,
    } as never)
    expect(admin).toEqual(plain)
  })
})

describe('never like a security marker', () => {
  test('no security or identity word, no security emblem', () => {
    for (const b of every()) {
      const text = `${b.line1} ${b.line2 ?? ''}`.toLowerCase()
      for (const w of SECURITY_WORDS)
        expect([b.id, w, new RegExp(`\\b${w}`).test(text)]).toEqual([b.id, w, false])
      expect([b.id, SECURITY_EMBLEMS.includes(b.emblem ?? '')]).toEqual([b.id, false])
    }
  })
  test('only fixed words and numbers: no user text to mask or reveal', () => {
    for (const b of every())
      for (const line of [b.line1, b.line2].filter(Boolean))
        expect([b.id, /^[A-Z0-9 .,]+$/.test(line!)]).toEqual([b.id, true])
  })
})

describe('readable', () => {
  test('every button meets 4.5:1', () => {
    for (const b of every())
      expect([b.id, contrast(VGA[b.fg], VGA[b.bg]) >= 4.5]).toEqual([b.id, true])
  })
  test('labels read as words', () => {
    const est = serverRetroButtons({ createdAt: created, now: at(2026, 6, 1), members: 3 })[0]
    expect(retroButtonLabel(est)).toBe('Established 2024')
    expect(retroButtonLabel({ line1: 'SINCE', line2: '2024' })).toBe('Since 2024')
  })
})
