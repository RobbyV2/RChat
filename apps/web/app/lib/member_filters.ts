// Member search filters, shared by hosted servers and P2P rooms: the hosted search route gets
// them as its query, and a P2P device runs the same rules over the room's members. Times are
// Unix seconds; `after` bounds include their second and `before` bounds leave it out.

import { Perm } from './types'
import { maskOr } from './perms'

// Any of these opens the member search.
export const MEMBER_SEARCH_PERMS = [
  Perm.Kick,
  Perm.TimeoutMembers,
  Perm.ManageRoles,
  Perm.AssignRoles,
  Perm.ManageProfiles,
].reduce<number>(maskOr, 0)

export const MEMBER_SORTS = [
  'name',
  'joined_desc',
  'joined_asc',
  'created_desc',
  'created_asc',
] as const
export type MemberSort = (typeof MEMBER_SORTS)[number]

export const SORT_LABELS: Record<MemberSort, string> = {
  name: 'Name',
  joined_desc: 'Newest members',
  joined_asc: 'Oldest members',
  created_desc: 'Newest accounts',
  created_asc: 'Oldest accounts',
}

// Characters of search text, and roles one search names, as the hosted route takes them.
export const QUERY_MAX = 32
export const ROLES_MAX = 25

export interface MemberFilters {
  q: string
  roles: string[]
  joinedAfter: number | null
  joinedBefore: number | null
  createdAfter: number | null
  createdBefore: number | null
  via: string | null
  sort: MemberSort
}

export const NO_FILTERS: MemberFilters = {
  q: '',
  roles: [],
  joinedAfter: null,
  joinedBefore: null,
  createdAfter: null,
  createdBefore: null,
  via: null,
  sort: 'name',
}

// What a filter reads of one member. `names` are what the search text matches, `sortName`
// orders them by name and `key` breaks ties.
export interface MemberRow {
  key: string
  names: readonly string[]
  sortName: string
  roles: readonly string[]
  joinedAt: number | null
  createdAt: number | null
  via: string | null
}

// What the filters read of a P2P member: the name it shows, its own name and the nickname it
// set for the server, its roles, when its join was made (seconds) and the code it joined with.
export const p2pMemberRow = (m: {
  ik: string
  name: string
  profileName?: string
  nick?: string
  roles: readonly string[]
  joinedAt?: number
  via?: { id: string }
}): MemberRow => ({
  key: m.ik,
  names: [...new Set([m.name, m.profileName ?? m.name, m.nick ?? m.name])],
  sortName: m.name.toLowerCase(),
  roles: m.roles,
  joinedAt: m.joinedAt === undefined ? null : Math.floor(m.joinedAt / 1000),
  createdAt: null,
  via: m.via?.id ?? null,
})

// The search text as both sides compare it: trimmed, lowercase, without NUL, at most
// `QUERY_MAX` characters.
export const queryText = (raw: string) =>
  [...raw.replace(/\0/g, '').trim().toLowerCase()].slice(0, QUERY_MAX).join('')

export const isSort = (x: unknown): x is MemberSort =>
  typeof x === 'string' && (MEMBER_SORTS as readonly string[]).includes(x)

// Whether anything narrows the list (the sort alone does not).
export const filtering = (f: MemberFilters) =>
  f.q !== '' ||
  f.roles.length > 0 ||
  f.joinedAfter !== null ||
  f.joinedBefore !== null ||
  f.createdAfter !== null ||
  f.createdBefore !== null ||
  f.via !== null

const within = (t: number | null, after: number | null, before: number | null) =>
  (after === null && before === null) ||
  (t !== null && (after === null || t >= after) && (before === null || t < before))

export function matches(f: MemberFilters, r: MemberRow): boolean {
  const q = queryText(f.q)
  return (
    (q === '' || r.names.some(n => n.toLowerCase().includes(q))) &&
    (f.roles.length === 0 || f.roles.some(id => r.roles.includes(id))) &&
    within(r.joinedAt, f.joinedAfter, f.joinedBefore) &&
    within(r.createdAt, f.createdAfter, f.createdBefore) &&
    (f.via === null || r.via === f.via)
  )
}

export const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

// Missing times sort after every time, in both directions.
const byTime = (a: number | null, b: number | null, desc: boolean) =>
  a === b ? 0 : a === null ? 1 : b === null ? -1 : desc ? b - a : a - b

// Ties go by `key`; `byName` orders names (code units by default, as the hosted route orders
// usernames).
export function compareRows(
  sort: MemberSort,
  byName: (a: string, b: string) => number = byKey
): (a: MemberRow, b: MemberRow) => number {
  switch (sort) {
    case 'name':
      return (a, b) => byName(a.sortName, b.sortName) || byKey(a.key, b.key)
    case 'joined_desc':
      return (a, b) => byTime(a.joinedAt, b.joinedAt, true) || byKey(b.key, a.key)
    case 'joined_asc':
      return (a, b) => byTime(a.joinedAt, b.joinedAt, false) || byKey(a.key, b.key)
    case 'created_desc':
      return (a, b) => byTime(a.createdAt, b.createdAt, true) || byKey(b.key, a.key)
    case 'created_asc':
      return (a, b) => byTime(a.createdAt, b.createdAt, false) || byKey(a.key, b.key)
  }
}

// The members `f` keeps, in its order.
export function filterMembers<T>(
  f: MemberFilters,
  items: readonly T[],
  row: (t: T) => MemberRow,
  byName?: (a: string, b: string) => number
) {
  const cmp = compareRows(f.sort, byName)
  return items
    .map(t => ({ t, r: row(t) }))
    .filter(x => matches(f, x.r))
    .sort((a, b) => cmp(a.r, b.r))
    .map(x => x.t)
}

