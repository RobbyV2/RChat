import { describe, expect, test } from 'bun:test'
import {
  hostedDmSeal,
  hostedServerSeal,
  p2pSeal,
  sealDescription,
  sealReasonText,
  sealState,
  storeRegister,
} from '../sealing'

describe('the encrypted storage switch', () => {
  test('is off and changeable by default once the site has a key', () => {
    expect(sealState({ stored: false, forced: false, readiness: 'ready', allowed: true })).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
  })

  test('can be turned on before the first key when the site makes one then', () => {
    expect(
      sealState({ stored: false, forced: false, readiness: 'first_need', allowed: true })
    ).toEqual({ on: false, forced: false, available: true, reason: null })
    expect(hostedServerSeal({ on: false, readiness: 'first_need' }, true)).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedDmSeal({ on: false, readiness: 'first_need' }).available).toBe(true)
  })

  test('cannot be turned on without a key or while a copy of the site lags', () => {
    for (const readiness of ['keys', 'updating'] as const) {
      const state = sealState({ stored: false, forced: false, readiness, allowed: true })
      expect(state).toEqual({ on: false, forced: false, available: false, reason: readiness })
    }
    expect(
      sealReasonText(
        sealState({ stored: false, forced: false, readiness: 'keys', allowed: true }),
        'hosted'
      )
    ).toBe('This site needs an encryption key first')
    expect(
      sealReasonText(
        sealState({ stored: false, forced: false, readiness: 'updating', allowed: true }),
        'hosted'
      )
    ).toBe('Not available while this site updates')
  })

  test('can always be turned off by someone allowed, whatever the keys', () => {
    for (const readiness of ['ready', 'first_need', 'keys', 'updating'] as const)
      expect(sealState({ stored: true, forced: false, readiness, allowed: true })).toEqual({
        on: true,
        forced: false,
        available: true,
        reason: null,
      })
  })

  test('shows on and locked when the site requires it, and never says who did', () => {
    for (const stored of [true, false])
      for (const allowed of [true, false]) {
        const state = sealState({ stored, forced: true, readiness: 'ready', allowed })
        expect(state).toEqual({ on: true, forced: true, available: false, reason: 'forced' })
        expect(sealReasonText(state, 'hosted')).toBe('Required by this site')
        expect(sealReasonText(state, 'p2p')).toBe('Required by this site')
      }
  })

  test('is read-only without the permission, with no reason shown', () => {
    const state = sealState({ stored: true, forced: false, readiness: 'ready', allowed: false })
    expect(state).toEqual({ on: true, forced: false, available: false, reason: 'permission' })
    expect(sealReasonText(state, 'hosted')).toBeNull()
    expect(sealReasonText({ ...state, available: true, reason: null }, 'hosted')).toBeNull()
  })

  test('reads a hosted server and DM defensively', () => {
    expect(hostedServerSeal(undefined, true)).toEqual({
      on: false,
      forced: false,
      available: false,
      reason: 'keys',
    })
    expect(hostedServerSeal({ on: true }, true).on).toBe(true)
    expect(hostedServerSeal({ on: 1, forced: 0 }, false).reason).toBe('permission')
    expect(hostedServerSeal({ on: 'yes', readiness: 'nonsense' }, true)).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedServerSeal({ on: true, forced: true }, true).reason).toBe('forced')
    expect(hostedServerSeal({ on: false, readiness: 'updating' }, true).reason).toBe('updating')
    expect(hostedDmSeal({ on: false })).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedDmSeal(null).available).toBe(false)
  })

  test('reads the P2P store register and ignores what it does not know', () => {
    expect(storeRegister({ on: true, earlier: true, later: 1 })).toEqual({
      on: true,
      earlier: true,
    })
    expect(storeRegister({ on: true })).toEqual({ on: true, earlier: false })
    expect(storeRegister({ on: false, earlier: true })).toEqual({ on: false, earlier: false })
    for (const junk of [undefined, null, 'on', 1, [], { on: 'true' }])
      expect(storeRegister(junk)).toEqual({ on: false, earlier: false })
  })

  test('applies the same rules to a P2P room and DM', () => {
    const base = { store: { on: false }, siteForced: false, deviceKey: true, allowed: true }
    expect(p2pSeal(base)).toEqual({ on: false, forced: false, available: true, reason: null })
    expect(p2pSeal({ ...base, store: { on: true } }).on).toBe(true)
    expect(p2pSeal({ ...base, allowed: false }).reason).toBe('permission')
    const forced = p2pSeal({ ...base, siteForced: true })
    expect(forced).toEqual({ on: true, forced: true, available: false, reason: 'forced' })
    const keyless = p2pSeal({ ...base, deviceKey: false })
    expect(keyless.reason).toBe('keys')
    expect(sealReasonText(keyless, 'p2p')).toBe("This device can't keep an encryption key")
  })

  test('never calls it end-to-end encryption', () => {
    expect(sealDescription('hosted')).toContain('This is not end-to-end encryption.')
    expect(sealDescription('p2p')).toBe(
      "New messages are stored encrypted on each member's device."
    )
  })
})
