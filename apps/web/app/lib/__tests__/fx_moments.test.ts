import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { dayNum } from '../fx/astro'
import {
  CAUGHT_UP_GLYPHS,
  FX_SENT_KEY,
  FX_STREAKS_KEY,
  MILESTONES,
  SEASON_LINES,
  STREAK_DMS_MAX,
  caughtUpGlyph,
  countSent,
  createOnce,
  dayOf,
  emptyAccent,
  greeting,
  isBirthday,
  isNightOwl,
  milestoneLine,
  newYearCountdown,
  noteDm,
  parseSent,
  parseStreaks,
  rainTitle,
  sentValue,
  streakDays,
  streakLabel,
  streakShown,
  streaksValue,
  yearsToday,
  type Streaks,
} from '../fx/moments'
import { profileRetroButtons } from '../fx/retro_buttons'
import { SEASONS, SEASON_IDS, activeSeasons } from '../fx/seasons'

const zone = Intl.DateTimeFormat().resolvedOptions().timeZone
beforeEach(() => {
  process.env.TZ = 'UTC'
})
afterEach(() => {
  process.env.TZ = zone
})

const secs = (y: number, m: number, d: number, h = 12) => new Date(y, m - 1, d, h).getTime() / 1000

describe('the sent tally and milestones', () => {
  test('keys', () => {
    expect(FX_SENT_KEY).toBe('fx_sent')
    expect(FX_STREAKS_KEY).toBe('fx_streaks')
  })

  test('nothing saved or junk starts at zero', () => {
    for (const raw of [
      null,
      '',
      'x',
      '7',
      '[]',
      '{"v":2,"n":5}',
      '{"v":1,"n":-1}',
      '{"v":1,"n":1.5}',
    ])
      expect([raw, parseSent(raw)]).toEqual([raw, { v: 1, n: 0 }])
    expect(parseSent(sentValue({ v: 1, n: 99 }))).toEqual({ v: 1, n: 99 })
  })

  test('the 100th, 1,000th and 10,000th message are milestones, once each', () => {
    expect([...MILESTONES]).toEqual([100, 1_000, 10_000])
    let tally = parseSent(null)
    const hit: number[] = []
    for (let i = 0; i < 10_500; i++) {
      const next = countSent(tally)
      tally = next.tally
      if (next.milestone !== null) hit.push(next.milestone)
    }
    expect(tally.n).toBe(10_500)
    expect(hit).toEqual([100, 1_000, 10_000])
  })

  test('a tally read back after a reload does not repeat a milestone', () => {
    const { tally, milestone } = countSent({ v: 1, n: 99 })
    expect(milestone).toBe(100)
    expect(countSent(parseSent(sentValue(tally))).milestone).toBeNull()
  })

  test('the toast line', () => {
    expect(milestoneLine(100)).toBe('100 messages sent from this device.')
    expect(milestoneLine(1_000)).toBe('1,000 messages sent from this device.')
    expect(milestoneLine(10_000)).toBe('10,000 messages sent from this device.')
  })
})

