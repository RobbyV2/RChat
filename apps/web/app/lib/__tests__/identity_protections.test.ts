import { describe, expect, test } from 'bun:test'
import {
  ADMIN_LINE,
  REQUIREMENTS,
  WHY,
  banner,
  guidedSetup,
  modeOf,
  serverBanner,
  type MeProtections,
} from '../identity/protections'

const date = (secs: number) => `day ${secs / 86400}`
const grace = (over: Partial<MeProtections> = {}): MeProtections => ({
  unmet: [{ key: 'totp', deadline: 14 * 86400 }],
  restricted: false,
  ...over,
})

describe('the registry', () => {
  test('setup order, labels and step titles', () => {
    expect(REQUIREMENTS.map(r => r.key)).toEqual(['new_password', 'totp', 'backup_phrase'])
    expect(REQUIREMENTS.map(r => r.label)).toEqual([
      'A password of your own',
      'Authenticator codes',
      'A saved backup phrase',
    ])
    expect(REQUIREMENTS.map(r => r.step)).toEqual([
      'Choose your own password',
      'Set up an authenticator app',
      'Save a backup phrase',
    ])
    expect(WHY).toBe('This instance requires it.')
  })
})

describe('the banner while in grace', () => {
  test('names the first unmet protection and its deadline', () => {
    expect(banner(grace(), date)).toEqual({
      key: 'totp',
      text: 'Set up authenticator codes by day 14.',
      action: 'Set up',
    })
    expect(banner(grace({ unmet: [{ key: 'backup_phrase', deadline: 86400 }] }), date)).toEqual({
      key: 'backup_phrase',
      text: 'Save a backup phrase by day 1.',
      action: 'Set up',
    })
    expect(banner(grace({ unmet: [{ key: 'new_password' }] }), date)).toEqual({
      key: 'new_password',
      text: 'Choose your own password.',
      action: 'Change',
    })
  })
  test('the password comes first whatever order the server sent', () => {
    const both = grace({
      unmet: [
        { key: 'backup_phrase', deadline: 1 },
        { key: 'totp', deadline: 2 },
        { key: 'new_password' },
      ],
    })
    expect(banner(both, date)?.key).toBe('new_password')
  })
  test('nothing when all is met, when restricted, when hidden for this load, or for a key this client does not know', () => {
    expect(banner({ unmet: [], restricted: false }, date)).toBeNull()
    expect(banner(grace({ restricted: true }), date)).toBeNull()
    expect(banner(grace(), date, true)).toBeNull()
    expect(banner(grace({ unmet: [{ key: 'passkey', deadline: 5 }] }), date)).toBeNull()
    expect(banner(null, date)).toBeNull()
  })
})

describe('the guided setup', () => {
  test('walks the keys in order: done, now, next', () => {
    const p = grace({
      unmet: [
        { key: 'backup_phrase', deadline: 3 * 86400 },
        { key: 'totp', deadline: 2 * 86400 },
      ],
    })
    expect(guidedSetup(p, ['new_password', 'totp', 'backup_phrase'], date)).toEqual({
      heading: 'This instance requires a few things before you continue.',
      steps: [
        { key: 'new_password', label: 'A password of your own', state: 'Done' },
        { key: 'totp', label: 'Authenticator codes', state: 'Now' },
        { key: 'backup_phrase', label: 'A saved backup phrase', state: 'Next' },
      ],
      current: 'totp',
      later: 'You have until day 2',
      adminLine: null,
    })
  })
  test('Later only in grace; the admin line only to a site admin while no admin can fix it', () => {
    const overdue = grace({ restricted: true })
    expect(guidedSetup(overdue, ['totp'], date).later).toBeNull()
    expect(
      guidedSetup(grace({ unmet: [{ key: 'new_password' }] }), ['new_password'], date).later
    ).toBeNull()
    expect(
      guidedSetup(overdue, ['totp'], date, { isSiteAdmin: true, noUsableAdmin: true }).adminLine
    ).toBe(ADMIN_LINE)
    expect(
      guidedSetup(overdue, ['totp'], date, { isSiteAdmin: true, noUsableAdmin: false }).adminLine
    ).toBeNull()
    expect(
      guidedSetup(overdue, ['totp'], date, { isSiteAdmin: false, noUsableAdmin: true }).adminLine
    ).toBeNull()
    expect(ADMIN_LINE).toBe('You can also change this requirement in Site administration.')
  })
  test('nothing left: no current step', () => {
    const done = guidedSetup({ unmet: [], restricted: false }, ['totp'], date)
    expect(done.current).toBeNull()
    expect(done.steps).toEqual([{ key: 'totp', label: 'Authenticator codes', state: 'Done' }])
  })
})

describe('what the client does with Me.protections', () => {
  test('modes', () => {
    expect(modeOf(null)).toBe('none')
    expect(modeOf({ unmet: [], restricted: false })).toBe('none')
    expect(modeOf(grace())).toBe('grace')
    expect(modeOf(grace({ restricted: true }))).toBe('restricted')
  })
  test('the server rule banner names the server, never the reason someone else has', () => {
    expect(serverBanner('lobby')).toBe(
      'lobby needs two-factor for your role. Your moderator tools here are off until you set it up.'
    )
  })
})
