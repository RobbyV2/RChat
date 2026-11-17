// The menus of a P2P server: its rail tile and header, a P2P rail folder, its channels, its
// members and its roles.

import { Bell, BellOff, CheckCheck, Crown, LogOut, Settings, UserPlus, Volume2 } from 'lucide-react'
import { muteEnd, mutedText, parentScope, untilText, type NotifyScope } from '../notify'
import { serverPings, serverUnread } from '../p2p/alerts'
import {
  banRequest,
  channelScope,
  p2p,
  p2pDm,
  p2pRail,
  p2pServer,
  p2pVoice,
  serverScope,
  useP2p,
} from '../p2p/app'
import { ROLE_DOWN_TEXT, TRANSFER_CO_OWNERS_TEXT, transferText, WITHDRAW_TEXT } from '../p2p/flows'
import { mayTakeRole, movesWarn, placeRole, type Move } from '../p2p/roles'
import { ownsP2pServer, type MemberView, type RoleView, type ServerView } from '../p2p/server/types'
import { P } from '../p2p/state'
import { sharing } from '../platform'
import { maskOf, useStore } from '../store'
import type { ConfirmRequest } from '../store_types'
import { muteStep, muteUntil, notifySettings } from './notify'
import type { Action, ActionCtx, ArgChoice, Target } from './types'

const get = () => useStore.getState()

const copy = (text: string) => void sharing().copyText(text)

const can = (v: ServerView, bit: number) => v.me === 'join' && (v.perms & bit) !== 0

const me = () => useP2p.getState().me

const who = (name: string) => (get().streamer ? 'this member' : name)

const serverOf = ({ target }: ActionCtx) => (target.kind === 'p2p_server' ? target : null)
const channelOf = ({ target }: ActionCtx) => (target.kind === 'p2p_channel' ? target : null)
const memberOf = ({ target }: ActionCtx) => (target.kind === 'p2p_member' ? target : null)
const roleOf = ({ target }: ActionCtx) => (target.kind === 'p2p_role' ? target : null)

// A text channel's own notifications (voice channels have none).
const textScope = (ctx: ActionCtx): NotifyScope | null => {
  const t = channelOf(ctx)
  return t && t.ch.kind !== 'voice' ? channelScope(t.v.id, t.ch.id) : null
}

const tileScope = (ctx: ActionCtx): NotifyScope | null => {
  const t = serverOf(ctx)
  return t && serverScope(t.v.id)
}

// Mute and unmute for the place `of` names in its menu: a channel's mute says when its server's
// mute ends.
const muteActions = (
  key: string,
  noun: string,
  targets: readonly Target['kind'][],
  of: (ctx: ActionCtx) => NotifyScope | null
): Action[] => {
  const end = (ctx: ActionCtx, scope: NotifyScope | null) =>
    scope && muteEnd(ctx.s.notifyPrefs, scope, Date.now())
  return [
    {
      id: `p2p_${key}_mute`,
      title: `Mute ${noun}`,
      icon: BellOff,
      scope: 'p2p',
      targets,
      order: 120,
      args: [muteStep],
      subtitle: ctx => {
        const scope = of(ctx)
        const server = end(ctx, scope && parentScope(scope))
        return server ? `Server muted ${untilText(server, Date.now())}` : undefined
      },
      available: ctx => of(ctx) !== null && end(ctx, of(ctx)) === null,
      run: (ctx, { value }) => {
        const scope = of(ctx)
        if (scope) get().muteScope(scope, muteUntil(value))
      },
    },
    {
      id: `p2p_${key}_unmute`,
      title: `Unmute ${noun}`,
      icon: Bell,
      scope: 'p2p',
      targets,
      order: 120,
      subtitle: ctx => {
        const until = end(ctx, of(ctx))
        return until ? mutedText(until, Date.now()) : undefined
      },
      available: ctx => !!end(ctx, of(ctx)),
      run: ctx => {
        const scope = of(ctx)
        if (scope) get().muteScope(scope, null)
      },
    },
  ]
}

// Withdrawing an invite: the inviter, or a moderator who may kick.
export const withdrawRequest = (v: ServerView, m: MemberView): ConfirmRequest => ({
  title: 'Withdraw Invite',
  body: WITHDRAW_TEXT,
  confirm: 'Withdraw',
  action: () => void p2pServer.withdraw(v.id, m.ik),
})

