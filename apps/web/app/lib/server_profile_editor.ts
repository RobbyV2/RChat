import type { ShownPerson } from './people'
import { PROFILE_FIELDS, cleanBio, type RoomExtras } from './profile_fields'
import { validColor } from './profile'
import { shownUser } from './server_profile'
import type {
  AvatarKind,
  MemberLook,
  ProfilesMode,
  ServerProfile,
  ServerProfilePatch,
  UserRef,
} from './types'

// What the server profile editor holds, the same for a hosted server and a P2P room. An empty
// name or description and a null avatar or banner mean "as on the account".
export interface ProfileDraft {
  name: string
  bio: string
  avatar: { kind: AvatarKind; color: string | null } | null
  banner: string | null
}

export const EMPTY_DRAFT: ProfileDraft = { name: '', bio: '', avatar: null, banner: null }

const count = (text: string) => [...text].length

// A hosted server's stored profile as a draft.
export const draftOfProfile = (
  p: Pick<ServerProfile, 'look' | 'bio' | 'banner_color'>
): ProfileDraft => ({
  name: p.look.name ?? '',
  bio: p.bio ?? '',
  avatar:
    p.look.avatar_kind === null
      ? null
      : { kind: p.look.avatar_kind, color: p.look.avatar_color ?? null },
  banner: p.banner_color ?? null,
})

// What this device set for itself in a P2P room as a draft.
export const draftOfExtras = (e: RoomExtras): ProfileDraft => ({
  name: e.nick ?? '',
  bio: e.bio ?? '',
  avatar: e.av ? { kind: e.av.kind, color: e.av.bg ?? null } : null,
  banner: e.bn ?? null,
})

// A draft as it is stored: trimmed, colors in lower case, and a color avatar without a color
// left out.
export const settled = (d: ProfileDraft): ProfileDraft => ({
  name: d.name.trim(),
  bio: cleanBio(d.bio),
  avatar:
    d.avatar === null
      ? null
      : d.avatar.kind === 'color'
        ? validColor(d.avatar.color)
          ? { kind: 'color', color: d.avatar.color.toLowerCase() }
          : null
        : {
            kind: 'identicon',
            color: validColor(d.avatar.color) ? d.avatar.color.toLowerCase() : null,
          },
  banner: validColor(d.banner) ? d.banner.toLowerCase() : null,
})

const sameAvatar = (a: ProfileDraft['avatar'], b: ProfileDraft['avatar']) =>
  a === null || b === null ? a === b : a.kind === b.kind && a.color === b.color

export const sameDraft = (a: ProfileDraft, b: ProfileDraft) => {
  const x = settled(a)
  const y = settled(b)
  return (
    x.name === y.name && x.bio === y.bio && sameAvatar(x.avatar, y.avatar) && x.banner === y.banner
  )
}

export const emptyDraft = (d: ProfileDraft) => sameDraft(d, EMPTY_DRAFT)

// Why a draft can't be saved, in the words the hosted routes use; null when it can.
export const draftError = (d: ProfileDraft): string | null => {
  const next = settled(d)
  if (count(next.name) > PROFILE_FIELDS.name.max)
    return `Display name must be at most ${PROFILE_FIELDS.name.max} characters`
  if (count(next.bio) > PROFILE_FIELDS.bio.max)
    return `Description must be at most ${PROFILE_FIELDS.bio.max} characters`
  if (d.avatar?.kind === 'color' && !validColor(d.avatar.color)) return 'Invalid avatar color'
  return null
}

// A draft without what a place's mode leaves out: no name under `no_names`.
export const draftFor = (d: ProfileDraft, names: boolean): ProfileDraft =>
  names ? d : { ...d, name: '' }

// The hosted request that turns the stored profile `from` into `to`: only what changed, null
// for "as on the account".
export const patchOf = (from: ProfileDraft, to: ProfileDraft): ServerProfilePatch => {
  const a = settled(from)
  const b = settled(to)
  const out: ServerProfilePatch = {}
  if (a.name !== b.name) out.name = b.name || null
  if (a.bio !== b.bio) out.bio = b.bio || null
  if (!sameAvatar(a.avatar, b.avatar)) {
    out.avatar_kind = b.avatar?.kind ?? null
    if (b.avatar) out.avatar_color = b.avatar.color
  }
  if (a.banner !== b.banner) out.banner_color = b.banner
  return out
}

// What a P2P device writes into the room for itself.
export const extrasOf = (d: ProfileDraft): RoomExtras => {
  const s = settled(d)
  const out: RoomExtras = {}
  if (s.name) out.nick = s.name
  if (s.bio) out.bio = s.bio
  if (s.avatar)
    out.av = s.avatar.color ? { kind: s.avatar.kind, bg: s.avatar.color } : { kind: s.avatar.kind }
  if (s.banner) out.bn = s.banner
  return out
}

// The picture a place holds for a profile, outside the draft: it is set and removed at once.
export type ProfilePicture = Pick<MemberLook, 'avatar_image'>

// The look a draft gives under a place's mode, with the picture the place holds.
export const draftLook = (
  d: ProfileDraft,
  mode: ProfilesMode,
  names = true,
  picture: ProfilePicture = {}
): MemberLook | null => {
  if (mode === 'off') return null
  const s = settled(d)
  const name = mode === 'all' && names && s.name ? s.name : null
  const image = picture.avatar_image ?? null
  if (name === null && s.avatar === null && image === null) return null
  return {
    name,
    avatar_kind: s.avatar?.kind ?? null,
    avatar_color: s.avatar?.color ?? null,
    ...(image === null ? {} : { avatar_image: image }),
  }
}

// The account (or P2P identity) as the place would show it with the draft saved.
export const previewUser = <T extends UserRef>(
  account: T,
  d: ProfileDraft,
  mode: ProfilesMode,
  names = true,
  picture: ProfilePicture = {}
): T & ShownPerson => shownUser(account, draftLook(d, mode, names, picture))

// Characters left in the description, as the editor counts them.
export const bioLeft = (d: ProfileDraft) => PROFILE_FIELDS.bio.max - count(cleanBio(d.bio))

// Whether you may open your own profile of a P2P server: one you are in, that still takes
// writes and shows server profiles.
export const editsRoomProfile = (v: {
  me: string | null
  readOnly: string | null
  upgraded: boolean
  profiles: ProfilesMode
}) => v.me === 'join' && !v.readOnly && !v.upgraded && v.profiles !== 'off'
