import { actParts } from './p2p/flows'
import { hasBit, moved } from './perms'
import type { PermItem } from './perm_source'
import { REASON_MAX, reasonOf } from './reasons'

export { REASON_MAX, reasonOf }

// Audit entries of hosted servers and the moderation log of P2P rooms read the same way: the
// reason a moderator gave, which permissions a change turned on and off, and the roles a run of
// moves placed.

// A moderator's reason as the content of a P2P change carries it: none when blank.
export const reasonField = (reason?: string | null): { reason?: string } => {
  const text = reasonOf(reason)
  return text ? { reason: text } : {}
}

export interface PermsDiff {
  added: string[]
  removed: string[]
}

// The names of the permissions in `bits`, as `items` label them.
export const bitNames = (bits: bigint, items: readonly PermItem[]) =>
  items.filter(i => hasBit(bits, i.bit)).map(i => i.label)

// What a change of permissions from `before` to `after` turns on and off, by name.
export const diffOf = (before: bigint, after: bigint, items: readonly PermItem[]): PermsDiff => ({
  added: items.filter(i => hasBit(after, i.bit) && !hasBit(before, i.bit)).map(i => i.label),
  removed: items.filter(i => hasBit(before, i.bit) && !hasBit(after, i.bit)).map(i => i.label),
})

const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []

// A stored `perms_diff` (registry names) read defensively, labelled by `items` where they name
// the permission; null when it holds neither list.
export const permsDiffOf = (v: unknown, items: readonly PermItem[] = []): PermsDiff | null => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  if (!Array.isArray(o.added) && !Array.isArray(o.removed)) return null
  const label = (name: string) => items.find(i => i.name === name)?.label ?? name
  return { added: strings(o.added).map(label), removed: strings(o.removed).map(label) }
}

// A diff as label and value pairs, empty sides left out.
export const diffFacts = (d: PermsDiff): [string, string][] => [
  ...(d.added.length ? [['Permissions added', d.added.join(', ')] as [string, string]] : []),
  ...(d.removed.length ? [['Permissions removed', d.removed.join(', ')] as [string, string]] : []),
]

// One admitted ACL event of a P2P room as the moderation log lists it. `order`: for a role
// move, the roles (highest first) just before and just after it. `undone`: it is not in force.
export interface LogEvent {
  id: string
  t: string
  // The author's identity key, when it happened (ms), and its admission number.
  a: string
  at: number
  c: Record<string, unknown>
  aseq: number
  order?: { before: string[]; after: string[] }
  undone?: boolean
}

// A line of the moderation log: what was done, to whom or what, why, and what changed. `run`:
// how many events of one author it stands for.
export interface LogLine {
  id: string
  a: string
  at: number
  act: string
  target: string | null
  targetKind: 'member' | 'role' | 'channel' | null
  reason: string | null
  facts: [string, string][]
  run: number
  undone: boolean
}

export interface LogNames {
  member: (ik: string) => string
  // A role's or a channel's (or category's) name as shown here, or null when it is gone.
  role: (id: string) => string | null
  channel: (id: string) => string | null
  // A name the event itself carries, as shown here (the display filter).
  text: (name: string) => string
  // The room's permissions, in wire bits, as the log names them.
  items: readonly PermItem[]
  // The longest reason shown.
  reasonMax?: number
}

// Changes of one author closer together than this read as one.
export const RUN_MS = 60_000

const text = (v: unknown) => (typeof v === 'string' ? v : null)

const wire = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) ? BigInt(v) : 0n)

const roleName = (id: string, n: LogNames) =>
  id === 'everyone' ? '@everyone' : (n.role(id) ?? 'Deleted role')

const subjectName = (subj: string, n: LogNames) =>
  subj.startsWith('r:')
    ? roleName(subj.slice(2), n)
    : subj.startsWith('u:')
      ? n.member(subj.slice(2))
      : subj

// A channel's or category's name: as it is now, else as the event names it.
const placeName = (id: string | null, named: unknown, n: LogNames, hash: boolean) => {
  if (!id) return null
  const now = n.channel(id)
  if (now) return now
  const was = text(named)
  return was ? `${hash ? '#' : ''}${n.text(was)}` : 'Deleted channel'
}

