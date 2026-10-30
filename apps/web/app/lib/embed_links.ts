import { overlapsSpoiler, spoilerParts, spoilerSpans } from './spoilers'

const SECRET_PARAMS = new Set([
  'password',
  'passwd',
  'pass',
  'pwd',
  'token',
  'access_token',
  'refresh_token',
  'id_token',
  'auth',
  'secret',
  'api_key',
  'apikey',
  'key',
  'sig',
  'signature',
  'code',
])

export const scrubUrl = (raw: string): string | null => {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return null
  }
  url.username = ''
  url.password = ''
  url.hash = ''
  const kept = [...url.searchParams].filter(([k]) => {
    const key = k.toLowerCase()
    return !SECRET_PARAMS.has(key) && !key.startsWith('x-amz-')
  })
  url.search = kept.length ? new URLSearchParams(kept).toString() : ''
  return url.toString()
}

const TRAIL = /[.,;:!?)\]"']+$/
const WORD = /[^\s<>]+/g

interface Posted {
  url: string
  spoiler: boolean
}

// Links as posted, in order, and whether each sits in or touches a spoiler. The server reads them
// the same way (`embeds.rs` `extract_urls`) and never fetches previews of spoilered ones.
export const postedLinkSpots = (content: string): Posted[] => {
  const spans = spoilerSpans(content)
  return [...content.matchAll(WORD)]
    .map(m => ({
      url: m[0].replace(TRAIL, ''),
      spoiler: overlapsSpoiler(spans, m.index, m.index + m[0].length),
    }))
    .filter(p => p.url.startsWith('http://') || p.url.startsWith('https://'))
}

export const postedLinks = (content: string) => postedLinkSpots(content).map(p => p.url)

export const postedUrl = (content: string, embedUrl: string) =>
  postedLinks(content).find(link => scrubUrl(link) === embedUrl) ?? embedUrl

const unique = (urls: (string | null)[]) =>
  urls.filter((u, i): u is string => u !== null && urls.indexOf(u) === i)

// Scrubbed links the server fetches previews for (at most `max`, like `MAX_URLS`).
export const previewUrls = (content: string, max = 3) =>
  unique(
    postedLinkSpots(content)
      .filter(p => !p.spoiler)
      .map(p => scrubUrl(p.url))
  ).slice(0, max)

// Scrubbed links that only appear inside spoilers: they get a "Spoiler" card instead of a
// preview, and a preview stored before the link was hidden is not shown.
export const spoileredUrls = (content: string) => {
  const parts = spoilerParts(content)
  const links = (spoiler: boolean) =>
    parts.filter(p => p.spoiler === spoiler).flatMap(p => postedLinks(p.text).map(scrubUrl))
  const shown = new Set(links(false))
  return unique(links(true)).filter(u => !shown.has(u))
}