// The member takes the new copy; every other owner must approve.
export const transferRequest = (v: ServerView, m: MemberView): ConfirmRequest => ({
  title: 'Transfer Ownership',
  body: `${transferText(who(m.name))}${v.owners.length > 1 ? ` ${TRANSFER_CO_OWNERS_TEXT}` : ''}`,
  confirm: 'Transfer',
  action: () => void p2pServer.transfer(v.id, m.ik),
})

// Removing a server we are no longer in, with everything of it, from this device.
export const confirmForget = (v: ServerView) =>
  get().askConfirm({
    title: 'Remove Server',
    body: `Remove ${get().streamer ? 'this server' : v.name} and everything of it from this device? You aren't a member any more, so it can't come back.`,
    confirm: 'Remove',
    action: () => void p2pServer.forget(v.id),
  })

export const kickRequest = (v: ServerView, m: MemberView): ConfirmRequest => ({
  title: 'Kick Member',
  body: `Kick ${who(m.name)}? They can come back with a new invite.`,
  confirm: 'Kick',
  action: () => void p2pServer.kick(v.id, m.ik),
})

// Role names in our own server are our own text, never masked.
export const roleMask = (v: ServerView) => maskOf(get(), ownsP2pServer(v, me()))

export const moveRoles = (v: ServerView, moves: Move[]) => {
  if (!moves.length) return
  const go = () => void p2pServer.moveRoles(v.id, moves)
  if (movesWarn(v.roles, moves))
    get().askConfirm({ title: 'Move Role Down', body: ROLE_DOWN_TEXT, confirm: 'Move', action: go })
  else go()
}

export const deleteRole = (v: ServerView, r: RoleView) =>
  get().askConfirm({
    title: 'Delete Role',
    body: `Delete ${roleMask(v)(r.name)}? ${r.holders ? 'Members who have it lose it.' : ''}`.trim(),
    confirm: 'Delete',
    action: () => void p2pServer.deleteRole(v.id, r.id),
  })

// Whether we may give `r` to `m` (assign): Manage roles, ranked above the role and the
// member.
const mayGive = (v: ServerView, m: MemberView, r: RoleView) =>
  can(v, P.ManageRoles) && r.below && m.m === 'join' && m.ik !== me() && m.below && !m.owner

// Taking a role; one's own asks first (nobody can give themselves a role back).
export const takeRole = (v: ServerView, m: MemberView, r: RoleView) => {
  if (m.ik !== me()) return void p2pServer.revokeRole(v.id, m.ik, r.id)
  get().askConfirm({
    title: 'Remove Role',
    body: `Remove ${roleMask(v)(r.name)} from yourself? You can't give it back to yourself.`,
    confirm: 'Remove',
    action: () => void p2pServer.revokeRole(v.id, m.ik, r.id),
  })
}

// A member's roles we may give or take, checked where they hold them.
const roleChoices = (ctx: ActionCtx): ArgChoice[] => {
  const t = memberOf(ctx)
  if (!t || t.m.m !== 'join') return []
  const { v, m } = t
  const mask = roleMask(v)
  return v.roles.flatMap(r => {
    const holds = m.roles.includes(r.id)
    if (holds ? !mayTakeRole(v, m, r, me()) : !mayGive(v, m, r)) return []
    return [{ value: r.id, label: mask(r.name), checked: holds }]
  })
}

// The role's place among those we may move, and how many outrank us.
const rolePlace = (ctx: ActionCtx) => {
  const t = roleOf(ctx)
  if (!t || !can(t.v, P.ManageRoles) || !t.r.below) return null
  const at = t.v.roles.findIndex(x => x.id === t.r.id)
  return { ...t, at, fixed: t.v.roles.filter(x => !x.below).length }
}

const p2pFolder = ({ target }: ActionCtx) => {
  if (target.kind !== 'folder' || target.p2p !== true) return null
  const id = target.folder.id
  return useP2p.getState().layout.servers.some(e => typeof e !== 'string' && e.id === id)
    ? id
    : null
}

const onServer = { scope: 'p2p', targets: ['p2p_server'] } as const
const onFolder = { scope: 'p2p', targets: ['folder'] } as const
const onChannel = { scope: 'p2p', targets: ['p2p_channel'] } as const
const onMember = { scope: 'p2p', targets: ['p2p_member'] } as const
const onRole = { scope: 'p2p', targets: ['p2p_role'] } as const

