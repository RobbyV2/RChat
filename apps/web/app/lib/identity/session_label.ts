export type UaBrand = { brand: string; version?: string }
export type UaData = { brands?: UaBrand[]; platform?: string; mobile?: boolean }
export type Shell = 'web' | 'desktop' | 'mobile'
export type Via = 'password' | 'phrase' | 'sso' | 'device' | 'forward' | 'register'

export const LABEL_MAX = 64

export const cleanLabel = (text: string) =>
  [
    ...text
      .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
      .replace(/\s+/g, ' ')
      .trim(),
  ]
    .slice(0, LABEL_MAX)
    .join('')
    .trim()

const OS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Android/, 'Android'],
  [/CrOS/, 'ChromeOS'],
  [/Windows/, 'Windows'],
  [/Mac OS X|Macintosh/, 'macOS'],
  [/Linux|X11/, 'Linux'],
]

const BROWSERS: [RegExp, string][] = [
  [/Edg(e|A|iOS)?\//, 'Edge'],
  [/OPR\/|Opera/, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
]

const GENERIC_BRANDS = /^(chromium|not.?a.?brand.*)$/i

export const osOf = (userAgent: string, uaData?: UaData): string | null =>
  uaData?.platform || (OS.find(([re]) => re.test(userAgent))?.[1] ?? null)

export const browserOf = (userAgent: string, uaData?: UaData): string | null => {
  const brands = (uaData?.brands ?? []).map(b => b.brand).filter(b => !/not.?a.?brand/i.test(b))
  const named = brands.find(b => !GENERIC_BRANDS.test(b)) ?? brands[0]
  return named ?? BROWSERS.find(([re]) => re.test(userAgent))?.[1] ?? null
}

export const sessionLabel = (c: { shell: Shell; userAgent: string; uaData?: UaData }) => {
  const os = osOf(c.userAgent, c.uaData)
  const phone = os === 'iOS' || os === 'Android' ? os : null
  const what =
    c.shell === 'desktop'
      ? 'Desktop app'
      : c.shell === 'mobile'
        ? 'Phone app'
        : (browserOf(c.userAgent, c.uaData) ?? 'Browser')
  const where = c.shell === 'mobile' ? phone : os
  return cleanLabel(where ? `${what} on ${where}` : what)
}

export type TwoFactorBy = 'rchat' | 'provider' | null
export type ProviderSignIn = { name: string; twoFactorBy: TwoFactorBy }

export const viaLine = (via: Via, amr: readonly string[], provider?: ProviderSignIn) => {
  const code = amr.includes('otp')
  const phrase = amr.includes('swk')
  switch (via) {
    case 'password':
      return code ? 'Password and code' : phrase ? 'Password and backup phrase' : 'Password'
    case 'phrase':
      return code ? 'Backup phrase and code' : 'Backup phrase'
    case 'device':
      return 'Approved from another device'
    case 'register':
      return 'Signed up'
    case 'sso':
    case 'forward':
      if (provider?.twoFactorBy === 'provider') return `Provider, two-factor by ${provider.name}`
      if (provider?.twoFactorBy === 'rchat')
        return phrase && !code ? 'Provider and backup phrase' : 'Provider and code'
      return 'Provider'
  }
}
