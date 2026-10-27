import { canModerate } from './rules'
import { Perm, hasPerm, type Profile, type Role, type UserRef } from './types'

const PROFILE_CACHE = 100
const profiles = new Map<string, Profile>()

export const profileKey = (username: string, server: string | null) =>
  `${username}\n${server ?? ''}`

export const cachedProfile = (key: string) => profiles.get(key) ?? null

export const rememberProfile = (key: string, profile: Profile) => {
  profiles.delete(key)
  profiles.set(key, profile)
  if (profiles.size > PROFILE_CACHE) profiles.delete(profiles.keys().next().value as string)
}

export const forgetProfile = (key: string) => profiles.delete(key)

export const forgetProfiles = (username: string) => {
  for (const key of [...profiles.keys()])
    if (key.startsWith(profileKey(username, null))) profiles.delete(key)
}

export const clearProfiles = () => profiles.clear()

export interface Point {
  x: number
  y: number
}

export interface Size {
  width: number
  height: number
}

export const CARD_GAP = 12
export const CARD_MARGIN = 8
export const SHEET_QUERY = '(max-width: 639px)'

const HEX = /^#[0-9a-f]{6}$/i

export const validColor = (color: string | null | undefined): color is string =>
  typeof color === 'string' && HEX.test(color)

const identiconHash = (seed: string) =>
  seed.split('').reduce((hash, ch) => (hash ^ ch.charCodeAt(0)) * -5, 5) >>> 2

export const identiconHue = (username: string) => (identiconHash(username) % 9) * 40

export const hslHex = (hue: number, sat: number, light: number) => {
  const a = sat * Math.min(light, 1 - light)
  const channel = (n: number) => {
    const k = (n + hue / 30) % 12
    const c = light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))
    return Math.round(c * 255)
      .toString(16)
      .padStart(2, '0')
  }
  return `#${channel(0)}${channel(8)}${channel(4)}`
}

export const defaultBanner = (user: Pick<UserRef, 'username' | 'avatar_kind' | 'avatar_color'>) =>
  user.avatar_kind === 'color' && validColor(user.avatar_color)
    ? user.avatar_color.toLowerCase()
    : hslHex(identiconHue(user.username), 0.6, 0.42)

export const bannerColor = (
  user: Pick<UserRef, 'username' | 'avatar_kind' | 'avatar_color'>,
  custom: string | null | undefined
) => (validColor(custom) ? custom.toLowerCase() : defaultBanner(user))

const clamp = (value: number, lo: number, hi: number) => Math.max(lo, Math.min(value, hi))

export const placeCard = (
  at: Point,
  card: Size,
  view: Size,
  gap = CARD_GAP,
  margin = CARD_MARGIN
): Point => {
  const right = at.x + gap
  const left = at.x - gap - card.width
  const fitsRight = right + card.width <= view.width - margin
  const x = fitsRight || left < margin ? right : left
  return {
    x: clamp(x, margin, view.width - card.width - margin),
    y: clamp(at.y, margin, view.height - card.height - margin),
  }
}

export interface JoinLine {
  label: string
  name: string
  joinedAt: number | null
}

export const serverJoinLine = (
  server: string | null,
  serverName: string | null,
  isMember: boolean,
  joinedAt: number | null | undefined
): JoinLine | null => {
  if (server === null || !isMember) return null
  const name = serverName || server
  return { label: `Joined ${name}`, name, joinedAt: joinedAt ?? null }
}

export const joinedServer = (
  liveMember: boolean,
  profile: Pick<Profile, 'member'> | null,
  failed: boolean
) => (profile ? profile.member !== null : liveMember && !failed)

export const heldRoles = (roles: Role[], roleIds: number[]) =>
  roles.filter(r => roleIds.includes(r.id))

export const freeRoles = (roles: Role[], roleIds: number[]) =>
  roles.filter(r => !roleIds.includes(r.id))

export type ProfileAction = 'kick' | 'server_ban' | 'promote' | 'revoke' | 'transfer' | 'site_ban'

export interface ActionInput {
  signedIn: boolean
  self: boolean
  siteAdmin: boolean
  inServer: boolean
  perms: number
  member: { is_admin: boolean } | null
  targetPerms: number
}

export const profileActions = ({
  signedIn,
  self,
  siteAdmin,
  inServer,
  perms,
  member,
  targetPerms,
}: ActionInput): ProfileAction[] => {
  if (!signedIn) return []
  const out: ProfileAction[] = []
  if (inServer) {
    const kick = hasPerm(perms, Perm.Kick) && !self && canModerate(perms, siteAdmin, targetPerms)
    const admins = hasPerm(perms, Perm.ManageAdmins)
    if (kick && member) out.push('kick')
    if (kick) out.push('server_ban')
    if (admins && member) out.push(member.is_admin ? 'revoke' : 'promote')
    if (admins && member && !self) out.push('transfer')
  }
  if (siteAdmin && !self) out.push('site_ban')
  return out
}

export const canEditRoles = ({ signedIn, inServer, perms, member }: ActionInput) =>
  signedIn && inServer && member !== null && hasPerm(perms, Perm.ManageAdmins)
