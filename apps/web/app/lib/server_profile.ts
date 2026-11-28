import type { P2pPic } from './p2p/pictures'
import { nameWithUsername } from './display_name'
import { shownUser, type ShownPerson } from './people'
import { bannerColor } from './profile'
import type { Paged } from './store_types'
import { isWebhookAuthor } from './webhooks'
import type { Place } from './profile_fields'
import type { AvatarKind, Member, MemberLook, ProfilesMode, UserRef } from './types'

export { shownUser }
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
  // Your servers: the mode of one whose detail isn't loaded.
  me?: { servers: readonly { name: string; profiles_mode?: ProfilesMode }[] } | null
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
  s: Pick<LookSource, 'servers' | 'me' | 'settings'>,
  server: string
): ShownParts {
  const detail = s.servers?.[server]
  const mode =
    (detail ? detail.profiles_mode : s.me?.servers.find(x => x.name === server)?.profiles_mode) ??
    'all'
  if (s.settings?.server_profiles === false || mode === 'off') return { names: false, rest: false }
  return { names: mode === 'all' && s.settings?.display_names !== false, rest: true }
}

// Whether `after` shows a part `before` left out: what a server sent then is missing it.
export const showsMore = (before: ShownParts, after: ShownParts) =>
  (after.names && !before.names) || (after.rest && !before.rest)

// `look` cut down to the parts that show.
export const lookIn = (look: MemberLook, shown: ShownParts): MemberLook | null => {
  const name = shown.names ? look.name : null
  const kind = shown.rest ? look.avatar_kind : null
  const image = shown.rest ? (look.avatar_image ?? null) : null
  if (name === look.name && kind === look.avatar_kind && image === (look.avatar_image ?? null))
    return look
  if (name === null && kind === null && image === null) return null
  return {
    name,
    avatar_kind: kind,
    avatar_color: kind === null ? null : look.avatar_color,
    avatar_image: image,
  }
}

const indexes = new WeakMap<readonly Member[], Map<string, Member>>()

const listed = (list: readonly Member[] | undefined, who: string) => {
  if (!list) return undefined
  let index = indexes.get(list)
  if (!index) {
    index = new Map(list.map(m => [m.username, m]))
    indexes.set(list, index)
  }
  return index.get(who)
}

// Whether a hosted server's row of `who` is loaded here, a row that says they left included.
export const lookKnown = (s: LookSource, server: string, who: string) =>
  Object.hasOwn(s.memberInfo?.[server] ?? {}, who) ||
  listed(s.members?.[server]?.list, who) !== undefined

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
      : listed(s.members?.[place.server]?.list, who)?.profile
  return look ? lookIn(look, shownParts(s, place.server)) : null
}

// `member` with the look a `member_profile` event carries: null takes the look away.
export function withLook<T extends { profile?: MemberLook | null }>(
  member: T,
  look: MemberLook | null
): T {
  return { ...member, profile: look }
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

// Sorts people by the name a place shows for them.
export const byShownName = (a: Pick<UserRef, 'display_name'>, b: Pick<UserRef, 'display_name'>) =>
  a.display_name.localeCompare(b.display_name)

// Someone as a hosted server shows them in a notification or a typing line, and whether to ask
// for their member row: until it is loaded the account name shows, and what was already shown
// keeps the name it was shown with.
export function shownIn<T extends UserRef>(
  s: LookSource,
  server: string | null | undefined,
  ref: T
): { user: T & ShownPerson; ask: boolean } {
  if (!server) return { user: shownUser(ref, null), ask: false }
  return {
    user: shownUser(ref, lookOf(s, { server }, ref.username)),
    ask: !lookKnown(s, server, ref.username),
  }
}

// Who is typing in a channel of a hosted server, in the order they started, under the names the
// server shows, and the typers whose member rows are not loaded yet. `here` holds each typer's
// account name as plain text.
export function shownTypers(
  s: LookSource,
  server: string | null | undefined,
  here: Record<string, { name: string }> | undefined,
  blocked: Record<string, unknown>
): { names: string[]; ask: string[] } {
  const names: string[] = []
  const ask: string[] = []
  for (const [username, t] of Object.entries(here ?? {})) {
    if (blocked[username]) continue
    const name = server ? lookOf(s, { server }, username)?.name : null
    names.push(name ? nameWithUsername({ username, display_name: name }) : t.name)
    if (server && !lookKnown(s, server, username)) ask.push(username)
  }
  return { names, ask }
}

const picKey = (pic: P2pPic | null | undefined) =>
  pic ? [pic.s.h, pic.l.h, pic.a?.h ?? ''].join(' ') : ''

type RoomMember = {
  name: string
  nick?: string
  av?: { kind: AvatarKind; bg?: string }
  // The picture the room shows for them: null for none, left out when nothing says.
  pic?: P2pPic | null
}

// What a P2P room's rows draw of its members, as one string: it changes only when someone's
// shown name or avatar there does, not when presence or anything else in the room moves.
export const roomLooksKey = (members: readonly (RoomMember & { ik: string })[] | undefined) =>
  (members ?? [])
    .map(m =>
      [m.ik, m.name, m.nick ?? '', m.av?.kind ?? '', m.av?.bg ?? '', picKey(m.pic)].join('\u0000')
    )
    .join('\n')

// The look of a member of a P2P room as this device shows them: the nickname only when no name
// of ours for them (our own name, a contact's) comes first.
export const roomLookOf = (m: RoomMember | undefined): MemberLook | null => {
  if (!m) return null
  const name = m.nick !== undefined && m.nick === m.name ? m.nick : null
  if (name === null && !m.av && !m.pic) return null
  return {
    name,
    avatar_kind: m.av?.kind ?? null,
    avatar_color: m.av?.bg ?? null,
    avatar_image: null,
    // An avatar kind chosen for the room, without a picture there, shows no picture.
    ...(m.pic ? { avatar_pic: m.pic } : m.av ? { avatar_pic: null } : {}),
  }
}

// Whoever a notification of a hosted server is about, under the name the server shows now. Their
// member row is asked for when it isn't loaded, so the next notification has it.
export function shownActor<T extends UserRef>(
  get: () => LookSource & { ensureMembers: (server: string, usernames: string[]) => unknown },
  server: string | null | undefined,
  ref: T
): T & ShownPerson {
  const s = get()
  const { user, ask } = shownIn(s, server, ref)
  if (ask && server && !isWebhookAuthor(ref.username)) void s.ensureMembers(server, [ref.username])
  return user
}
