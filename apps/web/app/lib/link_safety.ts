// Link safety for the links messages and embeds show, on hosted servers and P2P servers alike:
// a warning before an outside site opens, the domains a person trusts, and tracking parameters
// taken off links before a message is sent.

import { parse } from 'tldts'
import { defineSetting } from './settings'
import { jsonObject, jsonOr } from './schema'

declare const siteMark: unique symbol

// The site of a host, which is what a person trusts: its registrable domain (its public suffix
// and one label more, so `docs.example.com` and `www.example.com` are `example.com`, `www.co.uk`
// is itself), or an IPv4 address. Only `siteOf` makes one, so a public suffix (`com`, `co.uk`,
// `github.io`) is never trusted as a whole.
export type Site = string & { readonly [siteMark]: true }

export interface LinkPrefs {
  // Warn before opening a link to a site that is not trusted.
  warn: boolean
  // Take tracking parameters off links when sending.
  strip: boolean
  // Each covers the site's hosts: the domain and its subdomains.
  trusted: readonly Site[]
}

export const DEFAULT_LINK_PREFS: LinkPrefs = { warn: true, strip: false, trusted: [] }

export const TRUSTED_MAX = 500

const HOST_MAX = 253

export const linkPrefsKey = (username: string | null) => `rchat_links:${username ?? 'guest'}`

// A host as URLs give it (lowercase ASCII, IDNs in punycode), without a trailing dot. IPv6
// addresses are left out.
const cleanHost = (raw: string): string | null => {
  const host = raw.trim().toLowerCase().replace(/\.$/, '')
  if (!host || host.length > HOST_MAX || !/^[a-z0-9._-]+$/.test(host) || host.includes('..'))
    return null
  return host
}

// The site a host belongs to, or null when it has none (a public suffix, a name without one,
// an IPv6 address).
export const siteOf = (raw: string): Site | null => {
  const host = cleanHost(raw)
  if (!host) return null
  const parts = parse(host, { allowPrivateDomains: true, validateHostname: false })
  if (parts.isIp) return host as Site
  return parts.domain ? (parts.domain as Site) : null
}

// A stored entry counts only when it is a site itself; anything wider or narrower is dropped.
const storedSite = (raw: unknown): Site | null => {
  if (typeof raw !== 'string') return null
  const site = siteOf(raw)
  return site !== null && site === cleanHost(raw) ? site : null
}

export const parseLinkPrefs = (raw: string | null): LinkPrefs => {
  try {
    const v = jsonOr(raw, jsonObject, null)
    if (typeof v !== 'object' || v === null || (v as { v?: unknown }).v !== 1)
      return DEFAULT_LINK_PREFS
    const { warn, strip, trusted } = v as { warn?: unknown; strip?: unknown; trusted?: unknown }
    const sites = Array.isArray(trusted) ? trusted.map(storedSite) : []
    return {
      warn: warn !== false,
      strip: strip === true,
      trusted: [...new Set(sites.filter(h => h !== null))].slice(0, TRUSTED_MAX),
    }
  } catch {
    return DEFAULT_LINK_PREFS
  }
}

export const linkPrefsValue = ({ warn, strip, trusted }: LinkPrefs) =>
  JSON.stringify({ v: 1, warn, strip, trusted })

export const linkPrefsSetting = defineSetting<LinkPrefs, [string | null]>({
  scope: 'account',
  key: linkPrefsKey,
  decode: parseLinkPrefs,
  encode: linkPrefsValue,
})

export const trustSite = (prefs: LinkPrefs, site: Site): LinkPrefs =>
  prefs.trusted.includes(site)
    ? prefs
    : { ...prefs, trusted: [site, ...prefs.trusted].slice(0, TRUSTED_MAX) }

export const forgetSite = (prefs: LinkPrefs, site: Site): LinkPrefs => ({
  ...prefs,
  trusted: prefs.trusted.filter(h => h !== site),
})

