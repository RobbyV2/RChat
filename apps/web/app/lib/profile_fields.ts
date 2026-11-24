import type { AvatarKind, MemberLook, ProfilesMode } from './types'

// The limits of a server profile, the same for hosted servers and P2P rooms
// (assets/profile_fields.json).
export const PROFILE_FIELDS = {
  name: { max: 32 },
  bio: { max: 190 },
  color: { pattern: '^#[0-9a-fA-F]{6}$' },
  avatar_kinds: ['identicon', 'color'],
  modes: ['all', 'no_names', 'off'],
  reset_fields: ['name', 'bio', 'avatar', 'banner'],
  lock_secs: [86400, 604800, 2592000, -1],
  writes_per_hour: 10,
} as const

const COLOR = new RegExp(PROFILE_FIELDS.color.pattern)

export const isProfilesMode = (v: unknown): v is ProfilesMode =>
  (PROFILE_FIELDS.modes as readonly unknown[]).includes(v)

// The choices of a server's "Server profiles" setting.
export const MODE_LABELS: Record<ProfilesMode, string> = {
  all: 'Everything',
  no_names: 'Everything but names',
  off: 'Off',
}

// Where someone shows: a hosted server by name, or a P2P room by id.
export type Place = { server: string } | { room: string }

// What a P2P member wrote into the room for themselves, next to their global name.
export interface RoomExtras {
  nick?: string
  bio?: string
  av?: { kind: AvatarKind; bg?: string }
  bn?: string
}

// A server profile as a place shows it: the look, and the card's description and banner.
export interface PlaceProfile {
  look: MemberLook | null
  bio: string | null
  banner: string | null
}

const NO_PROFILE: PlaceProfile = { look: null, bio: null, banner: null }

const color = (v: unknown) => (typeof v === 'string' && COLOR.test(v) ? v.toLowerCase() : undefined)

const text = (v: unknown, max: number, clean: (raw: string) => string) => {
  if (typeof v !== 'string') return undefined
  const out = clean(v)
  return out && [...out].length <= max ? out : undefined
}

const trimmed = (raw: string) => raw.trim()

// A description as hosted servers store it and rooms show it: control characters other than
// newlines dropped, trimmed, and runs of more than two newlines cut to two.
export const cleanBio = (text: string) =>
  text
    .replace(/\p{Cc}/gu, c => (c === '\n' ? c : ''))
    .replace(/^\p{White_Space}+|\p{White_Space}+$/gu, '')
    .replace(/\n{3,}/g, '\n\n')

// The extras of a room `profile` write. Each field stands alone: one that is missing, of
// another type, too long or not a color is left out and the others still count. Fields this
// version doesn't know are not read.
export function roomExtras(
  content: unknown,
  cleanName: (raw: string) => string = trimmed
): RoomExtras {
  if (typeof content !== 'object' || content === null) return {}
  const c = content as Record<string, unknown>
  const out: RoomExtras = {}
  const nick = text(c.nick, PROFILE_FIELDS.name.max, cleanName)
  if (nick) out.nick = nick
  const bio = text(c.bio, PROFILE_FIELDS.bio.max, cleanBio)
  if (bio) out.bio = bio
  const av = c.av
  if (typeof av === 'object' && av !== null) {
    const { kind, bg } = av as Record<string, unknown>
    const shade = color(bg)
    if (kind === 'identicon') out.av = shade ? { kind, bg: shade } : { kind }
    if (kind === 'color' && shade) out.av = { kind, bg: shade }
  }
  const bn = color(c.bn)
  if (bn) out.bn = bn
  return out
}

// The extras of a member's latest room `profile` write that count now. A write names the join
// that started the membership it was made in (`in`), so what someone set before they left, were
// removed or joined again shows nothing.
export function memberExtras(
  m: { profile?: unknown; joinId?: string } | undefined,
  cleanName?: (raw: string) => string
): RoomExtras {
  const c = m?.profile
  if (m?.joinId === undefined || typeof c !== 'object' || c === null) return {}
  return (c as { in?: unknown }).in === m.joinId ? roomExtras(c, cleanName) : {}
}

// The mode a room's `profile_mode` write sets; anything else reads as no write.
export const roomMode = (content: unknown): ProfilesMode | undefined => {
  const mode =
    typeof content === 'object' && content !== null ? (content as { mode?: unknown }).mode : null
  return isProfilesMode(mode) ? mode : undefined
}

// A room member's extras as the room shows them under its mode: no nickname under `no_names`,
// nothing under `off`.
export function roomProfile(extras: RoomExtras, mode?: ProfilesMode | null): PlaceProfile {
  if (mode === 'off') return NO_PROFILE
  const name = (mode ?? 'all') === 'all' ? (extras.nick ?? null) : null
  const look: MemberLook = {
    name,
    avatar_kind: extras.av?.kind ?? null,
    avatar_color: extras.av?.bg ?? null,
  }
  return {
    look: look.name === null && look.avatar_kind === null ? null : look,
    bio: extras.bio ?? null,
    banner: extras.bn ?? null,
  }
}

const HOUR_MS = 3_600_000

// The times of this hour's profile writes in a room, and whether one more fits.
export const recentWrites = (times: readonly number[] | undefined, now: number) =>
  (times ?? []).filter(t => now - t < HOUR_MS && t <= now)

export const writeFits = (times: readonly number[] | undefined, now: number) =>
  recentWrites(times, now).length < PROFILE_FIELDS.writes_per_hour

export const sameExtras = (a: RoomExtras, b: RoomExtras) =>
  a.nick === b.nick &&
  a.bio === b.bio &&
  a.bn === b.bn &&
  a.av?.kind === b.av?.kind &&
  a.av?.bg === b.av?.bg
