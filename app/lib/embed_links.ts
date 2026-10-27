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

export const postedLinks = (content: string) =>
  content
    .split(/[\s<>]/)
    .map(word => word.replace(/[.,;:!?)\]"']+$/, ''))
    .filter(word => word.startsWith('http://') || word.startsWith('https://'))

export const postedUrl = (content: string, embedUrl: string) =>
  postedLinks(content).find(link => scrubUrl(link) === embedUrl) ?? embedUrl
