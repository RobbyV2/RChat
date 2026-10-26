import { ALL_PERMS, type Channel, type Member, type Role } from './types'

export const NAME_MAX = 100
export const MESSAGE_MAX = 4000
export const SLOWMODE_MAX = 21600

export const charCount = (text: string) => Array.from(text).length

export const canDeleteChannel = (channels: Channel[], channel: Channel) =>
  channels.length > 1 &&
  (channel.kind !== 'text' || channels.filter(c => c.kind === 'text').length > 1)

export const memberPerms = (
  member: Pick<Member, 'is_admin' | 'perms' | 'role_ids'> | null | undefined,
  roles: Pick<Role, 'id' | 'perms'>[]
) => {
  if (!member) return 0
  if (member.is_admin) return member.perms === 0 ? ALL_PERMS : member.perms & ALL_PERMS
  return (
    roles.filter(r => member.role_ids.includes(r.id)).reduce((acc, r) => acc | r.perms, 0) &
    ALL_PERMS
  )
}

export const canModerate = (perms: number, siteAdmin: boolean, target: number) =>
  siteAdmin || ((target & ~perms) === 0 && target !== perms)

export const serverInitial = (name: string) => {
  const trimmed = name.trim()
  const first =
    typeof Intl !== 'undefined' && 'Segmenter' in Intl
      ? new Intl.Segmenter().segment(trimmed)[Symbol.iterator]().next().value?.segment
      : Array.from(trimmed)[0]
  return first ? first.toUpperCase() : '?'
}

export const sameOriginImage = (src: string | undefined, base: string, origins: string[]) => {
  if (!src) return false
  try {
    const url = new URL(src, base)
    return (url.protocol === 'http:' || url.protocol === 'https:') && origins.includes(url.origin)
  } catch {
    return false
  }
}

const UNITS: [number, string][] = [
  [1, 'second'],
  [60, 'minute'],
  [3600, 'hour'],
  [86400, 'day'],
]

export const expiryText = (seconds: number) => {
  if (seconds <= 0) return 'Expired'
  let unit = 0
  while (
    unit < UNITS.length - 1 &&
    Math.round(seconds / UNITS[unit][0]) >= UNITS[unit + 1][0] / UNITS[unit][0]
  )
    unit += 1
  const [mult, label] = UNITS[unit]
  const n = Math.max(1, Math.round(seconds / mult))
  return `Expires in ${n} ${label}${n === 1 ? '' : 's'}`
}

export const mediaError = (e: unknown, device: 'microphone' | 'camera', purpose: string) => {
  const name = typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : ''
  switch (name) {
    case 'NotAllowedError':
    case 'SecurityError':
      return new Error(`Allow ${device} access to ${purpose}`)
    case 'NotFoundError':
    case 'OverconstrainedError':
      return new Error(`No ${device} found`)
    case 'NotReadableError':
      return new Error(`Your ${device} is busy in another app`)
    default:
      return e instanceof Error ? e : new Error(String(e))
  }
}
