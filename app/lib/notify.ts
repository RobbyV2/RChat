// Per-account notification settings, kept only in this browser (`rchat_notify:{username|guest}`).
// Rules sit on servers (by name), channels and DMs (by id). A channel without its own level uses
// its server's; a muted server mutes its channels. Expired mutes are ignored and pruned.

export type Level = 'all' | 'mentions' | 'nothing'
export type MuteUntil = number | 'forever'

export interface Rule {
  level?: Level
  muteUntil?: MuteUntil
}

export interface NotifyPrefs {
  v: 1
  servers: Record<string, Rule>
  channels: Record<string, Rule>
  dms: Record<string, Rule>
  desktop: boolean
}

export type NotifyScope =
  | { kind: 'server'; name: string }
  | { kind: 'channel'; id: number; server: string | null }
  | { kind: 'dm'; id: number }

export interface Resolved {
  level: Level
  muted: boolean
}

// Rule tables have no prototype and are read with own-property checks, so an imported document
// with keys like `__proto__` or `constructor` can't reach Object.prototype.
type Rules = Record<string, Rule>

const table = (from?: Rules): Rules => Object.assign(Object.create(null) as Rules, from)

const ruleIn = (rules: Rules, key: string): Rule | undefined =>
  Object.hasOwn(rules, key) ? rules[key] : undefined

export const EMPTY_NOTIFY: NotifyPrefs = {
  v: 1,
  servers: table(),
  channels: table(),
  dms: table(),
  desktop: false,
}

export const DEFAULT_LEVEL = { server: 'mentions', dm: 'all' } as const satisfies Record<
  string,
  Level
>

export const LEVELS: { level: Level; label: string }[] = [
  { level: 'all', label: 'All messages' },
  { level: 'mentions', label: 'Only @mentions' },
  { level: 'nothing', label: 'Nothing' },
]

export const levelLabel = (level: Level) => LEVELS.find(l => l.level === level)?.label ?? level

const MINUTE = 60_000

export const MUTE_CHOICES: { label: string; ms: number | null }[] = [
  { label: '15 minutes', ms: 15 * MINUTE },
  { label: '1 hour', ms: 60 * MINUTE },
  { label: '3 hours', ms: 180 * MINUTE },
  { label: '8 hours', ms: 480 * MINUTE },
  { label: '24 hours', ms: 1440 * MINUTE },
  { label: 'Until I turn it back on', ms: null },
]

export const muteUntilFor = (ms: number | null, now: number): MuteUntil =>
  ms === null ? 'forever' : now + ms

export const notifyKey = (username: string | null) => `rchat_notify:${username ?? 'guest'}`

const isLevel = (x: unknown): x is Level => x === 'all' || x === 'mentions' || x === 'nothing'

const isUntil = (x: unknown): x is MuteUntil =>
  x === 'forever' || (typeof x === 'number' && Number.isFinite(x) && x > 0)

export const muteActive = (until: MuteUntil | undefined, now: number) =>
  until === 'forever' || (typeof until === 'number' && until > now)

const ruleOfJson = (x: unknown, now: number): Rule | null => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const { level, muteUntil } = x as Record<string, unknown>
  const rule: Rule = {}
  if (isLevel(level)) rule.level = level
  if (isUntil(muteUntil) && muteActive(muteUntil, now)) rule.muteUntil = muteUntil
  return rule.level || rule.muteUntil ? rule : null
}

const MAX_RULES = 5000

const rulesOf = (x: unknown, now: number, key: (k: string) => boolean) => {
  const out = table()
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return out
  for (const [k, v] of Object.entries(x).slice(0, MAX_RULES)) {
    const rule = key(k) ? ruleOfJson(v, now) : null
    if (rule) out[k] = rule
  }
  return out
}

const isServerName = (k: string) => k.length > 0 && k.length <= 64 && k !== '__proto__'
const isIdKey = (k: string) => /^[1-9]\d{0,15}$/.test(k)

export const parseNotify = (raw: string | null, now = Date.now()): NotifyPrefs => {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    return EMPTY_NOTIFY
  }
  if (typeof data !== 'object' || data === null) return EMPTY_NOTIFY
  const { v, servers, channels, dms, desktop } = data as Record<string, unknown>
  if (v !== 1) return EMPTY_NOTIFY
  return {
    v: 1,
    servers: rulesOf(servers, now, isServerName),
    channels: rulesOf(channels, now, isIdKey),
    dms: rulesOf(dms, now, isIdKey),
    desktop: desktop === true,
  }
}

export const notifyValue = (p: NotifyPrefs) => JSON.stringify(p)

type Table = 'servers' | 'channels' | 'dms'