describe('DM streaks', () => {
  const empty: Streaks = { v: 1, dms: {} }
  const both = (s: Streaks, dm: string, day: number) =>
    noteDm(noteDm(s, dm, 'me', day), dm, 'them', day)

  test('a day counts when both people sent a message; three in a row make a streak', () => {
    let s = empty
    s = both(s, 'a', 100)
    s = both(s, 'a', 101)
    expect(streakDays(s, 'a', 101)).toBe(0)
    s = noteDm(s, 'a', 'me', 102)
    expect(streakDays(s, 'a', 102)).toBe(0)
    s = noteDm(s, 'a', 'them', 102)
    expect(streakDays(s, 'a', 102)).toBe(3)
    s = both(s, 'a', 103)
    expect(streakDays(s, 'a', 103)).toBe(4)
  })

  test('the streak holds through the next day and ends after a missed one', () => {
    let s = empty
    for (const day of [100, 101, 102]) s = both(s, 'a', day)
    expect(streakDays(s, 'a', 103)).toBe(3)
    expect(streakDays(s, 'a', 104)).toBe(0)
    s = both(s, 'a', 104)
    expect(streakDays(s, 'a', 104)).toBe(0)
    s = both(s, 'a', 105)
    s = both(s, 'a', 106)
    expect(streakDays(s, 'a', 106)).toBe(3)
  })

  test('only one of the two sending does not count', () => {
    let s = empty
    for (const day of [100, 101, 102, 103]) s = noteDm(s, 'a', 'me', day)
    expect(streakDays(s, 'a', 103)).toBe(0)
    s = both(s, 'b', 100)
    s = noteDm(s, 'b', 'them', 101)
    s = both(s, 'b', 102)
    s = both(s, 'b', 103)
    expect(streakDays(s, 'b', 103)).toBe(0)
  })

  test('many messages in a day count once, and an older day changes nothing', () => {
    let s = empty
    for (const day of [100, 101, 102]) {
      s = both(s, 'a', day)
      s = both(s, 'a', day)
    }
    expect(streakDays(s, 'a', 102)).toBe(3)
    const before = s
    s = both(s, 'a', 99)
    expect(s).toBe(before)
  })

  test('nothing changes when a message adds nothing', () => {
    const s = noteDm(empty, 'a', 'me', 100)
    expect(noteDm(s, 'a', 'me', 100)).toBe(s)
    expect(empty).toEqual({ v: 1, dms: {} })
  })

  test('days are local days: a streak runs across a clock change', () => {
    process.env.TZ = 'America/Los_Angeles'
    let s = empty
    const days: number[] = []
    for (const d of [7, 8, 9]) {
      const mine = dayOf(new Date(2026, 2, d, 23, 30))
      const theirs = dayOf(new Date(2026, 2, d, 0, 30))
      expect(mine).toBe(theirs)
      days.push(mine)
      s = noteDm(noteDm(s, 'a', 'them', theirs), 'a', 'me', mine)
    }
    expect(days).toEqual([dayNum(2026, 3, 7), dayNum(2026, 3, 8), dayNum(2026, 3, 9)])
    expect(streakDays(s, 'a', days[2])).toBe(3)
    process.env.TZ = 'Pacific/Auckland'
    expect(dayOf(new Date(Date.UTC(2026, 2, 7, 11, 30)))).toBe(dayNum(2026, 3, 8))
    process.env.TZ = 'America/Los_Angeles'
    expect(dayOf(new Date(Date.UTC(2026, 2, 7, 11, 30)))).toBe(dayNum(2026, 3, 7))
  })

  test(`at most ${STREAK_DMS_MAX} DMs are kept: the one quiet the longest goes`, () => {
    expect(STREAK_DMS_MAX).toBe(500)
    let s = empty
    for (let i = 0; i < STREAK_DMS_MAX; i++) s = noteDm(s, `dm${i}`, 'me', 100 + i)
    s = noteDm(s, 'dm0', 'them', 700)
    s = noteDm(s, 'new', 'me', 701)
    expect(Object.keys(s.dms)).toHaveLength(STREAK_DMS_MAX)
    expect('dm1' in s.dms).toBe(false)
    expect('dm0' in s.dms).toBe(true)
    expect('new' in s.dms).toBe(true)
  })

  test('saved streaks read back; junk and bad entries are dropped', () => {
    let s = empty
    for (const day of [100, 101, 102]) s = both(s, 'a', day)
    expect(parseStreaks(streaksValue(s))).toEqual(s)
    for (const raw of [null, '', 'x', '[]', '{"v":2,"dms":{}}', '{"v":1,"dms":[]}'])
      expect([raw, parseStreaks(raw)]).toEqual([raw, empty])
    const mixed = JSON.stringify({
      v: 1,
      dms: {
        ok: { me: 5, them: 5, last: 5, run: 1 },
        text: { me: '5', them: 5, last: 5, run: 1 },
        short: { me: 5 },
        list: [5, 5, 5, 1],
        fraction: { me: 5.5, them: 5, last: 5, run: 1 },
        negative: { me: 5, them: 5, last: 5, run: -1 },
      },
    })
    expect(parseStreaks(mixed)).toEqual({ v: 1, dms: { ok: { me: 5, them: 5, last: 5, run: 1 } } })
    const many: Streaks = { v: 1, dms: {} }
    for (let i = 0; i < STREAK_DMS_MAX + 20; i++)
      many.dms[`dm${i}`] = { me: i, them: -1, last: -1, run: 0 }
    const kept = parseStreaks(JSON.stringify(many))
    expect(Object.keys(kept.dms)).toHaveLength(STREAK_DMS_MAX)
    expect('dm0' in kept.dms).toBe(false)
    expect(`dm${STREAK_DMS_MAX + 19}` in kept.dms).toBe(true)
  })

  test('the label, and nothing in streamer mode', () => {
    let s = empty
    for (const day of [100, 101, 102]) s = both(s, 'a', day)
    expect(streakLabel(3)).toBe('3-day streak')
    expect(streakShown(s, 'a', 102, false)).toBe(3)
    expect(streakShown(s, 'a', 102, true)).toBeNull()
    expect(streakShown(s, 'none', 102, false)).toBeNull()
  })
})

