export type ScopeDef = {
  scope: string
  line: string
  part: 1 | 2
  group: string
  strong: boolean
  required: boolean
  servers: 'none' | 'pick' | 'join' | 'channel' | 'chats'
  fromClient?: boolean
  stepUp?: boolean
}

export const SCOPES: readonly ScopeDef[] = [
  {
    scope: 'openid',
    line: 'Know it is you',
    part: 1,
    group: 'You',
    strong: false,
    required: true,
    servers: 'none',
  },
  {
    scope: 'profile',
    line: 'See your username, display name and avatar',
    part: 1,
    group: 'You',
    strong: false,
    required: true,
    servers: 'none',
  },
  {
    scope: 'servers',
    line: 'See the servers you pick',
    part: 1,
    group: 'Servers',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'servers.members.read',
    line: 'See your roles and join date in those servers',
    part: 1,
    group: 'Servers',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'servers.join',
    line: 'Join and leave servers for you',
    part: 1,
    group: 'Servers',
    strong: false,
    required: false,
    servers: 'join',
  },
  {
    scope: 'webhook.incoming',
    line: 'Post in a channel you manage',
    part: 1,
    group: 'Servers',
    strong: false,
    required: false,
    servers: 'channel',
  },
  {
    scope: 'offline_access',
    line: 'Stay signed in when you are away',
    part: 1,
    group: 'You',
    strong: false,
    required: false,
    servers: 'none',
  },
  {
    scope: 'admin',
    line: 'Run this site as its admin. This tells the app you are one',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'none',
    stepUp: true,
  },
  {
    scope: 'encrypted.read',
    line: 'Read the encrypted chats you pick',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'chats',
    fromClient: true,
    stepUp: true,
  },
  {
    scope: 'encrypted.send',
    line: 'Send in the encrypted chats you pick, as you',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'chats',
    fromClient: true,
    stepUp: true,
  },
  {
    scope: 'messages.send',
    line: 'Send, edit and delete your own messages and reactions',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'dms.send',
    line: 'Send direct messages as you',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'none',
  },
  {
    scope: 'moderation',
    line: "Kick, ban, time out, pin and remove others' messages as you",
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'dms.read',
    line: 'Read your direct messages',
    part: 2,
    group: 'Strongest',
    strong: true,
    required: false,
    servers: 'none',
  },
  {
    scope: 'messages.read',
    line: "Read messages and your notifications, other people's messages too",
    part: 2,
    group: 'Messages',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'servers.read',
    line: 'See channels, members and the profiles you can see',
    part: 2,
    group: 'Servers and channels',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'servers.manage',
    line: 'Create and change servers, channels, roles and webhooks as you',
    part: 2,
    group: 'Servers and channels',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'friends',
    line: 'See and manage your friends, requests and blocks',
    part: 2,
    group: 'People',
    strong: false,
    required: false,
    servers: 'none',
  },
  {
    scope: 'files',
    line: 'Upload files as you',
    part: 2,
    group: 'Files and calls',
    strong: false,
    required: false,
    servers: 'none',
  },
  {
    scope: 'calls',
    line: 'Join voice channels and calls as you',
    part: 2,
    group: 'Files and calls',
    strong: false,
    required: false,
    servers: 'pick',
  },
  {
    scope: 'realtime',
    line: 'Get live updates of what it can see',
    part: 2,
    group: 'Files and calls',
    strong: false,
    required: false,
    servers: 'none',
  },
  {
    scope: 'account',
    line: 'Change your profile, status and privacy settings',
    part: 2,
    group: 'Account',
    strong: false,
    required: false,
    servers: 'none',
  },
]

export const GROUPS = [
  'Strongest',
  'You',
  'Servers',
  'Messages',
  'Servers and channels',
  'People',
  'Files and calls',
  'Account',
]

const SHORT: Record<string, string> = {
  'servers.members.read': 'See your roles',
  'messages.send': 'Send messages',
  moderation: 'Moderate',
  'messages.read': 'Read messages',
  'servers.read': 'See channels and members',
  'servers.manage': 'Manage servers',
  calls: 'Join calls',
}