// An outside web link: http or https with a host, read against the page's address `base` the
// way the browser reads it (`//host/...` and `/\\host` lead elsewhere). Anything else is never
// opened from a message.
export const webLink = (href: string | undefined, base?: string): URL | null => {
  if (!href) return null
  try {
    const url = new URL(href, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.hostname ? url : null
  } catch {
    return null
  }
}

// The host a link's text is checked against: lowercase, without `www.`.
export const shownHost = (url: URL) => url.hostname.toLowerCase().replace(/^www\./, '')

export const isTrusted = (prefs: LinkPrefs, url: URL) => {
  const site = siteOf(url.hostname)
  return site !== null && prefs.trusted.includes(site)
}

// Whether opening `href` asks first: a web link to another site, from someone else's message
// (or from one's own as well), to a host that is not trusted.
export const needsWarning = (
  prefs: LinkPrefs,
  href: string | undefined,
  localOrigins: readonly string[],
  own: boolean,
  base?: string
) => {
  const url = webLink(href, base)
  if (!url || own || !prefs.warn) return false
  if (localOrigins.some(o => o === url.origin)) return false
  return !isTrusted(prefs, url)
}

export type LinkRisk = 'label' | 'lookalike' | 'credentials'

// The whole text is an address, or the text holds one with a scheme or `www.` in front.
const WHOLE_RE = /^(?:https?:\/\/)?((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,})\.?(?::\d+)?(?:[/?#]\S*)?$/iu
const INNER_RE =
  /(?:https?:\/\/((?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,}))|(?:^|[^\p{L}\p{N}.-])(www\.(?:[\p{L}\p{N}-]+\.)+[\p{L}]{2,})/iu

// The host a link's own text names, when it names one.
export const labelHost = (label: string): string | null => {
  const whole = WHOLE_RE.exec(label.trim())
  const inner = whole ? null : INNER_RE.exec(label)
  const host = whole?.[1] ?? inner?.[1] ?? inner?.[2]
  if (!host) return null
  try {
    return new URL(`https://${host}`).hostname.toLowerCase().replace(/^www\./, '')
  } catch {
    return null
  }
}

// What looks off about a link: text that names another site, a host in look-alike (punycode)
// letters, or a name and password in front of the host.
export const linkRisks = (url: URL, label: string | null): LinkRisk[] => {
  const out: LinkRisk[] = []
  const named = label === null ? null : labelHost(label)
  if (named !== null && named !== shownHost(url)) out.push('label')
  if (url.hostname.split('.').some(part => part.startsWith('xn--'))) out.push('lookalike')
  if (url.username || url.password) out.push('credentials')
  return out
}

export const RISK_TEXT: Record<LinkRisk, string> = {
  label: 'The link text points to a different domain than the destination.',
  lookalike: 'This address uses letters that can look like other letters.',
  credentials: 'This address has a name or password in front of the site.',
}

// Query parameters that only follow people from site to site.
const TRACKERS = new Set([
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'gbraid',
  'wbraid',
  'msclkid',
  'mc_cid',
  'mc_eid',
  'igshid',
  'igsh',
  'yclid',
  'twclid',
  'ttclid',
  'li_fat_id',
  '_hsenc',
  '_hsmi',
  'mkt_tok',
  'oly_anon_id',
  'oly_enc_id',
  'vero_id',
  'rb_clickid',
  's_cid',
])

// Parameters that track only on the sites that add them.
const SITE_TRACKERS: [RegExp, string[]][] = [
  [/(^|\.)(youtube\.com|youtu\.be|spotify\.com)$/, ['si', 'feature']],
  [/(^|\.)(x\.com|twitter\.com)$/, ['s', 't', 'ref_src', 'ref_url']],
  [
    /(^|\.)amazon\.[a-z.]+$/,
    ['ref', 'ref_', 'pd_rd_r', 'pd_rd_w', 'pd_rd_wg', 'pf_rd_p', 'pf_rd_r'],
  ],
]

const tracker = (host: string, key: string) => {
  const k = key.toLowerCase()
  if (k.startsWith('utm_') || TRACKERS.has(k)) return true
  return SITE_TRACKERS.some(([site, keys]) => site.test(host) && keys.includes(k))
}

// `url` without its tracking parameters; the same text when it has none.
export const stripLink = (raw: string): string => {
  const url = webLink(raw)
  if (!url || !url.search) return raw
  const host = url.hostname.toLowerCase()
  const parts = url.search.slice(1).split('&')
  const kept = parts.filter(p => {
    const key = decodeURIComponentSafe(p.split('=')[0])
    return key === '' || !tracker(host, key)
  })
  if (kept.length === parts.length) return raw
  const at = raw.indexOf('?')
  const hash = raw.indexOf('#', at)
  const tail = hash < 0 ? '' : raw.slice(hash)
  return raw.slice(0, at) + (kept.length ? `?${kept.join('&')}` : '') + tail
}

const decodeURIComponentSafe = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '))
  } catch {
    return s
  }
}

const URL_RE = /https?:\/\/[^\s<>"'`)\]]+/gi
const TRAIL = /[.,;:!?*_~|'"]+$/

const stripLine = (line: string) =>
  /^( {4}|\t)/.test(line)
    ? line
    : line.replace(URL_RE, found => {
        const trail = TRAIL.exec(found)?.[0] ?? ''
        const link = trail ? found.slice(0, -trail.length) : found
        return stripLink(link) + trail
      })

// A message's text with tracking parameters taken off every web link outside code: fenced
// blocks, inline code and indented lines stay as written.
export const stripTracking = (text: string): string => {
  const parts = text.split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
  return parts
    .map((part, i) => (i % 2 === 1 ? part : part.split('\n').map(stripLine).join('\n')))
    .join('')
}

// What a composer sends: with tracking parameters taken off when the person asked for it.
export const outgoing = (prefs: Pick<LinkPrefs, 'strip'>, text: string) =>
  prefs.strip ? stripTracking(text) : text