describe('anniversaries', () => {
  test('the month and day of the first day, a year or more later', () => {
    const made = secs(2024, 3, 9)
    expect(yearsToday(made, new Date(2026, 2, 9, 8))).toBe(2)
    expect(yearsToday(made, new Date(2025, 2, 9, 23, 59))).toBe(1)
    expect(yearsToday(made, new Date(2024, 2, 9, 18))).toBe(0)
    expect(yearsToday(made, new Date(2026, 2, 8))).toBe(0)
    expect(yearsToday(made, new Date(2026, 2, 10))).toBe(0)
    expect(yearsToday(made, new Date(2023, 2, 9))).toBe(0)
  })

  test('29 February counts on 28 February in other years', () => {
    const made = secs(2024, 2, 29)
    expect(yearsToday(made, new Date(2025, 1, 28))).toBe(1)
    expect(yearsToday(made, new Date(2025, 2, 1))).toBe(0)
    expect(yearsToday(made, new Date(2028, 1, 29))).toBe(4)
    expect(yearsToday(made, new Date(2028, 1, 28))).toBe(0)
  })

  test("the day is the viewer's local day", () => {
    const made = Date.UTC(2024, 2, 9, 23, 30) / 1000
    process.env.TZ = 'Pacific/Auckland'
    expect(yearsToday(made, new Date(Date.UTC(2026, 2, 9, 12)))).toBe(2)
    expect(yearsToday(made, new Date(Date.UTC(2026, 2, 8, 12)))).toBe(0)
    process.env.TZ = 'America/Los_Angeles'
    expect(yearsToday(made, new Date(Date.UTC(2026, 2, 9, 12)))).toBe(2)
    expect(yearsToday(made, new Date(Date.UTC(2026, 2, 10, 12)))).toBe(0)
  })

  test('agrees with the YEARS TODAY web button on every day of four years', () => {
    for (const made of [secs(2020, 2, 29), secs(2021, 12, 31), secs(2022, 1, 1), secs(2023, 6, 15)])
      for (let day = 0; day < 4 * 366; day++) {
        const now = new Date(Date.UTC(2024, 0, 1 + day, 12))
        const cake = profileRetroButtons({ createdAt: made, now: now.getTime() / 1000 }).find(
          b => b.id === 'cake'
        )
        const years = yearsToday(made, now)
        expect([
          made,
          day,
          years > 0 ? `${years} ${years === 1 ? 'YEAR' : 'YEARS'}` : null,
        ]).toEqual([made, day, cake?.line1 ?? null])
      }
  })
})

describe('my birthday', () => {
  test('is the saved month and day, on the local calendar', () => {
    expect(isBirthday('07-04', new Date(2026, 6, 4, 0, 0))).toBe(true)
    expect(isBirthday('07-04', new Date(2026, 6, 4, 23, 59))).toBe(true)
    expect(isBirthday('07-04', new Date(2026, 6, 5))).toBe(false)
    expect(isBirthday(null, new Date(2026, 6, 4))).toBe(false)
  })

  test('29 February falls on 28 February in other years', () => {
    expect(isBirthday('02-29', new Date(2028, 1, 29))).toBe(true)
    expect(isBirthday('02-29', new Date(2028, 1, 28))).toBe(false)
    expect(isBirthday('02-29', new Date(2027, 1, 28))).toBe(true)
    expect(isBirthday('02-28', new Date(2027, 1, 28))).toBe(true)
  })
})

