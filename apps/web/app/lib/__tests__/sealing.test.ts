import { describe, expect, test } from 'bun:test'
import {
  deviceKeyNote,
  dmPlace,
  hostedDmSeal,
  hostedServerSeal,
  jobPercent,
  jobText,
  latestJob,
  serverPlace,
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
    expect(hostedServerSeal({ on: false }, true, { encryption_ready: 'first_need' })).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedDmSeal({ on: false }, { encryption_ready: 'first_need' }).available).toBe(true)
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
    expect(hostedServerSeal({ on: 'yes' }, true, { encryption_ready: 'nonsense' })).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedServerSeal({ on: true, forced: true }, true).reason).toBe('forced')
    expect(hostedServerSeal({ on: false }, true, { encryption_ready: 'updating' }).reason).toBe(
      'updating'
    )
    expect(hostedDmSeal({ on: false })).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedDmSeal(null).available).toBe(false)
  })

  test('shows what the site says before a switch is refused', () => {
    const seal = { on: false, forced: false, own: false, server_forced: false }
    for (const ready of ['keys', 'updating'] as const) {
      const site = { encryption_required: false, encryption_ready: ready }
      expect(hostedServerSeal(seal, true, site).reason).toBe(ready)
      expect(hostedDmSeal(seal, site).reason).toBe(ready)
    }
    expect(sealReasonText(hostedDmSeal(seal, { encryption_ready: 'keys' }), 'hosted')).toBe(
      'This site needs an encryption key first'
    )
  })

  test('follows the site-wide requirement in the settings without the place sent again', () => {
    const plain = { on: false, forced: false, own: false, server_forced: false }
    const bySite = { on: true, forced: true, own: false, server_forced: false }
    const required = { encryption_required: true, encryption_ready: 'ready' }
    const lifted = { encryption_required: false, encryption_ready: 'ready' }
    expect(hostedServerSeal(plain, true, required)).toEqual({
      on: true,
      forced: true,
      available: false,
      reason: 'forced',
    })
    expect(hostedServerSeal(bySite, true, lifted)).toEqual({
      on: false,
      forced: false,
      available: true,
      reason: null,
    })
    expect(hostedServerSeal({ ...bySite, own: true }, true, lifted).on).toBe(true)
    expect(hostedServerSeal({ ...bySite, server_forced: true }, true, lifted).forced).toBe(true)
    expect(hostedDmSeal(bySite, lifted).on).toBe(false)
    expect(hostedServerSeal(bySite, true, {}).forced).toBe(true)
    expect(hostedServerSeal({ on: true, forced: true }, true, lifted).forced).toBe(true)
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

describe('jobs over stored messages', () => {
  const job = (state: 'running' | 'done' | 'failed', done: number, upto = 200, from = 0) => ({
    id: 1,
    direction: 'seal' as const,
    upto,
    done,
    from,
    state,
  })

  test('show how far they got, and never 100% before they end', () => {
    expect(jobPercent(job('running', 0))).toBe(0)
    expect(jobPercent(job('running', 50))).toBe(25)
    expect(jobPercent(job('running', 200))).toBe(99)
    expect(jobPercent(job('done', 50))).toBe(100)
    expect(jobPercent(job('running', 0, 0))).toBe(100)
    // Over the place's own messages: a place whose ids start late is not near its end at once.
    expect(jobPercent(job('running', 0, 1_001_000, 1_000_000))).toBe(0)
    expect(jobPercent(job('running', 1_000_250, 1_001_000, 1_000_000))).toBe(25)
    expect(jobText(job('running', 50))).toBe('Encrypting earlier messages: 25%')
    expect(jobText(job('done', 200))).toBe('Earlier messages are stored encrypted.')
    expect(jobText(job('failed', 10))).toBe(
      'Encrypting earlier messages stopped. Start it again to go on.'
    )
    expect(jobText({ ...job('done', 200), direction: 'unseal' })).toBe(
      'Messages are stored plain again.'
    )
  })

  test('the newest of a direction is read defensively', () => {
    const list = [
      { direction: 'unseal', upto: 9, done: 9, state: 'done' },
      { direction: 'seal', upto: 'x', done: 1, state: 'running' },
      { direction: 'seal', upto: 9, done: 3, state: 'running' },
      { direction: 'seal', upto: 9, done: 9, state: 'done' },
    ]
    expect(latestJob(list, 'seal')).toEqual({
      id: 0,
      place: '',
      direction: 'seal',
      upto: 9,
      done: 3,
      from: 0,
      state: 'running',
    })
    const listed = [
      { id: 7, place: 's:x', direction: 'seal', upto: 9, done: 3, from: 2, state: 'running' },
    ]
    const pushed = (id: number) => ({ ...listed[0], id, done: 5 })
    expect(latestJob(listed, 'seal', pushed(7))?.done).toBe(5)
    expect(latestJob(listed, 'seal', pushed(6))?.done).toBe(3)
    expect(latestJob([], 'seal', pushed(1))?.done).toBe(5)
    expect(latestJob(listed, 'unseal', pushed(9))).toBeNull()
    expect(latestJob(list, 'unseal')?.state).toBe('done')
    expect(latestJob(null, 'seal')).toBeNull()
    expect(latestJob([{ direction: 'seal', upto: 1, done: 1, state: 'odd' }], 'seal')).toBeNull()
  })

  test('places and the device key note', () => {
    expect(serverPlace('club')).toBe('s:club')
    expect(dmPlace(7)).toBe('d:7')
    expect(deviceKeyNote(true, false)).toBeNull()
    expect(deviceKeyNote(false, false)).toContain('browser profile')
    expect(deviceKeyNote(false, true)).toContain("app's profile")
  })
})
