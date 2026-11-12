// Links in plugin output. A hook result or a view may not change a link target or image source
// that came from the input, nor add one. Every link a plugin adds opens only through ui.open.

export const OPEN_MAX = 2048

export interface OpenTarget {
  href: string
  scheme: 'https' | 'mailto'
  // The host an https link goes to, or the mail domain of a mailto link's one address.
  site: string
}

// Whitespace, control characters and backslashes can hide where a link goes.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\s\u0000-\u001f\u007f\\]/
const HTTPS = /^https:\/\/[^/?#]/i
const LOCAL = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+$/
const MAIL_PARAMS = ['subject', 'body']
const DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

const parse = (url: string, base?: string): URL | null => {
  try {
    return new URL(url, base)
  } catch {
    return null
  }
}

// What ui.open may open: an https link, or a mailto link to one address, of at most 2,048
// characters.
export const openTarget = (url: unknown): OpenTarget | null => {
  if (typeof url !== 'string' || url.length > OPEN_MAX || UNSAFE.test(url)) return null
  const u = parse(url)
  if (!u) return null
  if (u.protocol === 'https:') {
    if (!HTTPS.test(url) || !u.hostname || u.username || u.password) return null
    return { href: u.href, scheme: 'https', site: u.hostname }
  }
  if (u.protocol !== 'mailto:') return null
  // One address and nothing that adds another, so the site shown is the only one reached.
  let address: string
  try {
    address = decodeURIComponent(u.pathname)
  } catch {
    return null
  }
  const at = address.lastIndexOf('@')
  const site = address.slice(at + 1).toLowerCase()
  const params = Array.from(new URLSearchParams(u.search).keys())
  const one =
    LOCAL.test(address.slice(0, at)) &&
    DOMAIN.test(site) &&
    params.every(k => MAIL_PARAMS.includes(k.toLowerCase()))
  return at > 0 && one ? { href: u.href, scheme: 'mailto', site } : null
}

// The host a link really goes to, as the app shows it beside the link.
export const hostOf = (url: string): string | null => {
  const u = parse(url.trim())
  return u && (u.protocol === 'https:' || u.protocol === 'http:') && u.hostname ? u.hostname : null
}

// One spelling per place, for comparing links.
export const canon = (url: string): string => {
  const text = url.trim()
  return parse(text)?.href ?? text
}

// `kept`: the link was in the input. Otherwise it was changed or added: `marked` when the
// plugin holds ui:open and the link could be opened (it shows as a link marked as changed, with
// its real host), else `text` (it shows as plain text).
export type LinkVerdict = 'kept' | 'text' | 'marked'

export const linkVerdict = (
  url: string,
  input: readonly string[],
  hasOpen: boolean
): LinkVerdict => {
  const key = canon(url)
  if (input.some(i => canon(i) === key)) return 'kept'
  return hasOpen && openTarget(url) ? 'marked' : 'text'
}

// The links of an output that were not in the input, each once, as first written.
export const changedUrls = (input: readonly string[], output: readonly string[]): string[] => {
  const seen = new Set(input.map(canon))
  const out: string[] = []
  for (const url of output) {
    const key = canon(url)
    if (seen.has(key)) continue
    seen.add(key)
    out.push(url)
  }
  return out
}

// The path of a link that stays inside the app at `origin`, or null for one that leaves it. A
// path that resolves to `//host` (`/..//host`) would leave it as an href or a route.
export const internalPath = (url: string, origin: string): string | null => {
  const base = parse(origin)
  if (!base || base.origin === 'null' || UNSAFE.test(url)) return null
  const rooted = url.startsWith('/') && !url.startsWith('//')
  const u = rooted ? parse(url, base.origin) : parse(url)
  if (!u || u.origin !== base.origin || u.pathname.startsWith('//')) return null
  return u.pathname + u.search + u.hash
}
