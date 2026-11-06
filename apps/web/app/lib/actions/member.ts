// A person's menu: a member row, someone who interacted, a friend or request row, a sidebar DM's
// other person, and (until the message menus move) a message's author.

import {
  AtSign,
  Check,
  MessageCircle,
  UserCheck,
  UserMinus,
  UserPlus,
  UserX,
  X,
} from 'lucide-react'
import { sharing } from '../platform'
import { canModerate, canPromote, canRevoke, canTransferTo, memberPerms, rolePerms } from '../rules'
import {
  changeableRoles,
  confirmBan,
  confirmKick,
  confirmTransfer,
  memberOf,
  memberState,
  memberTimeout,
  myPerms,
  myRolePerms,
  revokeAdminFor,
  useStore,
  type ContextMenuItem,
} from '../store'
import type { RChatState } from '../store_types'
import { Perm, hasPerm, type Member, type UserRef } from '../types'
import { isWebhookAuthor } from '../webhooks'
import { ctxFor } from './ctx'
import { signedIn } from './global'
import { itemFor } from './menu'
import { noLongerAvailable } from './registry'
import type { Action, ActionCtx, MemberWhere } from './types'

const get = () => useStore.getState()

// The person on a row of one of `where`; a sidebar DM counts as `dm`.
const person = (ctx: ActionCtx, ...where: MemberWhere[]): UserRef | null => {
  const t = ctx.target
  if (t.kind === 'member') return where.includes(t.where) ? t.user : null
  if (t.kind === 'dm') return where.includes('dm') && t.where === 'sidebar' ? t.dm.other : null
  return null
}

// Someone else, not a webhook, seen by a signed-in account.
const someoneElse = (s: RChatState, u: UserRef | null): UserRef | null =>
  u && signedIn(s) && !isWebhookAuthor(u.username) && u.username !== s.me?.username ? u : null

const known = (s: RChatState, username: string) =>
  [s.friends, s.onlineFriends, s.incomingRequests, s.outgoingRequests].some(p =>
    p.list.some((x: { user: UserRef }) => x.user.username === username)
  )

const isFriend = (s: RChatState, username: string) =>
  [s.friends, s.onlineFriends].some(p => p.list.some(f => f.user.username === username))

const asking = (s: RChatState, username: string, incoming: boolean) =>
  (incoming ? s.incomingRequests : s.outgoingRequests).list.some(r => r.user.username === username)

const userRef = (u: UserRef): UserRef => ({
  username: u.username,
  display_name: u.display_name,
  avatar_kind: u.avatar_kind,
  avatar_color: u.avatar_color,
})

const copy = (text: string) => void sharing().copyText(text)

// Whether the person is blocked now, or null when the row offers no block.
const blockable = (ctx: ActionCtx): boolean | null => {
  const u = someoneElse(
    ctx.s,
    person(ctx, 'list', 'interacted', 'friend', 'request', 'author', 'dm')
  )
  return u && !!ctx.s.blocked[u.username]
}

// Opens the DM; on narrow screens the full screen panel closes so the DM shows.
export const messageFriend = (user: UserRef) => {
  const s = get()
  if (window.matchMedia('(max-width: 767px)').matches) s.closePanel()
  void s.startDm(user.username)
}

// A server member's row as a moderator sees it: your rights, theirs, and whether it is you.
interface Seat {
  server: string
  user: UserRef
  self: boolean
  perms: number
  siteAdmin: boolean
  row: Member | undefined
  left: boolean
  // Your rights reach theirs.
  over: boolean
}

const MOD: MemberWhere[] = ['list', 'author']

const seatOf = (ctx: ActionCtx): Seat | null => {
  const { s, target } = ctx
  if (!signedIn(s) || !s.me || target.kind !== 'member' || !MOD.includes(target.where)) return null
  const { user, server } = target
  if (server === null) return null
  const perms = myPerms(s, server)
  const siteAdmin = s.me.is_site_admin
  const row = memberOf(s, server, user.username)
  return {
    server,
    user,
    self: user.username === s.me.username,
    perms,
    siteAdmin,
    row,
    left: memberState(s, server, user.username) === null,
    over: canModerate(perms, siteAdmin, memberPerms(row, s.servers[server]?.roles ?? [])),
  }
}

const may = (ctx: ActionCtx, perm: number, test: (seat: Seat) => boolean) => {
  const seat = seatOf(ctx)
  return !!seat && hasPerm(seat.perms, perm) && test(seat)
}

