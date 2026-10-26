export interface Qualified {
  name: string
  host: string | null
}

const PORT = /:(\d+)$/
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

export const parseHost = (raw: string): string | null => {
  const text = raw.trim().replace(/\.(?=:\d+$|$)/, '')
  if (!text || /[\s/?#@\\%]/.test(text)) return null
  const port = text.startsWith('[') ? text.match(/\]:(\d+)$/)?.[1] : text.match(PORT)?.[1]
  if (port !== undefined && (Number(port) > 65535 || port.length > 5)) return null
  try {
    const url = new URL(`http://${text}`)
    if (url.pathname !== '/' || url.username || url.password || !url.hostname) return null
    const name = url.hostname
    if (!name.startsWith('[') && !name.split('.').every(l => LABEL.test(l))) return null
    return port === undefined ? name : `${name}:${Number(port)}`
  } catch {
    return null
  }
}

export const normalizeHost = (host: string) => parseHost(host) ?? host.trim().toLowerCase()

export const isHost = (host: string) => parseHost(host) !== null

export const hostOf = (url: string): string | null => {
  try {
    const { host, protocol } = new URL(url)
    return protocol === 'http:' || protocol === 'https:' ? normalizeHost(host) : null
  } catch {
    return null
  }
}

export const parseQualified = (id: string): Qualified => {
  const at = id.lastIndexOf('@')
  const host = at > 0 ? parseHost(id.slice(at + 1)) : null
  return host === null ? { name: id, host: null } : { name: id.slice(0, at), host }
}

export const formatQualified = (name: string, host: string) => `${name}@${normalizeHost(host)}`

export const qualify = (id: string | Qualified, home: string): Qualified => {
  const q = typeof id === 'string' ? parseQualified(id) : id
  return q.host === null ? { name: q.name, host: normalizeHost(home) } : q
}

export const sameQualified = (a: string | Qualified, b: string | Qualified, home: string) => {
  const x = qualify(a, home)
  const y = qualify(b, home)
  return x.name.toLowerCase() === y.name.toLowerCase() && x.host === y.host
}

export const isHomeHost = (host: string | null | undefined, home: string) =>
  host === null || host === undefined || normalizeHost(host) === normalizeHost(home)

export const displayQualified = (id: string | Qualified, home: string) => {
  const q = qualify(id, home)
  return isHomeHost(q.host, home) ? q.name : formatQualified(q.name, q.host as string)
}

export const withInstance = (label: string, host: string | null | undefined, home: string) =>
  isHomeHost(host, home) ? label : `${label} (on ${normalizeHost(host as string)})`

const IPV4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/

const privateV4 = (a: number, b: number) =>
  a === 0 ||
  a === 10 ||
  a === 127 ||
  (a === 169 && b === 254) ||
  (a === 172 && b >= 16 && b < 32) ||
  (a === 192 && b === 168) ||
  (a === 100 && b >= 64 && b < 128)

export function privateHost(hostname: string): boolean {
  const host = hostname.trim().toLowerCase().replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return true
  const v4 = host.match(IPV4)
  if (v4) return privateV4(Number(v4[1]), Number(v4[2]))
  if (!host.startsWith('[') || !host.endsWith(']')) return false
  const ip = host.slice(1, -1)
  if (ip === '::1' || ip === '::') return true
  const dotted = ip.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/)
  if (dotted) return privateV4(Number(dotted[1]), Number(dotted[2]))
  const mapped = ip.match(/^::ffff:([0-9a-f]{1,4}):[0-9a-f]{1,4}$/)
  if (mapped) {
    const high = Number.parseInt(mapped[1], 16)
    return privateV4(high >> 8, high & 255)
  }
  const first = Number.parseInt(ip.split(':')[0] || '0', 16)
  return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80
}
