import {
  memberExtras,
  PROFILE_FIELDS,
  roomProfile,
  type PlaceProfile,
  type RoomExtras,
} from './profile_fields'
import type { ProfilesMode } from './types'

// Resetting a member's server profile, the same for hosted servers and P2P rooms: the parts a
// moderator can clear, how long the profile then stays locked, and what a lock means now.

export type ResetField = (typeof PROFILE_FIELDS.reset_fields)[number]

export const RESET_FIELDS: readonly ResetField[] = PROFILE_FIELDS.reset_fields

export const RESET_LABELS: Record<ResetField, string> = {
  name: 'Server name',
  bio: 'Description',
  avatar: 'Avatar',
  banner: 'Banner color',
}

export const isResetField = (v: unknown): v is ResetField =>
  (RESET_FIELDS as readonly unknown[]).includes(v)

// A lock choice in seconds: null sets no lock, -1 locks until a moderator lifts it.
export type LockSecs = (typeof PROFILE_FIELDS.lock_secs)[number] | null

export const LOCK_CHOICES: readonly { secs: LockSecs; label: string }[] = [
  { secs: null, label: 'No lock' },
  { secs: 86400, label: '1 day' },
  { secs: 604800, label: '7 days' },
  { secs: 2592000, label: '30 days' },
  { secs: -1, label: 'Until unlocked' },
]

export const isLockSecs = (v: unknown): v is LockSecs =>
  v === null || (PROFILE_FIELDS.lock_secs as readonly unknown[]).includes(v)

// The end of a lock that stays until a moderator lifts it, in unix seconds. A hosted server
// sends a larger number for the same.
export const FOREVER = Number.MAX_SAFE_INTEGER

// When a lock chosen at `now` (unix seconds) ends; null for no lock.
export const lockUntil = (secs: LockSecs, now: number): number | null =>
  secs === null ? null : secs === -1 ? FOREVER : now + secs

// What a lock end means at `now` (unix seconds). `until` is null for a lock with no end.
export type LockState = { locked: false } | { locked: true; until: number | null }

export const lockState = (until: number | null | undefined, now: number): LockState => {
  if (typeof until !== 'number' || !(until > now)) return { locked: false }
  return { locked: true, until: until >= FOREVER ? null : until }
}

// The line a member reads on their own locked server profile.
export const lockLine = (state: LockState, when: (until: number) => string): string | null => {
  if (!state.locked) return null
  const again =
    state.until === null
      ? 'once a moderator unlocks it'
      : `after ${when(state.until)}, or once a moderator unlocks it`
  return `A moderator reset your server profile. You can edit it again ${again}.`
}

// The body of a hosted reset request.
export const resetBody = (fields: readonly ResetField[], secs: LockSecs, reason: string) => ({
  fields: RESET_FIELDS.filter(f => fields.includes(f)),
  ...(secs === null ? {} : { lock_secs: secs }),
  ...(reason.trim() ? { reason: reason.trim() } : {}),
})

// ----- P2P rooms: the `profile_reset` register -----

// The parts a `profile_reset` write lists: all of them when it has no list, the ones this
// version knows otherwise. A list of another type is malformed: the write is not read.
export const resetFields = (fields: unknown): ResetField[] | undefined => {
  if (fields === undefined) return [...RESET_FIELDS]
  if (!Array.isArray(fields)) return undefined
  return RESET_FIELDS.filter(f => fields.includes(f))
}

// The lock end a `profile_reset` write carries: null when it leaves the lock as it is, 0 when
// it lifts it. Anything but a whole number of seconds from 0 up is malformed.
export const resetUntil = (until: unknown): number | null | undefined => {
  if (until === undefined) return null
  return typeof until === 'number' && Number.isSafeInteger(until) && until >= 0 ? until : undefined
}

// Whether the content of a `profile_reset` write is well formed.
export const resetContentOk = (c: { to?: unknown; fields?: unknown; until?: unknown }) =>
  typeof c.to === 'string' &&
  resetFields(c.fields) !== undefined &&
  resetUntil(c.until) !== undefined

// The resets of one member that count in a room: the latest (`last`, an event id), the parts
// they cleared (a reset lists the part and came before or at the same time as the member's
// latest write that carries it), and the lock of the latest one that carries a lock end, with
// the parts that don't show while it runs: the ones it lists, and the ones the member's current
// write changed since their latest write before the lock.
export interface ResetFact {
  last: string
  hide: ResetField[]
  lock?: { until: number; fields: ResetField[] }
}

// The parts of a member's room profile that don't show at `now` (unix seconds): the cleared
// ones, and while the lock runs the lock's parts.
export const hiddenFields = (reset: ResetFact | null | undefined, now: number): ResetField[] => {
  if (!reset) return []
  const locked = lockState(reset.lock?.until, now).locked ? (reset.lock?.fields ?? []) : []
  return RESET_FIELDS.filter(f => reset.hide.includes(f) || locked.includes(f))
}