// The hosted search route's query for `f`, without paging.
export function hostedQuery(f: MemberFilters): string {
  const p = new URLSearchParams()
  const q = queryText(f.q)
  if (q) p.set('q', q)
  if (f.roles.length) p.set('roles', f.roles.slice(0, ROLES_MAX).join(','))
  const times: [string, number | null][] = [
    ['joined_after', f.joinedAfter],
    ['joined_before', f.joinedBefore],
    ['created_after', f.createdAfter],
    ['created_before', f.createdBefore],
  ]
  for (const [key, t] of times) if (t !== null) p.set(key, String(Math.floor(t)))
  if (f.via !== null) p.set('via', f.via)
  if (f.sort !== 'name') p.set('sort', f.sort)
  return p.toString()
}

const time = (raw: string | null) => {
  if (raw === null || !/^\d{1,15}$/.test(raw.trim())) return null
  return Number(raw.trim())
}

// Filters from a query `hostedQuery` writes; what it does not know or can't read is left out.
export function parseFilters(query: string | URLSearchParams): MemberFilters {
  const p = typeof query === 'string' ? new URLSearchParams(query) : query
  const roles = [
    ...new Set(
      p
        .getAll('roles')
        .flatMap(v => v.split(','))
        .map(v => v.trim())
        .filter(Boolean)
    ),
  ].slice(0, ROLES_MAX)
  const via = p.get('via')?.trim()
  const sort = p.get('sort')
  return {
    q: queryText(p.get('q') ?? ''),
    roles,
    joinedAfter: time(p.get('joined_after')),
    joinedBefore: time(p.get('joined_before')),
    createdAfter: time(p.get('created_after')),
    createdBefore: time(p.get('created_before')),
    via: via ? via : null,
    sort: isSort(sort) ? sort : 'name',
  }
}

const DAY = 86400

const pad = (n: number) => String(n).padStart(2, '0')

// A day picked in a date field (`YYYY-MM-DD`, local time): when it starts, in Unix seconds.
export function dayStart(day: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day)
  if (!m) return null
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
  return d.getDate() === Number(m[3]) ? Math.floor(d.getTime() / 1000) : null
}

// The date field value of the local day `t` falls in.
export function dayOf(t: number): string {
  const d = new Date(t * 1000)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

// The start of the day after `day`: a range that ends with `day` keeps it.
export function dayEnd(day: string): number | null {
  const start = dayStart(day)
  if (start === null) return null
  return dayStart(dayOf(start + DAY + 3 * 3600))
}

// The last day a `before` bound keeps.
export const lastDay = (before: number) => dayOf(before - 1)

const dayFormats = new Map<string, Intl.DateTimeFormat>()

// The day `t` falls in, as a short date ("Jan 5, 2026").
export function dayLabel(t: number, o: { locale?: string; timeZone?: string } = {}) {
  const id = `${o.locale ?? ''}|${o.timeZone ?? ''}`
  let f = dayFormats.get(id)
  if (!f) {
    f = new Intl.DateTimeFormat(o.locale, { dateStyle: 'medium', timeZone: o.timeZone })
    dayFormats.set(id, f)
  }
  return f.format(t * 1000)
}

export type ChipKind = 'role' | 'joined' | 'created' | 'via'

export interface Chip {
  kind: ChipKind
  // The role id for `role`.
  id?: string
  label: string
}

export interface ChipNames {
  role(id: string): string | null
  via(id: string): string | null
  date(t: number): string
}

const range = (what: string, after: number | null, before: number | null, n: ChipNames) =>
  after !== null && before !== null
    ? `${what} ${n.date(after)} to ${n.date(before - 1)}`
    : after !== null
      ? `${what} since ${n.date(after)}`
      : before !== null
        ? `${what} until ${n.date(before - 1)}`
        : null

// The active filters besides the search text, one removable chip each.
export function chipsOf(f: MemberFilters, n: ChipNames): Chip[] {
  const out: Chip[] = []
  for (const id of f.roles)
    out.push({ kind: 'role', id, label: `Role: ${n.role(id) ?? 'Unknown'}` })
  const joined = range('Joined', f.joinedAfter, f.joinedBefore, n)
  if (joined) out.push({ kind: 'joined', label: joined })
  const created = range('Account made', f.createdAfter, f.createdBefore, n)
  if (created) out.push({ kind: 'created', label: created })
  if (f.via !== null) out.push({ kind: 'via', label: `Joined with: ${n.via(f.via) ?? 'Unknown'}` })
  return out
}

export function dropChip(f: MemberFilters, chip: Pick<Chip, 'kind' | 'id'>): MemberFilters {
  switch (chip.kind) {
    case 'role':
      return { ...f, roles: f.roles.filter(id => id !== chip.id) }
    case 'joined':
      return { ...f, joinedAfter: null, joinedBefore: null }
    case 'created':
      return { ...f, createdAfter: null, createdBefore: null }
    case 'via':
      return { ...f, via: null }
  }
}

export const toggleRole = (f: MemberFilters, id: string): MemberFilters =>
  f.roles.includes(id)
    ? { ...f, roles: f.roles.filter(x => x !== id) }
    : f.roles.length >= ROLES_MAX
      ? f
      : { ...f, roles: [...f.roles, id] }

// Filters a side can't apply dropped: P2P rooms know no account dates, and `via` needs the
// right to manage invites.
export function allowedFilters(
  f: MemberFilters,
  can: { created: boolean; via: boolean }
): MemberFilters {
  const sort = !can.created && f.sort.startsWith('created') ? 'name' : f.sort
  return {
    ...f,
    sort,
    ...(can.created ? {} : { createdAfter: null, createdBefore: null }),
    ...(can.via ? {} : { via: null }),
  }
}