const lineOf = (e: LogEvent, n: LogNames): LogLine => {
  const to = text(e.c.to)
  const role = text(e.c.role)
  const { act } = actParts(e.t, to ?? undefined)
  const base = {
    id: e.id,
    a: e.a,
    at: e.at,
    act,
    reason: reasonOf(e.c.reason, n.reasonMax),
    facts: [] as [string, string][],
    run: 1,
    undone: e.undone === true,
  }
  const member = { target: to ? n.member(to) : null, targetKind: to ? ('member' as const) : null }
  const ofRole = (id: string | null) => ({
    target: id ? roleName(id, n) : null,
    targetKind: id ? ('role' as const) : null,
  })
  switch (e.t) {
    case 'assign':
    case 'revoke':
      return { ...base, ...member, facts: role ? [['Role', roleName(role, n)]] : [] }
    case 'role_create': {
      const now = n.role(e.id)
      const named = text(e.c.name)
      return {
        ...base,
        target: now ?? (named ? n.text(named) : 'Deleted role'),
        targetKind: 'role',
      }
    }
    case 'role_del':
    case 'role_meta':
    case 'role_move':
      return { ...base, ...ofRole(role) }
    case 'role_bits': {
      const bit = wire(e.c.bit)
      const on = e.c.on === true
      return {
        ...base,
        ...ofRole(role),
        facts: diffFacts(diffOf(on ? 0n : bit, on ? bit : 0n, n.items)),
      }
    }
    case 'chperm': {
      const subj = text(e.c.subj)
      const allow = bitNames(wire(e.c.allow), n.items)
      const deny = bitNames(wire(e.c.deny), n.items)
      const target = placeName(text(e.c.ch), null, n, false)
      return {
        ...base,
        target,
        targetKind: target ? 'channel' : null,
        facts: [
          ...(subj ? [['For', subjectName(subj, n)] as [string, string]] : []),
          ...(allow.length ? [['Allowed', allow.join(', ')] as [string, string]] : []),
          ...(deny.length ? [['Denied', deny.join(', ')] as [string, string]] : []),
          ...(!allow.length && !deny.length ? [['Rule', 'Removed'] as [string, string]] : []),
        ],
      }
    }
    case 'channel':
    case 'category': {
      const target = placeName(text(e.c.id), e.c.name, n, e.t === 'channel')
      return { ...base, target, targetKind: target ? 'channel' : null }
    }
    case 'chcat': {
      const target = placeName(text(e.c.ch), null, n, false)
      const cat = text(e.c.cat)
      return {
        ...base,
        target,
        targetKind: target ? 'channel' : null,
        facts: [['Category', cat ? (n.channel(cat) ?? 'Deleted category') : 'None']],
      }
    }
    default:
      return { ...base, ...member }
  }
}

// Changes of one author close together that read as one: permission changes of one role, moves
// of roles, and the same rule written to a category and the channels that copy it.
const joins = (a: LogEvent, b: LogEvent) =>
  a.a === b.a &&
  a.t === b.t &&
  Math.abs(a.at - b.at) <= RUN_MS &&
  ((a.t === 'role_bits' && a.c.role === b.c.role) ||
    a.t === 'role_move' ||
    (a.t === 'chperm' &&
      a.c.subj === b.c.subj &&
      wire(a.c.allow) === wire(b.c.allow) &&
      wire(a.c.deny) === wire(b.c.deny)))

// The roles whose places changed between two orders (highest first), through the shared rules.
const movedRoles = (before: readonly string[], after: readonly string[]) => {
  const ids = [...new Set([...before, ...after])]
  const at = new Map(ids.map((id, i) => [id, i]))
  return moved(
    before.map(id => at.get(id)!),
    after.map(id => at.get(id)!)
  ).map(i => ids[i])
}

// The moderation log's lines for `events`, newest first as they are given.
export function logLines(events: readonly LogEvent[], n: LogNames): LogLine[] {
  const out: LogLine[] = []
  let i = 0
  while (i < events.length) {
    const first = events[i]
    let j = i + 1
    while (j < events.length && joins(events[j - 1], events[j])) j++
    const run = events.slice(i, j)
    const reasons = [...new Set(run.flatMap(e => reasonOf(e.c.reason, n.reasonMax) ?? []))]
    const own = lineOf(first, n)
    const line = {
      ...own,
      reason: reasons.length ? reasons.join('; ') : null,
      run: run.length,
      undone: run.every(e => e.undone === true),
    }
    const last = run[run.length - 1]
    if (run.length > 1 && first.t === 'role_bits') {
      // Each bit as the run leaves it (its newest event) against before it (its oldest event
      // turned it over).
      let added = 0n
      let removed = 0n
      for (const bit of new Set(run.map(e => wire(e.c.bit)))) {
        const of = run.filter(e => wire(e.c.bit) === bit)
        const after = of[0].c.on === true
        const before = of[of.length - 1].c.on !== true
        if (after && !before) added |= bit
        if (!after && before) removed |= bit
      }
      const diff = { added: bitNames(added, n.items), removed: bitNames(removed, n.items) }
      out.push({ ...line, facts: diffFacts(diff) })
    } else if (first.t === 'role_move' && first.order && last.order) {
      const roles = movedRoles(last.order.before, first.order.after)
      out.push({
        ...line,
        ...(roles.length === 1 ? { target: roleName(roles[0], n), targetKind: 'role' } : {}),
        ...(roles.length !== 1
          ? {
              target: null,
              targetKind: null,
              facts: [['Roles moved', roles.map(r => roleName(r, n)).join(', ') || 'None']],
            }
          : {}),
      } as LogLine)
    } else if (run.length > 1 && first.t === 'chperm') {
      const head = lineOf(last, n)
      out.push({
        ...line,
        target: head.target,
        targetKind: head.targetKind,
        facts: [
          ...head.facts,
          ['Also in', run.length === 2 ? '1 more channel' : `${run.length - 1} more channels`],
        ],
      })
    } else out.push(line)
    i = j
  }
  return out
}