describe('the Home greeting', () => {
  const base = {
    now: new Date(2026, 6, 4, 9),
    createdAt: secs(2024, 3, 9),
    birthday: null as string | null,
    streamer: false,
    momentsOn: true,
  }

  test('an ordinary day has none', () => {
    expect(greeting(base)).toBeNull()
    expect(greeting({ ...base, createdAt: null })).toBeNull()
  })

  test('a birthday greets with balloons', () => {
    expect(greeting({ ...base, birthday: '07-04' })).toEqual({
      kind: 'birthday',
      line: 'Happy birthday 🎈',
      effect: 'balloons',
    })
  })

  test('an anniversary names the years', () => {
    expect(greeting({ ...base, now: new Date(2026, 2, 9, 9) })).toEqual({
      kind: 'anniversary',
      line: 'Happy 2-year anniversary here 🎂',
      effect: 'balloons',
    })
    expect(greeting({ ...base, now: new Date(2025, 2, 9, 9) })?.line).toBe(
      'Happy 1-year anniversary here 🎂'
    )
  })

  test('a birthday on the anniversary wins', () => {
    expect(greeting({ ...base, now: new Date(2026, 2, 9, 9), birthday: '03-09' })?.kind).toBe(
      'birthday'
    )
  })

  test('streamer mode hides the birthday greeting and the anniversary line', () => {
    expect(greeting({ ...base, birthday: '07-04', streamer: true })).toBeNull()
    expect(greeting({ ...base, now: new Date(2026, 2, 9, 9), streamer: true })).toEqual({
      kind: 'anniversary',
      line: null,
      effect: 'balloons',
    })
    expect(
      greeting({ ...base, now: new Date(2026, 2, 9, 9), birthday: '03-09', streamer: true })
    ).toEqual({ kind: 'anniversary', line: null, effect: 'balloons' })
  })

  test('nothing with moments switched off', () => {
    expect(greeting({ ...base, birthday: '07-04', momentsOn: false })).toBeNull()
    expect(greeting({ ...base, now: new Date(2026, 2, 9, 9), momentsOn: false })).toBeNull()
  })
})

describe('once a day', () => {
  test('the first ask of a day is true, later ones false, and the next day starts over', () => {
    const once = createOnce()
    expect(once.first('birthday', 100)).toBe(true)
    expect(once.first('birthday', 100)).toBe(false)
    expect(once.first('server:lobby', 100)).toBe(true)
    expect(once.first('server:lobby', 100)).toBe(false)
    expect(once.first('birthday', 101)).toBe(true)
    expect(once.first('birthday', 101)).toBe(false)
  })

  test('it survives a reload and keeps only today', () => {
    const once = createOnce()
    once.first('birthday', 100)
    once.first('server:lobby', 100)
    const again = createOnce(JSON.parse(JSON.stringify(once)))
    expect(again.first('birthday', 100)).toBe(false)
    expect(again.first('anniversary', 100)).toBe(true)
    again.first('birthday', 101)
    expect(JSON.parse(JSON.stringify(again))).toEqual({ day: 101, keys: ['birthday'] })
    for (const junk of [null, 'x', 4, [], { day: 'x', keys: [] }, { day: 100, keys: 'birthday' }])
      expect(createOnce(junk).first('birthday', 100)).toBe(true)
  })
})