const serverActions: Action[] = [
  {
    id: 'p2p_server_mark_read',
    title: 'Mark as read',
    icon: CheckCheck,
    ...onServer,
    order: 110,
    disabled: ctx => {
      const t = serverOf(ctx)
      const prefs = ctx.s.notifyPrefs
      return !t || !(serverUnread(t.v, prefs) || serverPings(t.v, prefs) > 0)
    },
    available: ctx => serverOf(ctx) !== null,
    run: ctx => {
      const t = serverOf(ctx)
      if (t) void p2pServer.markAllRead(t.v.id)
    },
  },
  ...muteActions('server', 'Server', ['p2p_server'], tileScope),
  notifySettings('p2p_server_notify', 'p2p', ['p2p_server'], tileScope),
  {
    id: 'p2p_server_invite',
    title: 'Invite People',
    icon: UserPlus,
    ...onServer,
    order: 200,
    available: ctx => {
      const t = serverOf(ctx)
      return !!t && can(t.v, P.Invite)
    },
    run: ctx => {
      const t = serverOf(ctx)
      if (t) p2p.openDialog({ kind: 'server_invite', room: t.v.id })
    },
  },
  {
    id: 'p2p_server_settings',
    title: 'Server Settings',
    icon: Settings,
    ...onServer,
    order: 210,
    available: ctx => serverOf(ctx)?.v.me === 'join',
    run: ctx => {
      const t = serverOf(ctx)
      if (t) p2p.openDialog({ kind: 'server_settings', room: t.v.id })
    },
  },
  {
    id: 'p2p_server_copy_id',
    title: 'Copy Server ID',
    ...onServer,
    order: 300,
    available: ctx => serverOf(ctx) !== null,
    run: ctx => {
      const t = serverOf(ctx)
      if (t) copy(t.v.id)
    },
  },
  {
    id: 'p2p_server_remove_from_folder',
    title: 'Remove from folder',
    ...onServer,
    order: 310,
    available: ctx => (serverOf(ctx)?.folder ?? null) !== null,
    run: ctx => {
      const t = serverOf(ctx)
      if (t) p2pRail.move(t.v.id, t.at + 1)
    },
  },
  {
    id: 'p2p_server_leave',
    title: 'Leave Server',
    icon: LogOut,
    danger: true,
    ...onServer,
    order: 800,
    available: ctx => {
      const m = serverOf(ctx)?.v.me
      return m === 'join' || m === 'invite'
    },
    run: ctx => {
      const t = serverOf(ctx)
      if (!t) return
      get().askConfirm({
        title: 'Leave Server',
        body: `Leave ${get().streamer ? 'this server' : t.v.name}? Someone who can invite has to let you in again.`,
        confirm: 'Leave',
        action: () => void p2pServer.leave(t.v.id),
      })
    },
  },
  {
    id: 'p2p_server_remove',
    title: 'Remove from this device',
    danger: true,
    ...onServer,
    order: 800,
    available: ctx => {
      const t = serverOf(ctx)
      return !!t && t.v.me !== 'join' && t.v.me !== 'invite'
    },
    run: ctx => {
      const t = serverOf(ctx)
      if (t) confirmForget(t.v)
    },
  },
]

const folderActions: Action[] = [
  {
    id: 'p2p_folder_rename',
    title: 'Edit folder',
    ...onFolder,
    order: 300,
    available: ctx => p2pFolder(ctx) !== null,
    run: ctx => {
      const id = p2pFolder(ctx)
      if (id !== null) p2p.openDialog({ kind: 'p2p_folder', id })
    },
  },
  {
    id: 'p2p_folder_ungroup',
    title: 'Ungroup',
    ...onFolder,
    order: 310,
    available: ctx => p2pFolder(ctx) !== null,
    run: ctx => {
      const id = p2pFolder(ctx)
      if (id !== null) p2pRail.ungroup(id)
    },
  },
]

const inVoice = (v: ServerView, ch: string) => {
  const here = useP2p.getState().voice
  return here?.room === v.id && here.ch === ch
}

const voiceChannel = (ctx: ActionCtx) => {
  const t = channelOf(ctx)
  return t && t.ch.kind === 'voice' ? t : null
}

const managed = (ctx: ActionCtx) => {
  const t = channelOf(ctx)
  return t && can(t.v, P.ManageChannels) ? t : null
}

