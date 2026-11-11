import type { FedService } from './status'

export type LinkState =
  | 'unknown'
  | 'ok'
  | 'degraded'
  | 'unreachable'
  | 'refused_by_them'
  | 'paused'
  | 'halted'
  | 'version'
  | 'unsupported'
  | 'identity'
  | 'blocked'

export type HostRow = {
  host: string
  name: string | null
  version: string | null
  state: LinkState
  notice: string
  last_contact: number | null
  calls_in: number
  calls_out: number
  ours_old: boolean
  services: FedService[]
}

export type Filter =
  'all' | 'attention' | 'blocked' | 'halted' | 'paused' | 'version' | 'unreachable' | 'unsupported'

export const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'blocked', label: 'Blocked' },
  { id: 'halted', label: 'Halted' },
  { id: 'paused', label: 'Paused' },
  { id: 'version', label: 'Version' },
  { id: 'unreachable', label: 'Unreachable' },
  { id: 'unsupported', label: 'Unsupported' },
]

export const SERVICE_FILTERS: { id: FedService | null; label: string }[] = [
  { id: null, label: 'All' },
  { id: 'letters', label: 'Letters' },
  { id: 'invites', label: 'Invites' },
  { id: 'profiles', label: 'Profiles' },
  { id: 'reports', label: 'Reports' },
  { id: 'directory', label: 'Directory' },
]

export const needsAttention = ({ state, ours_old }: Pick<HostRow, 'state' | 'ours_old'>) =>
  state === 'identity' ||
  state === 'halted' ||
  state === 'paused' ||
  (state === 'version' && ours_old)

export const matches = (row: HostRow, filter: Filter, service: FedService | null = null) =>
  (service === null || row.services.includes(service)) &&
  (filter === 'all' || (filter === 'attention' ? needsAttention(row) : row.state === filter))

export const filterCounts = (rows: HostRow[]) =>
  Object.fromEntries(
    FILTERS.map(({ id }) => [id, rows.filter(row => matches(row, id)).length])
  ) as Record<Filter, number>

export const sortRows = (rows: HostRow[]) =>
  [...rows].sort(
    (a, b) =>
      Number(needsAttention(b)) - Number(needsAttention(a)) ||
      (b.last_contact ?? -Infinity) - (a.last_contact ?? -Infinity) ||
      (a.host < b.host ? -1 : a.host > b.host ? 1 : 0)
  )

export type Summary = Partial<
  Record<Exclude<LinkState, 'unknown' | 'ok' | 'unsupported'> | 'version_ours_old', number>
>

export const attentionCount = (counts: Summary) =>
  (counts.identity ?? 0) +
  (counts.halted ?? 0) +
  (counts.paused ?? 0) +
  (counts.version_ours_old ?? 0)

export const attentionLabel = (n: number) =>
  n <= 0 ? null : n === 1 ? '1 instance needs attention' : `${n} instances need attention`

const ERROR = 'bg-error-container text-on-error-container'
const WARN = 'bg-tertiary-container text-on-tertiary-container'
const QUIET = 'bg-surface-container-high text-on-surface-variant'
const FINE = 'bg-secondary-container text-on-secondary-container'

const CHIPS: Record<LinkState, { label: string; tone: string }> = {
  unknown: { label: 'Unknown', tone: QUIET },
  ok: { label: 'OK', tone: FINE },
  degraded: { label: 'Degraded', tone: WARN },
  unreachable: { label: 'Unreachable', tone: WARN },
  refused_by_them: { label: 'Refused by them', tone: WARN },
  paused: { label: 'Paused', tone: WARN },
  halted: { label: 'Halted', tone: ERROR },
  version: { label: 'Version', tone: WARN },
  unsupported: { label: 'Unsupported', tone: QUIET },
  identity: { label: 'Identity', tone: ERROR },
  blocked: { label: 'Blocked', tone: ERROR },
}

export const stateChip = (state: LinkState) => CHIPS[state]

const UTC_TIME = /(\d{2})\/(\d{2}) (\d{2}):(\d{2}) UTC/g
const YEAR = 366 * 86_400

const local = (secs: number, timeZone: string | undefined) => {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(new Date(secs * 1000))
  const part = (type: string) => parts.find(p => p.type === type)?.value ?? ''
  return { date: `${part('month')}/${part('day')}`, time: `${part('hour')}:${part('minute')}` }
}

const utcSecs = (year: number, month: number, day: number, hour: number, minute: number) => {
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute))
  const same = date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  return same && hour < 24 && minute < 60 ? date.getTime() / 1000 : null
}

export const localNotice = (notice: string, now: number, timeZone?: string) =>
  notice.replace(UTC_TIME, (whole, mm: string, dd: string, hh: string, mi: string) => {
    const year = new Date(now * 1000).getUTCFullYear()
    const nearest = [year - 1, year, year + 1]
      .map(y => utcSecs(y, Number(mm), Number(dd), Number(hh), Number(mi)))
      .filter(secs => secs !== null)
      .sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0]
    if (nearest === undefined || Math.abs(nearest - now) > YEAR) return whole
    const { date, time } = local(nearest, timeZone)
    return `${date} ${time}`
  })

export type KeyState = 'current' | 'seal_only' | 'retired' | 'pending'

export type HostKey = {
  kid: string
  first_seen: number
  last_seen: number
  call_key: boolean
  state: KeyState
  proven: boolean
  was: 'retired' | 'seal_only' | null
  proven_hello_at: number | null
  retired_at: number | null
}

const KEY_LABELS: Record<KeyState, string> = {
  current: 'Current',
  seal_only: 'Old seals only',
  retired: 'Retired',
  pending: 'Pending',
}

export const keyLabel = ({ state }: Pick<HostKey, 'state'>) => KEY_LABELS[state]

export const shortKid = (kid: string) =>
  kid.length > 10 ? `${kid.slice(0, 4)}...${kid.slice(-3)}` : kid

export const TRUST_WINDOW = 3600

export type TrustChoice = {
  kid: string
  short: string
  first_seen: number
  kind: 'new' | 'retired' | 'seal_only'
  signed: boolean
  retired_at: number | null
}

export const trustChoices = (keys: HostKey[], now: number): TrustChoice[] =>
  keys
    .filter(key => key.state === 'pending')
    .map(({ kid, first_seen, was, proven_hello_at, retired_at }) => ({
      kid,
      short: shortKid(kid),
      first_seen,
      kind: was ?? ('new' as const),
      signed: proven_hello_at !== null && now - proven_hello_at <= TRUST_WINDOW,
      retired_at,
    }))
    .sort((a, b) => Number(b.signed) - Number(a.signed) || b.first_seen - a.first_seen)

export const trustConfirm = (
  host: string,
  { short, kind, signed, retired_at }: TrustChoice,
  timeZone?: string
) => {
  const on = retired_at === null ? '' : ` on ${local(retired_at, timeZone).date}`
  const line =
    kind === 'retired'
      ? `Re-admit ${short}, a key ${host} retired${on}.`
      : kind === 'seal_only'
        ? `Re-admit ${short}, a key ${host} only published for old seals.`
        : signed
          ? `${host} signed its answer with ${short} just now.`
          : `${short} hasn't signed an answer from ${host} in the last hour. ${host} is asked again first.`
  return { title: `Trust the new key of ${host}?`, line }
}