// The extras each part holds: the avatar is its kind and the picture.
const EXTRA: Record<ResetField, readonly (keyof RoomExtras)[]> = {
  name: ['nick'],
  bio: ['bio'],
  avatar: ['av', 'rpic'],
  banner: ['bn'],
}

const textOf = (v: RoomExtras[keyof RoomExtras]): string | undefined => {
  if (typeof v !== 'object') return v
  return 'kind' in v ? `${v.kind} ${v.bg ?? ''}` : `${v.s[0]} ${v.l[0]} ${v.a?.[0] ?? ''}`
}

// The value of one part of room extras, as text to compare; undefined when it is not set.
export const partOf = (extras: RoomExtras, f: ResetField): string | undefined => {
  const [first, ...more] = EXTRA[f].map(key => textOf(extras[key]))
  if (more.every(t => t === undefined)) return first
  return [first, ...more].map(t => t ?? '').join('\n')
}

// The parts `now` sets to another value than `then`.
export const changedParts = (now: RoomExtras, then: RoomExtras): ResetField[] =>
  RESET_FIELDS.filter(f => partOf(now, f) !== undefined && partOf(now, f) !== partOf(then, f))

const dropPart = (extras: RoomExtras, f: ResetField) => {
  for (const key of EXTRA[f]) delete extras[key]
}

const movePart = (from: RoomExtras, to: RoomExtras, f: ResetField) => {
  dropPart(to, f)
  for (const key of EXTRA[f]) if (from[key] !== undefined) Object.assign(to, { [key]: from[key] })
  dropPart(from, f)
}

// What our device sets for itself in a room (`intent`) and keeps aside (`gone`) under the
// resets that count there. A part a reset cleared from our profile write as the room shows it
// (`written`) goes out of the intent and is kept aside. Once no reset clears it, it comes back,
// unless the intent or the write sets that part again. Null when nothing changes.
export function settleIntent(
  intent: RoomExtras,
  gone: RoomExtras,
  written: RoomExtras,
  reset: ResetFact | null | undefined
): { intent: RoomExtras; gone: RoomExtras } | null {
  const next: RoomExtras = { ...intent }
  const kept: RoomExtras = { ...gone }
  let changed = false
  for (const f of RESET_FIELDS) {
    const mine = partOf(next, f)
    if (reset?.hide.includes(f)) {
      if (mine === undefined || mine !== partOf(written, f)) continue
      movePart(next, kept, f)
      changed = true
    } else if (partOf(kept, f) !== undefined) {
      if (mine === undefined && partOf(written, f) === undefined) movePart(kept, next, f)
      else dropPart(kept, f)
      changed = true
    }
  }
  return changed ? { intent: next, gone: kept } : null
}

// Room extras without the parts `fields` names.
export const withoutFields = (extras: RoomExtras, fields: readonly ResetField[]): RoomExtras => {
  const out: RoomExtras = { ...extras }
  for (const f of fields) dropPart(out, f)
  return out
}

// A member's room extras as they show at `now` under the resets that count.
export const shownExtras = (
  extras: RoomExtras,
  reset: ResetFact | null | undefined,
  now: number
): RoomExtras => withoutFields(extras, hiddenFields(reset, now))

// A room member's profile as the room shows it at `at` (this device's clock, in milliseconds):
// what they wrote in this membership, without what the resets hide, under the room's mode.
export function shownRoomProfile(
  m: { profile?: unknown; joinId?: string; reset?: ResetFact } | undefined,
  mode: ProfilesMode | null | undefined,
  at: number,
  cleanName?: (raw: string) => string
): PlaceProfile {
  const extras = shownExtras(memberExtras(m, cleanName), m?.reset, Math.floor(at / 1000))
  return roomProfile(extras, mode)
}

// Whether the member's own profile is locked in the room at `now`.
export const roomLock = (reset: ResetFact | null | undefined, now: number): LockState =>
  lockState(reset?.lock?.until, now)

// When the first of the locks that run at `now` ends (unix seconds); null when none does.
export const nextLockEnd = (
  resets: Iterable<ResetFact | null | undefined>,
  now: number
): number | null => {
  let next: number | null = null
  for (const r of resets) {
    const state = roomLock(r, now)
    if (state.locked && state.until !== null && (next === null || state.until < next))
      next = state.until
  }
  return next
}

// The content of the `profile_reset` a moderator signs at `now` (unix seconds).
export const resetContent = (
  to: string,
  fields: readonly ResetField[],
  secs: LockSecs,
  now: number
) => {
  const until = lockUntil(secs, now)
  return {
    to,
    fields: RESET_FIELDS.filter(f => fields.includes(f)),
    ...(until === null ? {} : { until }),
  }
}

// The content that lifts a lock: nothing listed, and a lock end that has passed.
export const unlockContent = (to: string) => ({ to, fields: [] as ResetField[], until: 0 })