const channelActions: Action[] = [
  {
    id: 'p2p_channel_join_voice',
    title: 'Join Voice',
    icon: Volume2,
    ...onChannel,
    order: 100,
    available: ctx => {
      const t = voiceChannel(ctx)
      return !!t && !inVoice(t.v, t.ch.id)
    },
    run: ctx => {
      const t = voiceChannel(ctx)
      if (!t) return
      p2pServer.openChannel(t.ch.id)
      void p2pVoice.join(t.v.id, t.ch.id)
    },
  },
  {
    id: 'p2p_channel_leave_voice',
    title: 'Leave Voice',
    icon: Volume2,
    danger: true,
    ...onChannel,
    order: 100,
    available: ctx => {
      const t = voiceChannel(ctx)
      return !!t && inVoice(t.v, t.ch.id)
    },
    run: () => p2pVoice.leave(),
  },
  {
    id: 'p2p_channel_mark_read',
    title: 'Mark as read',
    icon: CheckCheck,
    ...onChannel,
    order: 110,
    disabled: ctx => {
      const t = channelOf(ctx)
      const c = t?.v.chans[t.ch.id]
      return !c || !(c.unread || c.pings)
    },
    available: ctx => textScope(ctx) !== null,
    run: ctx => {
      const t = channelOf(ctx)
      if (t) void p2pServer.markRead(t.v.id, t.ch.id)
    },
  },
  ...muteActions('channel', 'Channel', ['p2p_channel'], textScope),
  notifySettings('p2p_channel_notify', 'p2p', ['p2p_channel'], textScope),
  {
    id: 'p2p_channel_edit',
    title: 'Edit Channel',
    ...onChannel,
    order: 300,
    available: ctx => managed(ctx) !== null,
    run: ctx => {
      const t = managed(ctx)
      if (t) p2p.openDialog({ kind: 'server_settings', room: t.v.id, tab: 'channels' })
    },
  },
  {
    id: 'p2p_channel_delete',
    title: 'Delete Channel',
    danger: true,
    ...onChannel,
    order: 310,
    available: ctx => managed(ctx) !== null,
    run: ctx => {
      const t = managed(ctx)
      if (!t) return
      const { v, ch } = t
      get().askConfirm({
        title: 'Delete Channel',
        body:
          ch.kind === 'voice'
            ? `Delete ${ch.name}?`
            : `Delete #${ch.name}? Its messages stay on members' devices but can't be opened.`,
        confirm: 'Delete',
        action: () => void p2pServer.removeChannel(v.id, ch.id),
      })
    },
  },
  {
    id: 'p2p_channel_copy_id',
    title: 'Copy Channel ID',
    ...onChannel,
    order: 400,
    available: ctx => channelOf(ctx) !== null,
    run: ctx => {
      const t = channelOf(ctx)
      if (t) copy(t.ch.id)
    },
  },
]

const contactOf = (ctx: ActionCtx) => {
  const t = memberOf(ctx)
  return t ? useP2p.getState().contacts.find(c => c.ik === t.m.ik) : undefined
}

// Kick and ban need the right bit and a member ranked below us who isn't us.
const actsOn = (ctx: ActionCtx, bit: number) => {
  const t = memberOf(ctx)
  return t && can(t.v, bit) && t.m.below && t.m.ik !== me() ? t : null
}

const named = (ctx: ActionCtx, verb: string, alone: string) => {
  const t = memberOf(ctx)
  return ctx.s.streamer || !t ? alone : `${verb} ${maskOf(ctx.s)(t.m.name)}`
}

