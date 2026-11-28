// Who sees a server's member list, in hosted servers and P2P rooms, through the shared rule of
// `perms.ts` (`memberListHidden`); the P2P `member_list` register; and the words for both.
import { fromWire, known, maskOr, memberListHidden, type MembersHidden } from './perms'
import { MEMBERS_HIDDEN_LINE as OUTSIDE_LINE, seesMembers } from './profile_choice'
import { ChannelPermBit } from './types'
import { isRecord } from './bytes'
import type { RChatState } from './store_types'

export type { MembersHidden }

export const VIEW_MEMBERS = ChannelPermBit.ViewMembers

export const MEMBERS_HIDDEN_TITLE = "You can't view members"

export const MEMBERS_HIDDEN_LINE: Record<MembersHidden, string> = {
  site: 'Member lists are turned off on this site.',
  server: "You can't view the members of this server.",
  channel: "You can't view the members of this channel in this server.",
  outside: OUTSIDE_LINE,
}

// Server settings: the server-wide switch.
export const HIDE_MEMBERS_LABEL = 'Allow members to view the member list'

export const hideMembersLine = (hide: boolean) =>
  hide
    ? 'Only members who can manage the server or its roles, or kick, see who is here.'
    : 'Members with View members see who is here. Moderators always do.'

export const SITE_OFF_LINE = MEMBERS_HIDDEN_LINE.site

// What a P2P room's switch can and can't hide.
export const P2P_MEMBERS_NOTE =
  'Hides the member list and member suggestions in the app. People can still see authors of messages they receive.'

interface HostedPlace {
  hide_members?: boolean
  members_visible?: boolean
  my_perms?: number
  everyone_perms?: number
}

// Whether the viewer sees a hosted server's member list, in `channel` when given (its
// `my_perms`). A server from before the rule sends no `hide_members`: there members and the site
// admin always see it, anyone else while the server shows its members outside.
export const hostedMembersHidden = (p: {
  siteOn: boolean
  siteAdmin: boolean
  member: boolean
  detail: HostedPlace | undefined
  channel?: { my_perms?: number } | null
}): MembersHidden | null => {
  const { siteOn, siteAdmin, member, detail, channel } = p
  if (detail?.hide_members === undefined)
    return seesMembers(detail?.members_visible, member, siteAdmin) ? null : 'outside'
  const place = {
    site: siteOn,
    hide: detail.hide_members,
    outside: detail.members_visible !== false,
  }
  if (siteAdmin) return memberListHidden({ kind: 'staff' }, place)
  const here = channel?.my_perms
  if (!member)
    return memberListHidden(
      {
        kind: 'visitor',
        everyone: detail.everyone_perms ?? 0,
        ...(here === undefined ? {} : { here }),
      },
      place
    )
  return memberListHidden(
    { kind: 'member', server: detail.my_perms ?? 0, ...(here === undefined ? {} : { here }) },
    place
  )
}

// Whether the server of the open channel keeps its member list from us, in that channel
// (`inChannel`) or anywhere in it; null when it shows it.
export const viewMembersHidden = (s: RChatState, inChannel: boolean): MembersHidden | null => {
  const v = s.view
  if (v?.kind !== 'channel') return null
  const detail = s.servers[v.server]
  return hostedMembersHidden({
    siteOn: s.settings.member_lists !== false,
    siteAdmin: s.me?.is_site_admin ?? false,
    member: s.me?.servers.some(x => x.name === v.server) ?? false,
    detail,
    channel: inChannel ? detail?.channels.find(c => c.id === v.channelId) : null,
  })
}

// The `member_list` register of a P2P room as this app reads it: the server-wide switch, the
// roles that see the list (null: everyone), and the channels that keep it from members. A field
// that is not what it should be reads as unset; fields this app does not know are left alone.
export interface P2pMemberList {
  hide: boolean
  roles: string[] | null
  channels: string[]
}

const ROLES_MAX = 250
const CHANNELS_MAX = 500

export const parseP2pMemberList = (raw: unknown): P2pMemberList => {
  const c = isRecord(raw) ? raw : {}
  const roles =
    Array.isArray(c.allow_roles) &&
    c.allow_roles.length <= ROLES_MAX &&
    c.allow_roles.every(r => typeof r === 'string')
      ? (c.allow_roles as string[])
      : null
  const chans = isRecord(c.ch_hide) ? Object.entries(c.ch_hide) : []
  return {
    hide: c.hide === true,
    roles,
    channels:
      chans.length <= CHANNELS_MAX ? chans.filter(([, on]) => on === true).map(([ch]) => ch) : [],
  }
}

export type P2pMemberListChange =
  { hide: boolean } | { roles: string[] | null } | { channel: string; hide: boolean }

// The register's content after `change`, keeping every field it does not change, those a newer
// app wrote included.
export const p2pMemberListContent = (
  current: Record<string, unknown> | null,
  change: P2pMemberListChange
): Record<string, unknown> => {
  const out: Record<string, unknown> = { ...(current ?? {}) }
  if ('channel' in change) {
    const hidden = isRecord(out.ch_hide) ? { ...out.ch_hide } : {}
    if (change.hide) hidden[change.channel] = true
    else delete hidden[change.channel]
    out.ch_hide = hidden
  } else if ('roles' in change) {
    if (change.roles === null) delete out.allow_roles
    else out.allow_roles = [...new Set(change.roles)].slice(0, ROLES_MAX)
  } else out.hide = change.hide
  return out
}

// What the P2P rule reads of a room as this device holds it.
export interface P2pListPlace {
  memberList: P2pMemberList
  me: string | null
  owners: string[]
  perms: number
  rules: number
  members: { ik: string; roles: string[] }[]
}

// Whether `me` sees the member list of a P2P room, in channel `ch` when given. An owner holds
// every bit; a member holds View members unless the register names roles none of theirs is
// among, and not in a channel it hides. `siteOn` is this device's own instance switch.
export const p2pMembersHidden = (
  v: P2pListPlace,
  me: string,
  ch: string | null,
  siteOn: boolean
): MembersHidden | null => {
  const list = v.memberList
  const place = { site: siteOn, hide: list.hide, outside: true }
  const roles = list.roles
  if (v.me !== 'join')
    return memberListHidden({ kind: 'visitor', everyone: roles === null ? VIEW_MEMBERS : 0 }, place)
  const mine = v.members.find(m => m.ik === me)?.roles ?? []
  const holds = roles === null || mine.some(r => roles.includes(r))
  const bits = v.owners.includes(me) ? known(v.rules) : fromWire(v.perms, v.rules)
  const server = holds ? maskOr(bits, VIEW_MEMBERS) : bits
  const here = holds && !(ch !== null && list.channels.includes(ch)) ? VIEW_MEMBERS : 0
  return memberListHidden({ kind: 'member', server, ...(ch === null ? {} : { here }) }, place)
}
