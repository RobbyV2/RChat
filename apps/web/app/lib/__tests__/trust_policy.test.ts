import { describe, expect, test } from 'bun:test'
import { parseTrustInfo, parseTrustSettings, wants } from '../trust/policy'

const INSTANCE = {
  software: 'rchat',
  trust: {
    version: 1,
    algs: ['s256'],
    header: 'X-Trust-Token',
    wasm: '/pow/rchat_pow.wasm',
    page_gate: true,
    forward_auth: false,
  },
}
const ON = { pow: true, pow_who: 'both', pow_signin: true, pow_pages: false }

describe('parseTrustInfo', () => {
  test('reads the trust object of an instance that advertises version 1 with s256', () => {
    expect(parseTrustInfo(INSTANCE)).toEqual({
      version: 1,
      algs: ['s256'],
      header: 'X-Trust-Token',
      wasm: '/pow/rchat_pow.wasm',
      pageGate: true,
      forwardAuth: false,
    })
  })

  test('fills what a version 1 instance leaves out', () => {
    expect(parseTrustInfo({ trust: { version: 1, algs: ['argon', 's256'] } })).toEqual({
      version: 1,
      algs: ['argon', 's256'],
      header: 'X-Trust-Token',
      wasm: '/pow/rchat_pow.wasm',
      pageGate: false,
      forwardAuth: false,
    })
  })

  test('an instance without trust, with another version or without s256 has none', () => {
    for (const instance of [
      null,
      undefined,
      'rchat',
      {},
      { software: 'rchat', features: {} },
      { trust: null },
      { trust: 'on' },
      { trust: [] },
      { trust: { version: 2, algs: ['s256'] } },
      { trust: { version: '1', algs: ['s256'] } },
      { trust: { version: 1 } },
      { trust: { version: 1, algs: 's256' } },
      { trust: { version: 1, algs: ['argon'] } },
      { trust: { version: 1, algs: [256] } },
    ])
      expect(parseTrustInfo(instance)).toBeNull()
  })
})

describe('parseTrustSettings', () => {
  test('reads the four public keys', () => {
    expect(parseTrustSettings(ON)).toEqual({ pow: true, who: 'both', signin: true, pages: false })
    expect(
      parseTrustSettings({ pow: true, pow_who: 'guests', pow_signin: false, pow_pages: true })
    ).toEqual({ pow: true, who: 'guests', signin: false, pages: true })
  })

  test('settings from before proof of work have it off', () => {
    for (const settings of [null, undefined, 7, {}, { registration: 'open' }, { pow: 'on' }])
      expect(parseTrustSettings(settings).pow).toBe(false)
  })

  test('an instance with it on and the rest missing or unknown asks everyone', () => {
    expect(parseTrustSettings({ pow: true })).toEqual({
      pow: true,
      who: 'both',
      signin: true,
      pages: false,
    })
    expect(parseTrustSettings({ pow: true, pow_who: 'martians', pow_signin: 'yes' })).toEqual({
      pow: true,
      who: 'both',
      signin: true,
      pages: false,
    })
  })
})

describe('wants', () => {
  const info = parseTrustInfo(INSTANCE)
  const settings = (over: Record<string, unknown> = {}) => parseTrustSettings({ ...ON, ...over })

  test('pow_who covers guests, accounts, both or nobody', () => {
    const table: [string, boolean, boolean][] = [
      ['both', true, true],
      ['guests', true, false],
      ['accounts', false, true],
      ['none', false, false],
    ]
    for (const [who, guest, account] of table) {
      expect(wants(info, settings({ pow_who: who }), 'general', false)).toBe(guest)
      expect(wants(info, settings({ pow_who: who }), 'general', true)).toBe(account)
    }
  })

  test('sign-in follows its own switch, whoever asks', () => {
    for (const who of ['both', 'guests', 'accounts', 'none'])
      for (const signedIn of [false, true]) {
        expect(wants(info, settings({ pow_who: who }), 'signin', signedIn)).toBe(true)
        expect(wants(info, settings({ pow_who: who, pow_signin: false }), 'signin', signedIn)).toBe(
          false
        )
      }
  })

  test('nothing is wanted with the switch off', () => {
    for (const kind of ['general', 'signin'] as const)
      for (const signedIn of [false, true])
        expect(wants(info, settings({ pow: false }), kind, signedIn)).toBe(false)
  })

  test('an instance without trust is never solved for, whatever its settings say', () => {
    for (const kind of ['general', 'signin'] as const)
      for (const signedIn of [false, true]) {
        expect(wants(null, settings(), kind, signedIn)).toBe(false)
        expect(wants(parseTrustInfo({ trust: { version: 2 } }), settings(), kind, signedIn)).toBe(
          false
        )
      }
  })
})
