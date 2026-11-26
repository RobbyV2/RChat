import { describe, expect, test } from 'bun:test'
import { searchRows } from '../settings_search'
import {
  SECTION_GROUPS,
  sectionFor,
  settingsRows,
  settingsSections,
  type SettingsSection,
} from '../settings_sections'

const SIGNED_IN = { signedIn: true, p2p: true }
const GUEST = { signedIn: false, p2p: false }
const P2P_OFF = { signedIn: true, p2p: false }

describe('settingsSections', () => {
  test('a signed-in account with P2P lists every entry, Profile first', () => {
    expect(settingsSections(SIGNED_IN)).toEqual([
      'profile',
      'privacy',
      'general',
      'notifications',
      'palette',
      'sync',
      'p2p',
      'information',
    ])
  })

  test('a guest has no Privacy and no P2P', () => {
    expect(settingsSections(GUEST)).toEqual([
      'profile',
      'general',
      'notifications',
      'palette',
      'sync',
      'information',
    ])
  })

  test('without P2P the P2P entry is gone and Privacy stays', () => {
    expect(settingsSections(P2P_OFF)).toEqual([
      'profile',
      'privacy',
      'general',
      'notifications',
      'palette',
      'sync',
      'information',
    ])
  })

  test('P2P never shows for a guest', () => {
    expect(settingsSections({ signedIn: false, p2p: true })).not.toContain('p2p')
  })
})

describe('sectionFor', () => {
  const all = settingsSections(SIGNED_IN)
  const guest = settingsSections(GUEST)

  test('nothing asked opens Profile', () => {
    expect(sectionFor(undefined, undefined, all)).toBe('profile')
    expect(sectionFor(null, undefined, guest)).toBe('profile')
  })

  test('the id "settings" opens General', () => {
    expect(sectionFor('settings', undefined, all)).toBe('general')
    expect(sectionFor('settings', undefined, guest)).toBe('general')
  })

  test('a listed section opens as asked', () => {
    expect(sectionFor('notifications', undefined, all)).toBe('notifications')
    expect(sectionFor('information', undefined, guest)).toBe('information')
    expect(sectionFor('p2p', undefined, all)).toBe('p2p')
  })

  test('a section that is not listed falls back to the first entry', () => {
    expect(sectionFor('privacy', undefined, guest)).toBe('profile')
    expect(sectionFor('p2p', undefined, settingsSections(P2P_OFF))).toBe('profile')
  })

  test('a field to focus picks its section when none is asked', () => {
    expect(sectionFor(undefined, 'bio', all)).toBe('profile')
    expect(sectionFor(undefined, 'display_name', all)).toBe('profile')
    expect(sectionFor(undefined, 'p2p_limits', all)).toBe('p2p')
  })

  test('the P2P limits field opens P2P even when "settings" is asked for', () => {
    expect(sectionFor('settings', 'p2p_limits', all)).toBe('p2p')
  })

  test('the P2P limits field without P2P falls back to the first entry', () => {
    expect(sectionFor(undefined, 'p2p_limits', settingsSections(P2P_OFF))).toBe('profile')
  })
})

describe('nav groups', () => {
  test('each group of entries sits together in the nav', () => {
    const groups = settingsSections(SIGNED_IN).map(s => SECTION_GROUPS[s])
    expect(groups).toEqual([
      'Your account',
      'Your account',
      'App settings',
      'App settings',
      'App settings',
      'App settings',
      'Peer-to-peer',
      'About',
    ])
  })
})

describe('settingsRows', () => {
  const ALL: SettingsSection[] = settingsSections(SIGNED_IN)
  const everywhere = { signedIn: true, desktop: true }

  test('every row belongs to its section and has an id unique across the settings', () => {
    const ids = ALL.flatMap(s => settingsRows(s, everywhere).map(r => r.id))
    expect(new Set(ids).size).toBe(ids.length)
    for (const section of ALL) {
      expect(settingsRows(section, everywhere).length).toBeGreaterThan(0)
      for (const row of settingsRows(section, everywhere)) {
        expect(row.section).toBe(section)
        expect(row.id.startsWith('user_')).toBe(true)
      }
    }
  })

  test('rows of an account leave out guests, and desktop rows leave out the browser', () => {
    const ids = (section: SettingsSection, at: { signedIn: boolean; desktop: boolean }) =>
      settingsRows(section, at).map(r => r.id)
    expect(ids('profile', { signedIn: false, desktop: false })).not.toContain('user_profile')
    expect(ids('profile', { signedIn: true, desktop: false })).toContain('user_profile')
    expect(ids('general', { signedIn: false, desktop: false })).not.toContain('user_status')
    expect(ids('general', { signedIn: true, desktop: false })).not.toContain('user_desktop')
    expect(ids('general', { signedIn: true, desktop: true })).toContain('user_desktop')
    for (const row of settingsRows('general', everywhere)) {
      expect('account' in row).toBe(false)
      expect('desktop' in row).toBe(false)
    }
  })
})

describe('search over the settings', () => {
  const found = (signedIn: boolean, query: string) => {
    const at = { signedIn, desktop: false }
    const sections = settingsSections({ signedIn, p2p: true }).map(id => ({
      id,
      label: id,
      rows: settingsRows(id, at),
    }))
    return searchRows(sections, query).map(hit => hit.row.id)
  }

  test('finds the P2P storage limits and background sync', () => {
    expect(found(true, 'limits')).toContain('user_p2p')
    expect(found(true, 'background sync')).toContain('user_p2p')
    expect(found(true, 'storage')).toContain('user_p2p')
  })

  test('password finds sign-in for an account and not for a guest', () => {
    expect(found(true, 'password')).toContain('user_sign_in')
    expect(found(false, 'password')).not.toContain('user_sign_in')
    expect(found(false, 'exit guest')).toEqual(['user_sign_in'])
  })

  test('a guest sees the sign-in row as leaving guest mode', () => {
    const guest = settingsRows('profile', { signedIn: false, desktop: false })
    const row = guest.find(r => r.id === 'user_sign_in')
    expect(row?.label).toBe('Exit guest mode')
    expect('guest' in (row ?? {})).toBe(false)
  })
})