const memberActions: Action[] = [
  {
    id: 'p2p_member_message',
    title: 'Message',
    ...onMember,
    order: 100,
    available: ctx => contactOf(ctx)?.state === 'mutual',
    run: ctx => {
      const t = memberOf(ctx)
      if (!t) return
      p2p.openHome()
      void p2pDm.openDm(t.m.ik)
    },
  },
  {
    id: 'p2p_member_contact',
    title: 'Contact details',
    ...onMember,
    order: 110,
    available: ctx => contactOf(ctx) !== undefined,
    run: ctx => {
      const t = memberOf(ctx)
      if (t) p2p.openDialog({ kind: 'contact', ik: t.m.ik })
    },
  },
  {
    id: 'p2p_member_roles',
    title: 'Roles',
    ...onMember,
    order: 200,
    args: [{ kind: 'choice', name: 'role', prompt: 'Roles', choices: roleChoices }],
    available: ctx => roleChoices(ctx).length > 0,
    run: (ctx, { role }) => {
      const t = memberOf(ctx)
      const r = t?.v.roles.find(x => x.id === role)
      if (!t || !r) return
      if (t.m.roles.includes(r.id)) takeRole(t.v, t.m, r)
      else void p2pServer.assignRole(t.v.id, t.m.ik, r.id)
    },
  },
  {
    id: 'p2p_member_kick',
    title: 'Kick Member',
    label: ctx => named(ctx, 'Kick', 'Kick Member'),
    name: true,
    danger: true,
    ...onMember,
    order: 400,
    available: ctx => actsOn(ctx, P.Kick)?.m.m === 'join',
    run: ctx => {
      const t = memberOf(ctx)
      if (t) get().askConfirm(kickRequest(t.v, t.m))
    },
  },
  {
    id: 'p2p_member_withdraw',
    title: 'Withdraw Invite',
    label: ctx => named(ctx, 'Withdraw invite of', 'Withdraw Invite'),
    name: true,
    danger: true,
    ...onMember,
    order: 410,
    available: ctx => {
      const t = memberOf(ctx)
      return !!t && t.m.m === 'invite' && t.m.ik !== me() && (can(t.v, P.Kick) || t.m.myInvite)
    },
    run: ctx => {
      const t = memberOf(ctx)
      if (t) get().askConfirm(withdrawRequest(t.v, t.m))
    },
  },
  {
    id: 'p2p_member_transfer',
    title: 'Transfer Ownership',
    icon: Crown,
    danger: true,
    ...onMember,
    order: 420,
    available: ctx => {
      const t = memberOf(ctx)
      const self = me()
      return (
        !!t &&
        !!self &&
        t.v.owners.includes(self) &&
        t.v.me === 'join' &&
        t.m.m === 'join' &&
        t.m.ik !== self &&
        !t.v.upgraded
      )
    },
    run: ctx => {
      const t = memberOf(ctx)
      if (t) get().askConfirm(transferRequest(t.v, t.m))
    },
  },
  {
    id: 'p2p_member_ban',
    title: 'Ban Member',
    label: ctx => named(ctx, 'Ban', 'Ban Member'),
    name: true,
    danger: true,
    ...onMember,
    order: 430,
    available: ctx => {
      const t = actsOn(ctx, P.Ban)
      return !!t && t.m.m !== 'ban'
    },
    run: ctx => {
      const t = memberOf(ctx)
      if (t) get().askConfirm(banRequest(t.v, t.m.ik, who(t.m.name)))
    },
  },
  {
    id: 'p2p_member_copy_key',
    title: 'Copy Identity Key',
    ...onMember,
    order: 800,
    available: ctx => memberOf(ctx) !== null,
    run: ctx => {
      const t = memberOf(ctx)
      if (t) copy(t.m.ik)
    },
  },
]

const roleActions: Action[] = [
  {
    id: 'p2p_role_up',
    title: 'Move Up',
    ...onRole,
    order: 100,
    available: ctx => {
      const p = rolePlace(ctx)
      return !!p && p.at > p.fixed
    },
    run: ctx => {
      const p = rolePlace(ctx)
      if (p) moveRoles(p.v, placeRole(p.v.roles, p.r.id, p.at - 1, p.v.rank))
    },
  },
  {
    id: 'p2p_role_down',
    title: 'Move Down',
    ...onRole,
    order: 110,
    available: ctx => {
      const p = rolePlace(ctx)
      return !!p && p.at < p.v.roles.length - 1
    },
    run: ctx => {
      const p = rolePlace(ctx)
      if (p) moveRoles(p.v, placeRole(p.v.roles, p.r.id, p.at + 1, p.v.rank))
    },
  },
  {
    // Its channel rows hold its holders back: deleting it needs Manage channels.
    id: 'p2p_role_delete',
    title: 'Delete Role',
    danger: true,
    ...onRole,
    order: 200,
    available: ctx => {
      const p = rolePlace(ctx)
      return !!p && (!p.r.held || can(p.v, P.ManageChannels))
    },
    run: ctx => {
      const p = rolePlace(ctx)
      if (p) deleteRole(p.v, p.r)
    },
  },
]

export const p2pServerActions: Action[] = [
  ...serverActions,
  ...folderActions,
  ...channelActions,
  ...memberActions,
  ...roleActions,
]
