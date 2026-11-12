import { GROUPS, PER_SERVER, SCOPES, waitingLine } from './consent'

export const APPLICATION_KINDS = ['oauth', 'proxy'] as const
export type ApplicationKind = (typeof APPLICATION_KINDS)[number]
export const kindOk = (k: string): k is ApplicationKind =>
  (APPLICATION_KINDS as readonly string[]).includes(k)

export const capabilities = (
  scopes: readonly string[],
  servers: readonly string[],
  chats: readonly string[]
) => {
  const where = (d: (typeof SCOPES)[number]) => {
    const places = d.servers === 'chats' ? chats : d.servers === 'pick' ? servers : []
    return (d.scope === 'servers' || PER_SERVER.includes(d.scope) || d.servers === 'chats') &&
      places.length
      ? places.join(', ')
      : null
  }
  const held = SCOPES.filter(d => scopes.includes(d.scope))
  return GROUPS.map(group => ({
    group,
    warning: group === 'Strongest',
    lines: held.filter(d => d.group === group).map(d => ({ line: d.line, where: where(d) })),
  })).filter(g => g.lines.length > 0)
}

export const madeByLine = (
  application: { kind: ApplicationKind; madeBy: readonly string[] },
  instanceName: string
) =>
  application.kind === 'proxy'
    ? `Run by ${instanceName}`
    : application.madeBy.length
      ? `Made by ${application.madeBy.join(', ')}`
      : 'No owner'

export const devicesLine = (devices: number) =>
  devices > 0 ? `Signed in on ${devices} ${devices === 1 ? 'device' : 'devices'}` : null

const MENU = [
  { id: 'grant.activity', label: 'What it did as you' },
  { id: 'grant.change', label: 'Change what it can do' },
  { id: 'grant.encrypted', label: 'Give or change encrypted access' },
  { id: 'grant.sign_out', label: 'Sign out everywhere' },
  { id: 'grant.remove', label: 'Remove' },
  { id: 'grant.report', label: 'Report' },
] as const

const PROXY_MENU: readonly string[] = ['grant.sign_out', 'grant.remove', 'grant.report']

export const menu = (holdsKeys: boolean, kind: ApplicationKind) =>
  MENU.filter(m =>
    kind === 'proxy' ? PROXY_MENU.includes(m.id) : m.id !== 'grant.encrypted' || holdsKeys
  )

export const removeConfirm = (name: string) => ({
  title: `Remove ${name}?`,
  text: "It is signed out everywhere, leaves your encrypted chats, and can't use your account. Data it already has is up to the application.",
  option: 'Also delete the webhooks it added',
})

export const ENCRYPTED_REVIEW_SECS = 24 * 3600
export const UNUSED_GRANT_DAYS = 90

export type EncryptedState =
  { state: 'none' | 'on' | 'review' | 'unused' } | { state: 'waiting'; channels: readonly string[] }

export const encryptedNote = (name: string, e: EncryptedState) => {
  switch (e.state) {
    case 'review':
      return { text: `${name} asks to read your encrypted chats`, action: 'Review' }
    case 'unused':
      return {
        text: `${name} no longer reads your encrypted chats. It was not used for ${UNUSED_GRANT_DAYS} days.`,
        action: 'Give access again',
      }
    case 'waiting': {
      const text = waitingLine(e.channels)
      return text ? { text, action: null } : null
    }
    case 'none':
    case 'on':
      return null
  }
}

export const ACTIVITY_PER_GRANT = 10_000
export const ACTIVITY_PER_APPLICATION = 1_000_000
export type ActivityKeep = 'detail' | 'fold_oldest' | 'counts_only'

export const activityKeep = (grantRows: number, applicationRows: number): ActivityKeep =>
  applicationRows >= ACTIVITY_PER_APPLICATION
    ? 'counts_only'
    : grantRows >= ACTIVITY_PER_GRANT
      ? 'fold_oldest'
      : 'detail'

export const activityNote = (keep: ActivityKeep) =>
  keep === 'counts_only' ? 'Only daily counts are kept for this application.' : null

export const readsLine = (places: readonly { place: string; count: number }[], dms: number) => {
  const parts = places
    .filter(p => p.count > 0)
    .map(p => `${p.count} ${p.count === 1 ? 'message' : 'messages'} in ${p.place}`)
  if (dms > 0) parts.push(`${dms} ${dms === 1 ? 'DM' : 'DMs'}`)
  return parts.length ? `Read ${parts.join(', ')}` : null
}