describe('empty-state accents', () => {
  const on = (y: number, m: number, d: number) => activeSeasons(dayNum(y, m, d), 'north')
  const noon = new Date(2026, 9, 31, 12)

  test('every season has one short plain line', () => {
    expect(Object.keys(SEASON_LINES).sort()).toEqual([...SEASON_IDS].sort())
    for (const line of Object.values(SEASON_LINES)) {
      expect([line, line.length > 0 && line.length <= 40]).toEqual([line, true])
      expect([line, /[–—]|rchat/i.test(line)]).toEqual([line, false])
    }
    expect(SEASON_LINES.halloween).toBe('Spooky quiet in here.')
  })

  test('a season on: its glyph, its line and a rain to replay', () => {
    expect(
      emptyAccent({ active: on(2026, 10, 31), now: noon, seasonsOn: true, momentsOn: true })
    ).toEqual({
      glyph: '🎃',
      line: 'Spooky quiet in here.',
      replay: 'Play the Halloween rain',
    })
    expect(
      emptyAccent({ active: on(2026, 12, 24), now: noon, seasonsOn: true, momentsOn: true })
    ).toEqual({ glyph: '🎄', line: 'All is calm in here.', replay: 'Play the Christmas rain' })
  })

  test('a day with no rain has no replay', () => {
    const fools = on(2026, 4, 1)
    expect(fools.map(a => a.season.id)).toEqual(['april_fools'])
    expect(emptyAccent({ active: fools, now: noon, seasonsOn: true, momentsOn: true })).toEqual({
      glyph: '🃏',
      line: SEASON_LINES.april_fools,
      replay: null,
    })
  })

  test('the replay names the season whose rain leads', () => {
    for (const s of SEASONS) expect(rainTitle(s.id)).toContain('Play the ')
    expect(rainTitle('christmas')).toBe('Play the Christmas rain')
    expect(rainTitle('friday_13')).toBe('Play the Friday the 13th rain')
  })

  test('night owl: 02:00 to 04:59 with no season on', () => {
    const quiet = on(2026, 7, 14)
    expect(quiet).toEqual([])
    const at = (h: number, min = 0) => new Date(2026, 6, 14, h, min)
    expect([1, 2, 3, 4, 5].map(h => isNightOwl(at(h)))).toEqual([false, true, true, true, false])
    expect(isNightOwl(at(4, 59))).toBe(true)
    expect(isNightOwl(at(1, 59))).toBe(false)
    const owl = { glyph: '🦉', line: null, replay: null }
    expect(emptyAccent({ active: quiet, now: at(3), seasonsOn: true, momentsOn: true })).toEqual(
      owl
    )
    expect(emptyAccent({ active: quiet, now: at(3), seasonsOn: true, momentsOn: false })).toBeNull()
    expect(emptyAccent({ active: quiet, now: at(12), seasonsOn: true, momentsOn: true })).toBeNull()
    expect(
      emptyAccent({ active: on(2026, 10, 31), now: at(3), seasonsOn: true, momentsOn: true })?.glyph
    ).toBe('🎃')
  })

  test('seasons switched off: no accent, the owl comes out', () => {
    expect(
      emptyAccent({ active: on(2026, 10, 31), now: noon, seasonsOn: false, momentsOn: true })
    ).toBeNull()
    expect(
      emptyAccent({
        active: on(2026, 10, 31),
        now: new Date(2026, 9, 31, 3),
        seasonsOn: false,
        momentsOn: true,
      })?.glyph
    ).toBe('🦉')
  })

  test('all caught up: the season glyph, else one of four in turn', () => {
    expect([...CAUGHT_UP_GLYPHS]).toEqual(['✨', '☕', '🌈', '🌻'])
    expect(caughtUpGlyph(on(2026, 10, 31), true, 0)).toBe('🎃')
    expect([0, 1, 2, 3, 4, 5].map(turn => caughtUpGlyph([], true, turn))).toEqual([
      '✨',
      '☕',
      '🌈',
      '🌻',
      '✨',
      '☕',
    ])
    expect(caughtUpGlyph(on(2026, 10, 31), false, 2)).toBe('🌈')
    expect(caughtUpGlyph([], true, -1)).toBe('🌻')
  })
})

describe('the New Year countdown', () => {
  test('counts the last ten seconds of 31 December, local time', () => {
    const at = (h: number, m: number, s: number, ms = 0) => new Date(2026, 11, 31, h, m, s, ms)
    expect(newYearCountdown(at(23, 59, 49, 999))).toBeNull()
    expect(newYearCountdown(at(23, 59, 50))).toBe(10)
    expect(newYearCountdown(at(23, 59, 50, 500))).toBe(10)
    expect(newYearCountdown(at(23, 59, 59))).toBe(1)
    expect(newYearCountdown(at(23, 59, 59, 999))).toBe(1)
    expect(newYearCountdown(new Date(2027, 0, 1, 0, 0, 0))).toBeNull()
    expect(newYearCountdown(new Date(2026, 11, 30, 23, 59, 55))).toBeNull()
    process.env.TZ = 'Pacific/Auckland'
    expect(newYearCountdown(new Date(Date.UTC(2026, 11, 31, 10, 59, 55)))).toBe(5)
  })
})
