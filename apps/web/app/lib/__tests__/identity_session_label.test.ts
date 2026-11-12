import { describe, expect, test } from 'bun:test'
import {
  LABEL_MAX,
  browserOf,
  cleanLabel,
  osOf,
  sessionLabel,
  viaLine,
} from '../identity/session_label'

const FIREFOX_LINUX = 'Mozilla/5.0 (X11; Linux x86_64; rv:143.0) Gecko/20100101 Firefox/143.0'
const CHROME_WINDOWS =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'
const EDGE_WINDOWS = `${CHROME_WINDOWS} Edg/140.0.0.0`
const SAFARI_MAC =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15'
const SAFARI_IPHONE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1'
const CHROME_ANDROID =
  'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36'

describe('what a session calls itself', () => {
  test('a browser is "{browser} on {OS}" from the user agent', () => {
    const web = (userAgent: string) => sessionLabel({ shell: 'web', userAgent })
    expect(web(FIREFOX_LINUX)).toBe('Firefox on Linux')
    expect(web(CHROME_WINDOWS)).toBe('Chrome on Windows')
    expect(web(EDGE_WINDOWS)).toBe('Edge on Windows')
    expect(web(SAFARI_MAC)).toBe('Safari on macOS')
    expect(web(SAFARI_IPHONE)).toBe('Safari on iOS')
    expect(web(CHROME_ANDROID)).toBe('Chrome on Android')
    expect(web('curl/8.0')).toBe('Browser')
    expect(web('')).toBe('Browser')
    expect(web('SomeBot (X11; Linux)')).toBe('Browser on Linux')
  })
  test("the browser's own brand list wins over the user agent text", () => {
    const uaData = {
      brands: [
        { brand: 'Not?A_Brand', version: '99' },
        { brand: 'Chromium', version: '140' },
        { brand: 'Brave', version: '140' },
      ],
      platform: 'macOS',
    }
    expect(sessionLabel({ shell: 'web', userAgent: CHROME_WINDOWS, uaData })).toBe('Brave on macOS')
    expect(browserOf(CHROME_WINDOWS, { brands: [{ brand: 'Chromium' }] })).toBe('Chromium')
    expect(browserOf(CHROME_WINDOWS, { brands: [] })).toBe('Chrome')
    expect(osOf(CHROME_WINDOWS, { platform: '' })).toBe('Windows')
  })
  test('the shells say what they are', () => {
    expect(sessionLabel({ shell: 'desktop', userAgent: CHROME_WINDOWS })).toBe(
      'Desktop app on Windows'
    )
    expect(sessionLabel({ shell: 'desktop', userAgent: 'x' })).toBe('Desktop app')
    expect(sessionLabel({ shell: 'mobile', userAgent: SAFARI_IPHONE })).toBe('Phone app on iOS')
    expect(sessionLabel({ shell: 'mobile', userAgent: CHROME_ANDROID })).toBe(
      'Phone app on Android'
    )
    expect(sessionLabel({ shell: 'mobile', userAgent: FIREFOX_LINUX })).toBe('Phone app')
  })
  test('trimmed, without control characters, at most 64 characters', () => {
    expect(LABEL_MAX).toBe(64)
    expect(cleanLabel('  Firefox\u0000 on\r\n Linux‮ ')).toBe('Firefox on Linux')
    expect([...cleanLabel('é'.repeat(100))]).toHaveLength(64)
    expect(cleanLabel('\u0007')).toBe('')
    expect(
      sessionLabel({
        shell: 'web',
        userAgent: FIREFOX_LINUX,
        uaData: { brands: [{ brand: 'x'.repeat(200) }] },
      }).length
    ).toBe(64)
  })
})

describe('how a session signed in', () => {
  test('the proofs in plain words', () => {
    expect(viaLine('password', ['pwd'])).toBe('Password')
    expect(viaLine('password', ['mfa', 'otp', 'pwd'])).toBe('Password and code')
    expect(viaLine('password', ['mfa', 'pwd', 'swk'])).toBe('Password and backup phrase')
    expect(viaLine('phrase', ['swk'])).toBe('Backup phrase')
    expect(viaLine('phrase', ['mfa', 'otp', 'swk'])).toBe('Backup phrase and code')
    expect(viaLine('device', ['pwd'])).toBe('Approved from another device')
    expect(viaLine('register', ['pwd'])).toBe('Signed up')
  })
  test('a provider sign-in says who proved the second factor, never from the amr alone', () => {
    const by = (twoFactorBy: 'rchat' | 'provider' | null) => ({ name: 'Authentik', twoFactorBy })
    expect(viaLine('sso', ['pwd'])).toBe('Provider')
    expect(viaLine('forward', [])).toBe('Provider')
    expect(viaLine('sso', ['pwd'], by(null))).toBe('Provider')
    expect(viaLine('sso', ['otp', 'pwd', 'mfa'])).toBe('Provider')
    expect(viaLine('sso', ['otp', 'pwd'], by(null))).toBe('Provider')
    expect(viaLine('sso', ['otp', 'pwd', 'mfa'], by('rchat'))).toBe('Provider and code')
    expect(viaLine('sso', ['mfa', 'pwd', 'swk'], by('rchat'))).toBe('Provider and backup phrase')
    expect(viaLine('forward', ['mfa', 'otp'], by('rchat'))).toBe('Provider and code')
    expect(viaLine('sso', ['mfa', 'pwd'], by('provider'))).toBe('Provider, two-factor by Authentik')
    expect(viaLine('sso', ['mfa', 'otp', 'pwd'], by('provider'))).toBe(
      'Provider, two-factor by Authentik'
    )
    expect(viaLine('forward', ['mfa'], { name: 'proxy', twoFactorBy: 'provider' })).toBe(
      'Provider, two-factor by proxy'
    )
    for (const amr of [['otp'], ['mfa', 'otp', 'hwk', 'swk', 'pwd']])
      expect(viaLine('sso', amr, by('provider'))).not.toContain('code')
  })
})