const tableOf = (scope: NotifyScope): [Table, string] =>
  scope.kind === 'server'
    ? ['servers', scope.name]
    : scope.kind === 'channel'
      ? ['channels', String(scope.id)]
      : ['dms', String(scope.id)]

export const ownRule = (p: NotifyPrefs, scope: NotifyScope): Rule | undefined => {
  const [t, key] = tableOf(scope)
  return ruleIn(p[t], key)
}

const serverRule = (p: NotifyPrefs, scope: NotifyScope) =>
  scope.kind === 'channel' && scope.server !== null ? ruleIn(p.servers, scope.server) : undefined

// The level that applies when the scope has none of its own.
export const inheritedLevel = (p: NotifyPrefs, scope: NotifyScope): Level =>
  scope.kind === 'dm'
    ? DEFAULT_LEVEL.dm
    : scope.kind === 'channel'
      ? (serverRule(p, scope)?.level ?? DEFAULT_LEVEL.server)
      : DEFAULT_LEVEL.server

export const levelOf = (p: NotifyPrefs, scope: NotifyScope): Level =>
  ownRule(p, scope)?.level ?? inheritedLevel(p, scope)

export const mutedOf = (p: NotifyPrefs, scope: NotifyScope, now: number): boolean =>
  muteActive(ownRule(p, scope)?.muteUntil, now) || muteActive(serverRule(p, scope)?.muteUntil, now)

export const resolve = (p: NotifyPrefs, scope: NotifyScope, now: number): Resolved => ({
  level: levelOf(p, scope),
  muted: mutedOf(p, scope, now),
})

// When the scope's own mute ends, or null when it has none (a muted server is not included).
export const muteEnd = (p: NotifyPrefs, scope: NotifyScope, now: number): MuteUntil | null => {
  const until = ownRule(p, scope)?.muteUntil
  return until !== undefined && muteActive(until, now) ? until : null
}

const putRule = (p: NotifyPrefs, scope: NotifyScope, rule: Rule): NotifyPrefs => {
  const [t, key] = tableOf(scope)
  if (key === '__proto__') return p
  const cur = ruleIn(p[t], key)
  if (cur?.level === rule.level && cur?.muteUntil === rule.muteUntil) return p
  const next = table(p[t])
  const clean: Rule = {}
  if (rule.level) clean.level = rule.level
  if (rule.muteUntil !== undefined) clean.muteUntil = rule.muteUntil
  if (clean.level || clean.muteUntil !== undefined) next[key] = clean
  else if (cur) delete next[key]
  else return p
  return { ...p, [t]: next }
}

// `null` clears the scope's own level. Servers and DMs drop a level equal to their default, so
// only real overrides are stored.
export const setLevel = (p: NotifyPrefs, scope: NotifyScope, level: Level | null): NotifyPrefs => {
  const cur = ownRule(p, scope) ?? {}
  const plain =
    level === null ||
    (scope.kind === 'server' && level === DEFAULT_LEVEL.server) ||
    (scope.kind === 'dm' && level === DEFAULT_LEVEL.dm)
  return putRule(p, scope, { ...cur, level: plain ? undefined : level })
}

export const setMute = (p: NotifyPrefs, scope: NotifyScope, until: MuteUntil | null): NotifyPrefs =>
  putRule(p, scope, { ...(ownRule(p, scope) ?? {}), muteUntil: until ?? undefined })

// Mutes the scope until `until` unless it is already muted for longer (folder mutes).
export const extendMute = (
  p: NotifyPrefs,
  scope: NotifyScope,
  until: MuteUntil,
  now: number
): NotifyPrefs => {
  const end = muteEnd(p, scope, now)
  if (end === 'forever' || (end !== null && until !== 'forever' && end >= until)) return p
  return setMute(p, scope, until)
}

export const resetScope = (p: NotifyPrefs, scope: NotifyScope): NotifyPrefs => putRule(p, scope, {})

export const resetAll = (p: NotifyPrefs): NotifyPrefs => ({ ...EMPTY_NOTIFY, desktop: p.desktop })

export const setDesktop = (p: NotifyPrefs, on: boolean): NotifyPrefs =>
  p.desktop === on ? p : { ...p, desktop: on }

const pruneTable = (rules: Rules, now: number) => {
  let out: Rules | null = null
  for (const [key, rule] of Object.entries(rules)) {
    if (rule.muteUntil === undefined || muteActive(rule.muteUntil, now)) continue
    out ??= table(rules)
    if (rule.level) out[key] = { level: rule.level }
    else delete out[key]
  }
  return out ?? rules
}