const moderates = (perm: number) => (ctx: ActionCtx) =>
  may(ctx, perm, seat => !seat.self && !seat.left && seat.over)

// Runs `f` on the member a moderation row is about.
const onSeat = (f: (seat: Seat) => void) => (ctx: ActionCtx) => {
  const seat = seatOf(ctx)
  if (seat) f(seat)
}

const openTimeout = onSeat(({ server, user }) =>
  get().openDialog({ kind: 'timeout', server, user: userRef(user) })
)

const timedOut = ({ s, target }: ActionCtx) =>
  target.kind === 'member' && memberTimeout(s, target.server, target.user.username) !== null

// A role choice's value says what it does: `+<id>` assigns the role, `-<id>` removes it.
const roleChoices = (ctx: ActionCtx) => {
  const seat = seatOf(ctx)
  if (!seat || !hasPerm(seat.perms, Perm.ManageAdmins)) return []
  const held = seat.row?.role_ids ?? []
  return changeableRoles(ctx.s, seat.server, seat.user.username).map(r => {
    const remove = held.includes(r.id)
    return {
      value: `${remove ? '-' : '+'}${r.id}`,
      label: `${remove ? 'Remove' : 'Assign'} ${r.name}`,
      danger: remove,
    }
  })
}

// The role choices for a server member, as their own menu (server settings' Roles button).
export const roleItems = (server: string, user: UserRef): ContextMenuItem[] =>
  itemFor('member_roles', ctxFor(get(), { kind: 'member', user, server, where: 'list' }, 'menu'))
    ?.submenu ?? []

const onMember = { scope: 'member', targets: ['member'] } as const