export const ADMIN_NOTE = 'Only allow this for a tool this site runs or trusts.'
export const ENCRYPTED_NOTES = ['Everyone in those chats will see it.']
export const encryptedMoveNote = (name: string) =>
  `If a channel starts sharing keys with channels you didn't pick, ${name} stops reading it until you allow it again.`
export const FINISH_ELSEWHERE = 'Finish encrypted access on one of your devices.'

export const scopeDef = (s: string) => SCOPES.find(d => d.scope === s)
export const PER_SERVER = SCOPES.filter(s => s.servers === 'pick' && s.scope !== 'servers').map(
  s => s.scope
)

export type ApplicationScopes = { allowed: string[]; optional: string[] }

export const isOptional = (application: ApplicationScopes, s: string) =>
  s === 'admin' || (!scopeDef(s)?.required && application.optional.includes(s))

export const defaultTicked = (s: string) => !scopeDef(s)?.strong

export const consentOrder = (asked: readonly string[], isSiteAdmin: boolean) => {
  const defs = SCOPES.filter(d => asked.includes(d.scope) && (d.scope !== 'admin' || isSiteAdmin))
  return GROUPS.map(group => ({ group, lines: defs.filter(d => d.group === group) })).filter(
    g => g.lines.length > 0
  )
}

export const normalizeTicks = (ticked: readonly string[]): string[] => {
  const out = new Set(ticked)
  if (PER_SERVER.some(s => out.has(s))) out.add('servers')
  return [...out]
}

export const initialTicks = (
  asked: readonly string[],
  application: ApplicationScopes,
  isSiteAdmin: boolean
) =>
  normalizeTicks(
    consentOrder(asked, isSiteAdmin)
      .flatMap(g => g.lines.map(d => d.scope))
      .filter(s => s !== 'admin' && (!isOptional(application, s) || defaultTicked(s)))
      .sort((a, b) => asked.indexOf(a) - asked.indexOf(b))
  )

export const serversLock = (ticked: readonly string[]) => {
  const neededBy = ticked.filter(s => PER_SERVER.includes(s)).map(s => SHORT[s])
  return { locked: neededBy.length > 0, neededBy }
}

export const toggle = (
  ticked: readonly string[],
  scope: string,
  on: boolean,
  application: ApplicationScopes
): string[] => {
  const same = [...ticked]
  if (!scopeDef(scope) || !application.allowed.includes(scope)) return same
  if (!isOptional(application, scope)) return same
  if (on) return normalizeTicks([...ticked, scope])
  if (scope === 'servers' && serversLock(ticked).locked) return same
  return ticked.filter(s => s !== scope)
}

export const needsStepUp = (ticked: readonly string[]) =>
  ticked.some(s => scopeDef(s)?.stepUp === true)

export type Line = {
  scope: string
  line: string
  checkbox: boolean
  ticked: boolean
  locked: boolean
  stepUp: boolean
  note: string | null
}

export const consentLines = (
  asked: readonly string[],
  application: ApplicationScopes,
  ticked: readonly string[],
  isSiteAdmin: boolean,
  picks: readonly string[]
) => {
  const lock = serversLock(ticked)
  const note = (d: ScopeDef) => {
    if (d.scope === 'admin') return ADMIN_NOTE
    if (d.scope === 'encrypted.read') return ENCRYPTED_NOTES[0]
    if (d.scope === 'servers') return lock.locked ? `Needed by: ${lock.neededBy.join(', ')}` : null
    return PER_SERVER.includes(d.scope) && picks.length ? `In: ${picks.join(', ')}` : null
  }
  return consentOrder(asked, isSiteAdmin).map(g => ({
    group: g.group,
    warning: g.group === 'Strongest',
    lines: g.lines.map((d): Line => ({
      scope: d.scope,
      line: d.line,
      checkbox: isOptional(application, d.scope),
      ticked: ticked.includes(d.scope),
      locked: d.scope === 'servers' && lock.locked,
      stepUp: d.stepUp === true,
      note: note(d),
    })),
  }))
}

export const joinLines = (joinServers: readonly string[]) =>
  joinServers.length ? joinServers.map(s => `Join ${s} for you`) : ['Any server you could join']

export const allowLabel = (name: string) => `Allow ${name}`
export const returnLine = (host: string) => `You'll go back to ${host}`

export type ServerFact = { key: string; visibility: 'public' | 'private' | 'encrypted' }