// Drops expired mutes (and rules left empty). Returns `p` itself when nothing expired.
export const pruneNotify = (p: NotifyPrefs, now: number): NotifyPrefs => {
  const servers = pruneTable(p.servers, now)
  const channels = pruneTable(p.channels, now)
  const dms = pruneTable(p.dms, now)
  return servers === p.servers && channels === p.channels && dms === p.dms
    ? p
    : { ...p, servers, channels, dms }
}

const keepTable = (rules: Rules, keep: (key: string) => boolean) => {
  let out: Rules | null = null
  for (const key of Object.keys(rules)) {
    if (keep(key)) continue
    out ??= table(rules)
    delete out[key]
  }
  return out ?? rules
}

export interface KeepScopes {
  server: (name: string) => boolean
  channel: (id: number) => boolean
  dm: (id: number) => boolean
}

// Drops rules for scopes the account is no longer in. Returns `p` itself when all are kept.
export const keepScopes = (p: NotifyPrefs, keep: KeepScopes): NotifyPrefs => {
  const servers = keepTable(p.servers, keep.server)
  const channels = keepTable(p.channels, k => keep.channel(Number(k)))
  const dms = keepTable(p.dms, k => keep.dm(Number(k)))
  return servers === p.servers && channels === p.channels && dms === p.dms
    ? p
    : { ...p, servers, channels, dms }
}

// Moves a server's rule to its new name.
export const renameServerRule = (p: NotifyPrefs, from: string, to: string): NotifyPrefs => {
  const rule = ruleIn(p.servers, from)
  if (!rule || from === to || to === '__proto__') return p
  const servers = table(p.servers)
  delete servers[from]
  servers[to] = rule
  return { ...p, servers }
}

// The earliest timed mute still running, for the one expiry timer.
export const nextExpiry = (p: NotifyPrefs, now: number): number | null => {
  let next: number | null = null
  for (const table of [p.servers, p.channels, p.dms])
    for (const { muteUntil } of Object.values(table))
      if (typeof muteUntil === 'number' && muteUntil > now && (next === null || muteUntil < next))
        next = muteUntil
  return next
}

export const hasOverrides = (p: NotifyPrefs) =>
  Object.keys(p.servers).length + Object.keys(p.channels).length + Object.keys(p.dms).length > 0

const sameDay = (a: Date, b: Date) =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate()

export const untilText = (until: MuteUntil, now: number, locale?: string): string => {
  if (until === 'forever') return 'until you turn it back on'
  const at = new Date(until)
  const time = at.toLocaleTimeString(locale, { hour: 'numeric', minute: '2-digit' })
  if (sameDay(at, new Date(now))) return `until ${time}`
  const day = at.toLocaleDateString(locale, { month: 'short', day: 'numeric' })
  return `until ${day}, ${time}`
}

export const mutedText = (until: MuteUntil, now: number, locale?: string) =>
  `Muted ${untilText(until, now, locale)}`

// One line for a stored rule, e.g. "Only @mentions, muted until 4:30 PM".
export const ruleSummary = (rule: Rule, now: number, locale?: string): string => {
  const parts: string[] = []
  if (rule.level) parts.push(levelLabel(rule.level))
  if (rule.muteUntil !== undefined && muteActive(rule.muteUntil, now))
    parts.push(
      parts.length
        ? `muted ${untilText(rule.muteUntil, now, locale)}`
        : mutedText(rule.muteUntil, now, locale)
    )
  return parts.join(', ') || 'Default'
}

// The rule for a channel/DM key ("c12", "d5") with the server it belongs to.
export const scopeOfKey = (key: string, server: string | null): NotifyScope | null => {
  const id = Number(key.slice(1))
  if (!Number.isSafeInteger(id) || id <= 0) return null
  if (key[0] === 'c') return { kind: 'channel', id, server }
  if (key[0] === 'd') return { kind: 'dm', id }
  return null
}

// Whether a ping counts toward badges: everything except scopes set to "Nothing".
export const pingShown = (p: NotifyPrefs, scope: string, server: string | null) => {
  const s = scopeOfKey(scope, server)
  return s === null || levelOf(p, s) !== 'nothing'
}

// Whether an unread scope shows its dot: hidden while muted.
export const unreadShown = (p: NotifyPrefs, scope: string, server: string | null, now: number) => {
  const s = scopeOfKey(scope, server)
  return s === null || !mutedOf(p, s, now)
}

// Whether a plain message (not a ping for you) toasts: only under "All messages", unmuted, and
// not while you are reading that scope at the bottom.
export const messageAlert = (rule: Resolved, watched: boolean) =>
  rule.level === 'all' && !rule.muted && !watched

// Whether a ping toasts. Muted scopes and "Nothing" never do; the badge rule is `pingShown`.
export const pingToast = (rule: Resolved) => !rule.muted && rule.level !== 'nothing'
