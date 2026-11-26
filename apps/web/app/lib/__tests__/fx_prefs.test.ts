import { describe, expect, test } from 'bun:test'
import {
  FX_KEY,
  defaultFxPrefs,
  fxKindOn,
  fxShared,
  fxValue,
  hemisphereFor,
  importFxShared,
  parseFxPrefs,
  seasonsOff,
  type FxPrefs,
} from '../fx/prefs'
import { SEASON_IDS } from '../fx/seasons'

const custom: FxPrefs = {
  v: 2,
  on: false,
  seasons: false,
  seasonOff: ['halloween', 'friday_13'],
  hemisphere: 'south',
  reactions: false,
  messages: false,
  eggs: false,
  moments: false,
  trail: false,
  birthday: '02-29',
}

describe('fun effects prefs', () => {
  test('defaults: everything on', () => {
    expect(FX_KEY).toBe('fx')
    expect(defaultFxPrefs).toEqual({
      v: 2,
      on: true,
      seasons: true,
      seasonOff: [],
      hemisphere: 'auto',
      reactions: true,
      messages: true,
      eggs: true,
      moments: true,
      trail: true,
      birthday: null,
    })
  })

  test('nothing saved, junk and other versions read as defaults', () => {
    for (const raw of [null, '', 'x', '[]', '7', 'null', '{"v":1,"on":false}', '{"on":false}'])
      expect([raw, parseFxPrefs(raw)]).toEqual([raw, defaultFxPrefs])
    expect(parseFxPrefs(JSON.stringify({ ...custom, v: 3 }))).toEqual(defaultFxPrefs)
  })

  test('a saved value reads back', () => {
    expect(parseFxPrefs(fxValue(custom))).toEqual(custom)
    expect(parseFxPrefs(fxValue(defaultFxPrefs))).toEqual(defaultFxPrefs)
    expect(parseFxPrefs(JSON.stringify({ ...custom, motion: 'always' }))).toEqual(custom)
  })

  test('every field falls back alone', () => {
    const bad: Record<keyof Omit<FxPrefs, 'v'>, unknown[]> = {
      on: [1, 'true', null],
      seasons: ['no', 0],
      seasonOff: ['halloween', { halloween: true }, 3],
      hemisphere: ['east', 2, null],
      reactions: [0, 'off'],
      messages: [0, 'off'],
      eggs: [0, 'off'],
      moments: [0, 'off'],
      trail: [0, 'off'],
      birthday: ['2-9', '13-01', '02-30', '04-31', '00-10', '06-00', 229, '02-29x'],
    }
    for (const [field, values] of Object.entries(bad) as [keyof FxPrefs, unknown[]][])
      for (const value of values) {
        const got = parseFxPrefs(JSON.stringify({ ...custom, [field]: value }))
        expect([field, value, got]).toEqual([
          field,
          value,
          { ...custom, [field]: defaultFxPrefs[field] },
        ])
      }
  })

  test('unknown and repeated season ids are dropped, the rest kept in table order', () => {
    const raw = JSON.stringify({
      ...custom,
      seasonOff: ['christmas', 'festivus', 4, 'christmas', null, 'easter'],
    })
    expect(parseFxPrefs(raw).seasonOff).toEqual(['easter', 'christmas'])
  })

  test('a birthday is a real month and day', () => {
    for (const day of ['01-01', '02-29', '12-31', '11-30'])
      expect(parseFxPrefs(JSON.stringify({ ...custom, birthday: day })).birthday).toBe(day)
    expect(parseFxPrefs(JSON.stringify({ ...custom, birthday: null })).birthday).toBeNull()
  })
})

describe('what is shared between devices', () => {
  test('the export has no birthday', () => {
    const shared = fxShared(custom)
    expect('birthday' in shared).toBe(false)
    expect(JSON.stringify(shared).includes('02-29')).toBe(false)
    expect({ ...shared, birthday: custom.birthday }).toEqual(custom)
  })

  test("an import keeps this device's birthday and parses the rest defensively", () => {
    const local = { ...defaultFxPrefs, birthday: '07-04' }
    expect(importFxShared(local, fxShared(custom))).toEqual({ ...custom, birthday: '07-04' })
    expect(importFxShared(local, { ...fxShared(custom), birthday: '01-01' })).toEqual({
      ...custom,
      birthday: '07-04',
    })
    expect(importFxShared(local, { v: 2, on: 'no', eggs: false })).toEqual({
      ...local,
      eggs: false,
    })
    for (const junk of [null, 'x', 3, [], { v: 1, on: false }])
      expect(importFxShared(local, junk)).toEqual(local)
  })
})

describe('what the prefs switch', () => {
  test('each kind follows its own toggle', () => {
    for (const kind of ['seasons', 'reactions', 'messages', 'eggs', 'moments'] as const) {
      expect([kind, fxKindOn(defaultFxPrefs, kind)]).toEqual([kind, true])
      expect([kind, fxKindOn({ ...defaultFxPrefs, [kind]: false }, kind)]).toEqual([kind, false])
    }
  })

  test('the cursor trail needs moments too', () => {
    expect(fxKindOn(defaultFxPrefs, 'trail')).toBe(true)
    expect(fxKindOn({ ...defaultFxPrefs, trail: false }, 'trail')).toBe(false)
    expect(fxKindOn({ ...defaultFxPrefs, moments: false }, 'trail')).toBe(false)
  })

  test('seasons switched off, by the account or the instance list', () => {
    expect([...seasonsOff(defaultFxPrefs, 'all')]).toEqual([])
    expect([...seasonsOff(defaultFxPrefs, undefined)]).toEqual([])
    expect([...seasonsOff({ ...defaultFxPrefs, seasonOff: ['easter'] }, 'all')]).toEqual(['easter'])
    const limited = seasonsOff({ ...defaultFxPrefs, seasonOff: ['easter'] }, [
      'easter',
      'halloween',
      'christmas',
      'festivus',
    ])
    expect(SEASON_IDS.filter(id => !limited.has(id))).toEqual(['halloween', 'christmas'])
    expect(seasonsOff({ ...defaultFxPrefs, seasons: false }, 'all').size).toBe(SEASON_IDS.length)
  })

  test('the hemisphere is the choice, or the time zone on Auto', () => {
    expect(hemisphereFor(defaultFxPrefs, 'Pacific/Auckland')).toBe('south')
    expect(hemisphereFor(defaultFxPrefs, 'Europe/London')).toBe('north')
    expect(hemisphereFor(defaultFxPrefs, undefined)).toBe('north')
    expect(hemisphereFor({ ...defaultFxPrefs, hemisphere: 'north' }, 'Pacific/Auckland')).toBe(
      'north'
    )
    expect(hemisphereFor({ ...defaultFxPrefs, hemisphere: 'south' }, 'Europe/London')).toBe('south')
  })
})