export const defaultPicks = (servers: readonly ServerFact[]) =>
  servers.map(s => ({
    key: s.key,
    ticked: s.visibility === 'public',
    disabled: s.visibility === 'encrypted',
  }))

export const cleanPicks = (servers: readonly ServerFact[], picked: readonly string[]) => {
  const ok = new Set(servers.filter(s => s.visibility !== 'encrypted').map(s => s.key))
  return [...new Set(picked)].filter(k => ok.has(k))
}

export type Grant = {
  scopes: string[]
  servers: string[] | null
  joins: string[]
  hosts: string[]
  applicationRev: number
  revoked: boolean
}

export type Ask = {
  scopes: string[]
  servers: string[]
  joins: string[]
  host: string
  applicationRev: number
  webhook: boolean
  fromClient: boolean
}

const live = (g: Grant | null, a: Ask): g is Grant =>
  !!g && !g.revoked && g.applicationRev === a.applicationRev && g.hosts.includes(a.host)

export const covers = (g: Grant | null, a: Ask) => {
  if (!live(g, a) || a.webhook || a.fromClient || a.scopes.includes('admin')) return false
  const servers = g.servers
  return (
    a.scopes.every(s => g.scopes.includes(s)) &&
    (servers === null || a.servers.every(s => servers.includes(s))) &&
    a.joins.every(s => g.joins.includes(s))
  )
}

export const diff = (g: Grant | null, a: Ask) => {
  const had = live(g, a) ? g.scopes : []
  return {
    added: a.scopes.filter(s => !had.includes(s)),
    kept: a.scopes.filter(s => had.includes(s)),
  }
}

export type Seen = {
  accounts: number
  chosen: boolean
  grantCovers: boolean
  authAge: number | null
  totpOn: boolean
  sessionTwoKinds: boolean
  restricted: boolean
  webhook: boolean
}

export type Outcome =
  | { kind: 'auto' }
  | {
      kind: 'error'
      error:
        | 'login_required'
        | 'consent_required'
        | 'account_selection_required'
        | 'interaction_required'
    }
  | { kind: 'show'; reauth: boolean; pick: boolean; secondFactor: boolean }

export const decide = (
  prompt: ReadonlySet<string>,
  maxAge: number | null,
  wants2fa: boolean,
  s: Seen
): Outcome => {
  const stale = maxAge !== null && (s.authAge === null || s.authAge > maxAge)
  const reauth = prompt.has('login') || stale
  const secondFactor = wants2fa && s.totpOn && !s.sessionTwoKinds
  const pick = prompt.has('select_account') || (s.accounts > 1 && !s.chosen)
  if (prompt.has('none')) {
    if (s.accounts === 0) return { kind: 'error', error: 'login_required' }
    if (!s.chosen) return { kind: 'error', error: 'account_selection_required' }
    if (stale || secondFactor) return { kind: 'error', error: 'login_required' }
    if (s.restricted) return { kind: 'error', error: 'interaction_required' }
    if (!s.grantCovers || s.webhook) return { kind: 'error', error: 'consent_required' }
    return { kind: 'auto' }
  }
  const silent =
    !reauth &&
    !pick &&
    !secondFactor &&
    !s.restricted &&
    !s.webhook &&
    s.grantCovers &&
    !prompt.has('consent') &&
    s.accounts > 0
  return silent
    ? { kind: 'auto' }
    : { kind: 'show', reauth, pick: pick || s.accounts === 0, secondFactor }
}

export const deviceLine = (live: number, cap: number) =>
  live >= cap
    ? `You have ${live} of ${cap} encryption devices. Remove one first.`
    : `This adds an encryption device: ${live + 1} of ${cap}.`

export type GroupView = { group: string; channels: { id: number; name: string }[] }

export const pickLine = (g: GroupView) =>
  `These channels share keys: ${g.channels.map(c => `#${c.name}`).join(', ')}`

export const waitingLine = (channels: readonly string[]) =>
  channels.length ? `Waiting for members to update: ${channels.map(c => `#${c}`).join(', ')}` : null

export const canGrantHere = (c: { holdsKeys: boolean; online: boolean }): 'here' | 'elsewhere' =>
  c.holdsKeys && c.online ? 'here' : 'elsewhere'
