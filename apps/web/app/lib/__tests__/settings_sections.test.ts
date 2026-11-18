import { describe, expect, test } from 'bun:test'
import { sectionFor, settingsSections } from '../settings_sections'

const SIGNED_IN = { signedIn: true, p2p: true }
const GUEST = { signedIn: false, p2p: false }
const P2P_OFF = { signedIn: true, p2p: false }

describe('settingsSections', () => {
  test('a signed-in account with P2P lists every entry, Profile first', () => {
    expect(settingsSections(SIGNED_IN)).toEqual([
      'profile',
      'general',
      'notifications',
      'privacy',
      'p2p',
      'sync',
      'palette',
      'information',
    ])
  })

  test('a guest has no Privacy and no P2P', () => {
    expect(settingsSections(GUEST)).toEqual([
      'profile',
      'general',
      'notifications',
      'sync',
      'palette',
      'information',
    ])
  })

  test('without P2P the P2P entry is gone and Privacy stays', () => {
    expect(settingsSections(P2P_OFF)).toEqual([
      'profile',
      'general',
      'notifications',
      'privacy',
      'sync',
      'palette',
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
