import { bannerColor } from './profile'
import type { Paged } from './store_types'
import type { Place } from './profile_fields'
import type { Member, MemberLook, ProfilesMode, UserRef } from './types'

export {
  PROFILE_FIELDS,
  isProfilesMode,
  roomExtras,
  roomMode,
  roomProfile,
  type Place,
  type PlaceProfile,
  type RoomExtras,
} from './profile_fields'

// What a look is read from: the hosted member lists under their server's mode and the site's
// switches, and the P2P rooms' admitted profiles.
export interface LookSource {
  members?: Record<string, Paged<Member> | undefined>
  memberInfo?: Record<string, Record<string, Member | null> | undefined>
  servers?: Record<string, { profiles_mode?: ProfilesMode } | undefined>
  settings?: { server_profiles?: boolean; display_names?: boolean }
  roomLook?: (room: string, who: string) => MemberLook | null
}

// Which parts of the looks of a hosted server show: none while the site switch is off or the
// server's mode is `off`, no names under `no_names` or while display names are off.
export interface ShownParts {
  names: boolean
  rest: boolean
}

export function shownParts(
  s: Pick<LookSource, 'servers' | 'settings'>,
  server: string
): ShownParts {
  const mode = s.servers?.[server]?.profiles_mode ?? 'all'
  if (s.settings?.server_profiles === false || mode === 'off') return { names: false, rest: false }
  return { names: mode === 'all' && s.settings?.display_names !== false, rest: true }
}

// Whether `after` shows a part `before` left out: what a server sent then is missing it.
export const showsMore = (before: ShownParts, after: ShownParts) =>
  (after.names && !before.names) || (after.rest && !before.rest)

const partsOf = (look: MemberLook, shown: ShownParts): MemberLook | null => {
  const name = shown.names ? look.name : null
  const kind = shown.rest ? look.avatar_kind : null
  if (name === look.name && kind === look.avatar_kind) return look
  if (name === null && kind === null) return null
  return { name, avatar_kind: kind, avatar_color: kind === null ? null : look.avatar_color }
}

// The look `who` (a username, or an identity key in a room) set for `place`, when it is known
// here. A hosted look that isn't loaded yet reads as none: callers show the account name and
// ask for the member through the batched lookup, never once per event. A hosted look loaded
// before the server's mode or the site's switches changed shows only what they let through.
export function lookOf(s: LookSource, place: Place, who: string): MemberLook | null {
  if ('room' in place) return s.roomLook?.(place.room, who) ?? null
  const known = s.memberInfo?.[place.server]
  const look =
    known && Object.hasOwn(known, who)
      ? known[who]?.profile
      : s.members?.[place.server]?.list.find(m => m.username === who)?.profile
  return look ? partsOf(look, shownParts(s, place.server)) : null
}

// `ref` as a place shows it: the name and avatar of the look over the account's. An explicit
// avatar kind replaces the whole account avatar, color included. The username never changes,
// so the identicon keeps its seed.
export function shownUser<T extends UserRef>(ref: T, look: MemberLook | null | undefined): T {
  if (!look) return ref
  const avatar =
    look.avatar_kind === null
      ? {}
      : { avatar_kind: look.avatar_kind, avatar_color: look.avatar_color }
  return { ...ref, ...(look.name === null ? {} : { display_name: look.name }), ...avatar }
}

// `member` with the look a `member_profile` event carries: null takes the look away.
export function withLook<T extends { profile?: MemberLook }>(
  member: T,
  look: MemberLook | null
): T {
  const { profile: _, ...rest } = member
  return (look ? { ...rest, profile: look } : rest) as T
}

export interface BannerFacts {
  banner_color?: string | null
  server_banner?: string | null
}

// The banner a card opened in a place shows: the place's, else the account's, else the default
// of the avatar shown there (`ref` is the shown user).
export const shownBanner = (
  ref: Pick<UserRef, 'username' | 'avatar_kind' | 'avatar_color'>,
  facts: BannerFacts
) => bannerColor(ref, facts.server_banner ?? facts.banner_color)

export interface BioFacts {
  bio?: string | null
  server_bio?: string | null
}

// The description a card opened in a place shows: the place's, else the account's.
export const shownBio = (_ref: Pick<UserRef, 'username'>, facts: BioFacts) =>
  facts.server_bio || facts.bio || null