export const memberActions: Action[] = [
  {
    id: 'member_dm',
    title: 'Direct Message',
    icon: MessageCircle,
    ...onMember,
    order: 200,
    available: ctx => signedIn(ctx.s) && person(ctx, 'list', 'interacted') !== null,
    run: ({ member }) => {
      if (member) void get().startDm(member.username)
    },
  },
  {
    id: 'friend_message',
    title: 'Message',
    icon: MessageCircle,
    ...onMember,
    order: 200,
    available: ctx => {
      const u = someoneElse(ctx.s, person(ctx, 'friend'))
      return !!u && isFriend(ctx.s, u.username)
    },
    run: ({ member }) => {
      if (member) messageFriend(member)
    },
  },
  {
    id: 'member_kick',
    title: 'Kick',
    danger: true,
    ...onMember,
    order: 400,
    available: moderates(Perm.Kick),
    run: onSeat(({ server, user }) => confirmKick(server, user.username)),
  },
  {
    id: 'member_ban',
    title: 'Ban from server',
    danger: true,
    ...onMember,
    order: 410,
    available: moderates(Perm.Kick),
    run: onSeat(({ server, user }) => confirmBan(server, user.username)),
  },
  {
    id: 'member_timeout',
    title: 'Time Out',
    label: ctx => (timedOut(ctx) ? 'Change Timeout' : 'Time Out'),
    danger: true,
    dangerFor: ctx => !timedOut(ctx),
    ...onMember,
    order: 420,
    available: moderates(Perm.TimeoutMembers),
    menuRun: openTimeout,
    run: openTimeout,
  },
  {
    id: 'member_timeout_remove',
    title: 'Remove Timeout',
    danger: true,
    ...onMember,
    order: 430,
    available: ctx => moderates(Perm.TimeoutMembers)(ctx) && timedOut(ctx),
    run: onSeat(({ server, user }) => void get().removeTimeout(server, user.username)),
  },
  {
    id: 'member_revoke_admin',
    title: 'Revoke Admin',
    danger: true,
    ...onMember,
    order: 440,
    available: ctx =>
      may(
        ctx,
        Perm.ManageAdmins,
        ({ row, perms, siteAdmin, server }) =>
          !!row?.is_admin &&
          canRevoke(perms, siteAdmin, row.perms, rolePerms(row, ctx.s.servers[server]?.roles ?? []))
      ),
    run: onSeat(({ server, user }) => revokeAdminFor(server, user.username)),
  },
  {
    id: 'member_promote_admin',
    title: 'Promote to Admin',
    ...onMember,
    order: 440,
    available: ctx =>
      may(
        ctx,
        Perm.ManageAdmins,
        ({ row, perms, siteAdmin }) => !row?.is_admin && canPromote(perms, siteAdmin)
      ),
    run: onSeat(({ server, user }) => void get().grantAdmin(server, user.username)),
  },
  {
    id: 'member_transfer_admin',
    title: 'Transfer Admin',
    ...onMember,
    order: 450,
    available: ctx =>
      may(
        ctx,
        Perm.ManageAdmins,
        ({ self, row, perms, siteAdmin, server }) =>
          !self && canTransferTo(perms, siteAdmin, row?.perms ?? 0, myRolePerms(ctx.s, server))
      ),
    run: onSeat(({ server, user }) => confirmTransfer(server, user.username)),
  },
  {
    id: 'member_roles',
    title: 'Assign Role',
    ...onMember,
    order: 460,
    args: [{ kind: 'choice', name: 'role', prompt: 'Role', choices: roleChoices }],
    available: ctx => roleChoices(ctx).length > 0,
    run: (ctx, { role }) => {
      const seat = seatOf(ctx)
      const pick = /^([+-])(\d+)$/.exec(role ?? '')
      if (!seat || !pick || !roleChoices(ctx).some(c => c.value === role)) {
        noLongerAvailable()
        return
      }
      const { server, user } = seat
      const id = Number(pick[2])
      void (pick[1] === '-'
        ? get().unassignRole(server, id, user.username)
        : get().assignRole(server, id, user.username))
    },
  },
  {
    id: 'member_friend_add',
    title: 'Add friend',
    icon: UserPlus,
    ...onMember,
    targets: ['member', 'dm'],
    order: 470,
    available: ctx => {
      const { s } = ctx
      const u = someoneElse(s, person(ctx, 'list', 'interacted', 'author', 'dm'))
      return !!u && !s.blocked[u.username] && !known(s, u.username)
    },
    run: ({ member }) => {
      if (member) get().askAddFriends([member.username])
    },
  },
  {
    id: 'friend_remove',
    title: 'Remove friend',
    icon: UserMinus,
    danger: true,
    ...onMember,
    order: 470,
    available: ctx => {
      const u = someoneElse(ctx.s, person(ctx, 'friend'))
      return !!u && isFriend(ctx.s, u.username)
    },
    run: ({ member }) => {
      if (member) get().askRemoveFriend(member)
    },
  },
  {
    id: 'request_accept',
    title: 'Accept',
    icon: Check,
    ...onMember,
    order: 470,
    available: ctx => {
      const u = someoneElse(ctx.s, person(ctx, 'request'))
      return !!u && asking(ctx.s, u.username, true)
    },
    run: ({ member }) => {
      if (member) void get().acceptFriend(member)
    },
  },
  {
    id: 'request_deny',
    title: 'Deny',
    icon: X,
    ...onMember,
    order: 471,
    available: ctx => {
      const u = someoneElse(ctx.s, person(ctx, 'request'))
      return !!u && asking(ctx.s, u.username, true)
    },
    run: ({ member }) => {
      if (member) void get().denyFriend(member.username)
    },
  },
  {
    id: 'request_cancel',
    title: 'Cancel request',
    icon: X,
    ...onMember,
    order: 470,
    available: ctx => {
      const u = someoneElse(ctx.s, person(ctx, 'request'))
      return !!u && asking(ctx.s, u.username, false)
    },
    run: ({ member }) => {
      if (member) void get().cancelFriendRequest(member.username)
    },
  },
  {
    id: 'member_block',
    title: 'Block',
    icon: UserX,
    danger: true,
    ...onMember,
    targets: ['member', 'dm'],
    order: 480,
    available: ctx => blockable(ctx) === false,
    run: ({ member }) => {
      if (member) get().askBlock(member)
    },
  },
  {
    id: 'member_unblock',
    title: 'Unblock',
    icon: UserCheck,
    ...onMember,
    targets: ['member', 'dm'],
    order: 480,
    available: ctx => blockable(ctx) === true,
    run: ({ member }) => {
      if (member) void get().unblockUser(member.username, member.display_name)
    },
  },
  {
    id: 'member_copy_id',
    title: 'Copy User ID',
    icon: AtSign,
    ...onMember,
    order: 940,
    available: ctx => signedIn(ctx.s) && person(ctx, 'list', 'interacted', 'friend') !== null,
    run: ({ member }) => {
      if (member) copy(member.username)
    },
  },
]
