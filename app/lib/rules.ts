import {
  ALL_PERMS,
  type Channel,
  type ConfirmChoice,
  type Member,
  type PasswordMembers,
  type ProfanityTarget,
  type Role,
  type SiteSettings,
} from './types'

export const PROFANITY_TARGETS: { key: ProfanityTarget; label: string }[] = [
  { key: 'messages', label: 'Messages' },
  { key: 'links', label: 'Links in messages' },
  { key: 'usernames', label: 'Usernames' },
  { key: 'server_names', label: 'Server names' },
  { key: 'channel_names', label: 'Channel names' },
  { key: 'role_names', label: 'Role names' },
  { key: 'file_names', label: 'File names' },
]

type ProfanitySettings = Pick<SiteSettings, 'profanity_filter'> & {
  profanity_targets?: Partial<SiteSettings['profanity_targets']>
}

export const profanityTargetOn = (settings: ProfanitySettings, key: ProfanityTarget) =>
  settings.profanity_targets?.[key] ?? true

export const profanityTargetLocked = (settings: ProfanitySettings, key: ProfanityTarget) =>
  !settings.profanity_filter || (key === 'links' && !profanityTargetOn(settings, 'messages'))

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

export type PasswordVerb = 'Set' | 'Change' | 'Clear'

export const passwordPrompt = (
  had: boolean,
  next: string,
  canRemove: boolean,
  siteAdmin: boolean
) => {
  const verb: PasswordVerb = next ? (had ? 'Change' : 'Set') : 'Clear'
  const changed = had && next !== ''
  const choices: ConfirmChoice[] = [
    {
      value: 'keep',
      label: 'Keep everyone',
      detail: changed
        ? 'Current members stay. Guests who entered the old password lose access unless you also keep guest access.'
        : 'Current members stay.',
      danger: false,
    },
  ]
  if (canRemove)
    choices.push({
      value: 'remove',
      label: 'Remove everyone except me',
      detail: [
        `Other members are removed, not banned, and can rejoin${next ? ' with the new password' : ''}.`,
        changed ? 'Guests who entered the old password lose access.' : '',
        siteAdmin ? '' : 'Members with equal or higher permissions stay.',
      ]
        .filter(Boolean)
        .join(' '),
      danger: true,
    })
  return {
    title: `${verb} Password`,
    body: next
      ? 'Joining will require the new password.'
      : 'Anyone will be able to join with the server name.',
    confirm: verb,
    choices,
  }
}

const members = (n: number) => `${n} member${n === 1 ? '' : 's'}`

export const passwordDone = (
  verb: PasswordVerb,
  choice: PasswordMembers,
  removed: number,
  kept: number
) => {
  const head = `Password ${verb === 'Change' ? 'changed' : verb === 'Set' ? 'set' : 'cleared'}.`
  if (choice === 'keep') return `${head} Everyone stayed.`
  const gone = removed ? `Removed ${members(removed)}.` : 'No one was removed.'
  const stayed = kept ? ` ${members(kept)} with equal or higher permissions stayed.` : ''
  return `${head} ${gone}${stayed}`
}

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
