// The menus of a P2P server: its rail tile and header, a P2P rail folder, its channels, its
// members and its roles.

import { viewingActions } from './viewing'

import {
  Bell,
  BellOff,
  CheckCheck,
  Crown,
  Eraser,
  IdCard,
  LockOpen,
  LogOut,
  Settings,
  UserPlus,
  Volume2,
} from 'lucide-react'
import { muteEnd, mutedText, parentScope, untilText, type NotifyScope } from '../notify'
import { serverPings, serverUnread } from '../p2p/alerts'

import { ROLE_DOWN_TEXT, TRANSFER_CO_OWNERS_TEXT, transferText, WITHDRAW_TEXT } from '../p2p/flows'
import {
  displayMoves,
  mayTakeRole,
  movesWarn,
  placeRole,
  shownOrder,
  type DisplayMove,
  type Move,
  subjectName,
} from '../p2p/roles'
import { stepRole } from '../hierarchy'
import { ownsP2pServer, type MemberView, type RoleView, type ServerView } from '../p2p/server/types'
import { P } from '../p2p/state'
import { editsRoomProfile } from '../server_profile_editor'
import { peerTimeout } from '../timeouts'
import { subjectNames, syncConfirmText } from '../categories'
import { sharing } from '../platform'
import { maskOf } from '../store'
import type { ConfirmRequest } from '../store_types'
import { muteStep, muteUntil, notifySettings } from './notify'
import type { Action, ActionCtx, ArgChoice, Target } from './types'
import { identityActions } from './identity'
export const peerServer = identityActions(identity => {
  const copy = (text: string) => void sharing().copyText(text)

  const can = (v: ServerView, bit: number) => v.me === 'join' && (v.perms & bit) !== 0

  const me = () => identity().useP2p.getState().me

  const who = (name: string, acct = identity().owner) =>
    acct.store.getState().streamer ? 'this member' : name

  const serverOf = ({ target }: ActionCtx) => (target.kind === 'p2p_server' ? target : null)
  const channelOf = ({ target }: ActionCtx) => (target.kind === 'p2p_channel' ? target : null)
  const memberOf = ({ target }: ActionCtx) => (target.kind === 'p2p_member' ? target : null)
  const roleOf = ({ target }: ActionCtx) => (target.kind === 'p2p_role' ? target : null)

  // A text channel's own notifications (voice channels have none).
  const textScope = (ctx: ActionCtx): NotifyScope | null => {
    const t = channelOf(ctx)
    return t && t.ch.kind !== 'voice' ? identity().channelScope(t.v.id, t.ch.id) : null
  }

  const tileScope = (ctx: ActionCtx): NotifyScope | null => {
    const t = serverOf(ctx)
    return t && identity().serverScope(t.v.id)
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
          if (scope) ctx.acct.store.getState().muteScope(scope, muteUntil(value))
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
          if (scope) ctx.acct.store.getState().muteScope(scope, null)
        },
      },
    ]
  }

  // Withdrawing an invite: the inviter, or a moderator who may kick.
  const withdrawRequest = (v: ServerView, m: MemberView): ConfirmRequest => ({
    title: 'Withdraw Invite',
    body: WITHDRAW_TEXT,
    confirm: 'Withdraw',
    action: identity().inIdentity(() => void identity().p2pServer.withdraw(v.id, m.ik)),
  })

  // The member takes the new copy; every other owner must approve.
  const transferRequest = (
    v: ServerView,
    m: MemberView,
    acct = identity().owner
  ): ConfirmRequest => ({
    title: 'Transfer Ownership',
    body: `${transferText(who(m.name, acct))}${v.owners.length > 1 ? ` ${TRANSFER_CO_OWNERS_TEXT}` : ''}`,
    confirm: 'Transfer',
    action: identity().inIdentity(() => void identity().p2pServer.transfer(v.id, m.ik)),
  })

  // Removing a server we are no longer in, with everything of it, from this device.
  const confirmForget = (v: ServerView, acct = identity().owner) =>
    acct.store.getState().askConfirm({
      title: 'Remove Server',
      body: `Remove ${acct.store.getState().streamer ? 'this server' : v.name} and everything of it from this device? You aren't a member any more, so it can't come back.`,
      confirm: 'Remove',
      action: identity().inIdentity(() => void identity().p2pServer.forget(v.id)),
    })

  const kickRequest = (v: ServerView, m: MemberView, acct = identity().owner): ConfirmRequest => ({
    title: 'Kick Member',
    body: `Kick ${who(m.name, acct)}? They can come back with a new invite.`,
    confirm: 'Kick',
    reason: true,
    action: identity().inIdentity(
      (_choice: string, reason?: string) => void identity().p2pServer.kick(v.id, m.ik, reason)
    ),
  })

  // Role names in our own server are our own text, never masked.
  const roleMask = (v: ServerView, acct = identity().owner) =>
    maskOf(acct.store.getState(), ownsP2pServer(v, me()))

  const moveRoles = (v: ServerView, moves: Move[], acct = identity().owner) => {
    if (!moves.length) return
    const go = () => void identity().p2pServer.moveRoles(v.id, moves)
    if (movesWarn(v.roles, moves))
      acct.store
        .getState()
        .askConfirm({ title: 'Move Role Down', body: ROLE_DOWN_TEXT, confirm: 'Move', action: go })
    else go()
  }

  const deleteRole = (v: ServerView, r: RoleView, acct = identity().owner) =>
    acct.store.getState().askConfirm({
      title: 'Delete Role',
      body: `Delete ${roleMask(v, acct)(r.name)}? ${r.holders ? 'Members who have it lose it.' : ''}`.trim(),
      confirm: 'Delete',
      action: identity().inIdentity(() => void identity().p2pServer.deleteRole(v.id, r.id)),
    })

  // Whether we may give `r` to `m` (assign): Manage roles, ranked above the role and the
  // member.
  const mayGive = (v: ServerView, m: MemberView, r: RoleView) =>
    can(v, P.ManageRoles) && r.below && m.m === 'join' && m.ik !== me() && m.below && !m.owner

  // Taking a role; one's own asks first (nobody can give themselves a role back).
  const takeRole = (v: ServerView, m: MemberView, r: RoleView, acct = identity().owner) => {
    if (m.ik !== me()) return void identity().p2pServer.revokeRole(v.id, m.ik, r.id)
    acct.store.getState().askConfirm({
      title: 'Remove Role',
      body: `Remove ${roleMask(v, acct)(r.name)} from yourself? You can't give it back to yourself.`,
      confirm: 'Remove',
      action: identity().inIdentity(() => void identity().p2pServer.revokeRole(v.id, m.ik, r.id)),
    })
  }

  // A member's roles we may give or take, checked where they hold them.
  const roleChoices = (ctx: ActionCtx): ArgChoice[] => {
    const t = memberOf(ctx)
    if (!t || t.m.m !== 'join') return []
    const { v, m } = t
    const mask = roleMask(v, ctx.acct)
    return v.roles.flatMap(r => {
      const holds = m.roles.includes(r.id)
      if (holds ? !mayTakeRole(v, m, r, me()) : !mayGive(v, m, r)) return []
      return [{ value: r.id, label: mask(r.name), checked: holds }]
    })
  }

  // The role's place among those we may move, and how many outrank us.
  // Where a role shows: one step among the roles we may change, in display order.
  const shownStep = (ctx: ActionCtx, step: -1 | 1) => {
    const t = roleOf(ctx)
    if (!t || !can(t.v, P.ManageRoles) || !t.r.below) return null
    const movable = t.v.roles.filter(r => r.below)
    const order = stepRole(
      shownOrder(t.v.roles),
      movable.map(r => r.id),
      t.r.id,
      step
    )
    const gap = identity().p2p.limits().server.roleStep
    const moves = order && displayMoves(t.v.roles, order, r => r.below, gap)
    return moves?.length ? { v: t.v, moves } : null
  }

  // Showing roles in role order again: we clear the display positions of the roles we may change,
  // and only when that shows every role in role order.
  const followMoves = (ctx: ActionCtx) => {
    const t = roleOf(ctx)
    if (!t || !can(t.v, P.ManageRoles)) return null
    const ours = t.v.roles.filter(r => r.dpos !== null && r.below)
    const after = t.v.roles.map(r => (r.below ? { ...r, dpos: null } : r))
    if (!ours.length || shownOrder(after).some((id, i) => id !== t.v.roles[i].id)) return null
    return { v: t.v, moves: ours.map(r => ({ role: r.id, dpos: null })) }
  }

  const show = (moves: { v: ServerView; moves: DisplayMove[] } | null) => {
    if (moves) void identity().p2pServer.showRoles(moves.v.id, moves.moves)
  }

  const rolePlace = (ctx: ActionCtx) => {
    const t = roleOf(ctx)
    if (!t || !can(t.v, P.ManageRoles) || !t.r.below) return null
    const at = t.v.roles.findIndex(x => x.id === t.r.id)
    return { ...t, at, fixed: t.v.roles.filter(x => !x.below).length }
  }

  const p2pFolder = ({ target }: ActionCtx) => {
    if (target.kind !== 'folder' || target.p2p !== true) return null
    const id = target.folder.id
    return identity()
      .useP2p.getState()
      .layout.servers.some(e => typeof e !== 'string' && e.id === id)
      ? id
      : null
  }

  // The server whose profile of ours a tile, a header or our own member row opens: one we are
  // in, that still takes writes and shows profiles.
  const profileRoom = ({ target }: ActionCtx) => {
    const v =
      target.kind === 'p2p_server'
        ? target.v
        : target.kind === 'p2p_member' && target.m.ik === me()
          ? target.v
          : null
    return v && editsRoomProfile(v) ? v.id : null
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
        if (t) void identity().p2pServer.markAllRead(t.v.id)
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
        if (t) identity().p2p.openDialog({ kind: 'server_invite', room: t.v.id })
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
        if (t) identity().p2p.openDialog({ kind: 'server_settings', room: t.v.id })
      },
    },
    {
      id: 'p2p_server_profile',
      title: 'Edit Server Profile',
      icon: IdCard,
      scope: 'p2p',
      targets: ['p2p_server', 'p2p_member'],
      order: 215,
      available: ctx => profileRoom(ctx) !== null,
      run: ctx => {
        const room = profileRoom(ctx)
        if (room) identity().p2p.openDialog({ kind: 'server_profile', room })
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
        if (t) identity().p2pRail.move(t.v.id, t.at + 1)
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
        ctx.acct.store.getState().askConfirm({
          title: 'Leave Server',
          body: `Leave ${ctx.acct.store.getState().streamer ? 'this server' : t.v.name}? Someone who can invite has to let you in again.`,
          confirm: 'Leave',
          action: identity().inIdentity(() => void identity().p2pServer.leave(t.v.id)),
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
        if (t) confirmForget(t.v, ctx.acct)
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
        if (id !== null) identity().p2p.openDialog({ kind: 'p2p_folder', id })
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
        if (id !== null) identity().p2pRail.ungroup(id)
      },
    },
  ]

  const inVoice = (v: ServerView, ch: string) => {
    const here = identity().useP2p.getState().voice
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
    ...viewingActions(
      'p2p_channel',
      ctx => {
        const t = channelOf(ctx)
        return t && (identity().peerTarget(identity().useP2p.getState(), t.v.id, t.ch.id) ?? null)
      },
      ctx => !!managed(ctx),
      (ctx, sensitive) => {
        const t = managed(ctx)
        if (t) void identity().p2pServer.editChannel(t.v.id, t.ch.id, { sensitive })
      }
    ),
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
        void identity().p2pVoice.join(t.v.id, t.ch.id)
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
      run: () => identity().p2pVoice.leave(),
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
        if (t) void identity().p2pServer.markRead(t.v.id, t.ch.id)
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
        if (t) identity().p2p.openDialog({ kind: 'server_settings', room: t.v.id, tab: 'channels' })
      },
    },
    {
      id: 'p2p_channel_permissions',
      title: 'Permissions',
      ...onChannel,
      order: 302,
      available: ctx => managed(ctx) !== null,
      run: ctx => {
        const t = managed(ctx)
        if (t) identity().p2p.openDialog({ kind: 'perms', room: t.v.id, ch: t.ch.id })
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
        ctx.acct.store.getState().askConfirm({
          title: 'Delete Channel',
          body:
            ch.kind === 'voice'
              ? `Delete ${ch.name}?`
              : `Delete #${ch.name}? Its messages stay on members' devices but can't be opened.`,
          confirm: 'Delete',
          action: identity().inIdentity(() => void identity().p2pServer.removeChannel(v.id, ch.id)),
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
    return t
      ? identity()
          .useP2p.getState()
          .contacts.find(c => c.ik === t.m.ik)
      : undefined
  }

  // Kick and ban need the right bit and a member ranked below us who isn't us.
  const actsOn = (ctx: ActionCtx, bit: number) => {
    const t = memberOf(ctx)
    return t && can(t.v, bit) && t.m.below && t.m.ik !== me() ? t : null
  }

  // A member whose profile here we may reset, while the server shows profiles.
  const resetsProfile = (ctx: ActionCtx) => {
    const t = memberOf(ctx)
    return t && t.m.resetProfile && t.v.profiles !== 'off' && !t.v.upgraded ? t : null
  }

  // A joined member below us we may time out, in a room whose rules read timeouts.
  const timesOut = (ctx: ActionCtx) => {
    const t = actsOn(ctx, P.TimeoutMembers)
    return t && t.v.timeouts === true && t.m.m === 'join' && !t.m.owner ? t : null
  }
  const timedOut = (ctx: ActionCtx) => peerTimeout(memberOf(ctx)?.m) !== null
  const openTimeout = (ctx: ActionCtx) => {
    const t = memberOf(ctx)
    if (t)
      ctx.acct.store.getState().openDialog({
        kind: 'timeout_request',
        request: identity().timeoutRequest(t.v, t.m, who(t.m.name, ctx.acct)),
      })
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
        identity().p2p.openHome()
        void identity().p2pDm.openDm(t.m.ik)
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
        if (t) identity().p2p.openDialog({ kind: 'contact', ik: t.m.ik })
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
        if (t.m.roles.includes(r.id)) takeRole(t.v, t.m, r, ctx.acct)
        else void identity().p2pServer.assignRole(t.v.id, t.m.ik, r.id)
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
        if (t) ctx.acct.store.getState().askConfirm(kickRequest(t.v, t.m, ctx.acct))
      },
    },
    {
      id: 'p2p_member_profile_reset',
      title: 'Reset Server Profile',
      icon: Eraser,
      danger: true,
      ...onMember,
      order: 402,
      available: ctx => resetsProfile(ctx) !== null,
      run: ctx => {
        const t = resetsProfile(ctx)
        if (t) identity().p2p.openDialog({ kind: 'profile_reset', room: t.v.id, ik: t.m.ik })
      },
    },
    {
      id: 'p2p_member_profile_unlock',
      title: 'Unlock Server Profile',
      icon: LockOpen,
      ...onMember,
      order: 404,
      available: ctx => resetsProfile(ctx)?.m.profileLocked === true,
      run: ctx => {
        const t = resetsProfile(ctx)
        if (t) void identity().p2pServer.unlockProfile(t.v.id, t.m.ik)
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
        if (t) ctx.acct.store.getState().askConfirm(withdrawRequest(t.v, t.m))
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
        if (t) ctx.acct.store.getState().askConfirm(transferRequest(t.v, t.m, ctx.acct))
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
        if (t)
          ctx.acct.store.getState().openDialog({
            kind: 'ban_request',
            request: identity().banRequest(t.v, t.m.ik, who(t.m.name, ctx.acct)),
          })
      },
    },
    {
      id: 'p2p_member_timeout',
      title: 'Time Out',
      label: ctx => (timedOut(ctx) ? 'Change Timeout' : 'Time Out'),
      danger: true,
      dangerFor: ctx => !timedOut(ctx),
      ...onMember,
      order: 440,
      available: ctx => timesOut(ctx) !== null,
      menuRun: openTimeout,
      run: openTimeout,
    },
    {
      id: 'p2p_member_untimeout',
      title: 'Remove Timeout',
      ...onMember,
      order: 450,
      available: ctx => timesOut(ctx) !== null && timedOut(ctx),
      run: ctx => {
        const t = memberOf(ctx)
        if (t) void identity().p2pServer.untimeout(t.v.id, t.m.ik)
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
        if (p)
          moveRoles(
            p.v,
            placeRole(p.v.roles, p.r.id, p.at - 1, p.v.rank, identity().p2p.limits().server),
            ctx.acct
          )
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
        if (p)
          moveRoles(
            p.v,
            placeRole(p.v.roles, p.r.id, p.at + 1, p.v.rank, identity().p2p.limits().server),
            ctx.acct
          )
      },
    },
    {
      id: 'p2p_role_show_up',
      title: 'Show Higher',
      subtitle: () => 'In the member list',
      ...onRole,
      order: 120,
      available: ctx => shownStep(ctx, -1) !== null,
      run: ctx => show(shownStep(ctx, -1)),
    },
    {
      id: 'p2p_role_show_down',
      title: 'Show Lower',
      subtitle: () => 'In the member list',
      ...onRole,
      order: 130,
      available: ctx => shownStep(ctx, 1) !== null,
      run: ctx => show(shownStep(ctx, 1)),
    },
    {
      id: 'p2p_role_show_ranked',
      title: 'Show in Role Order',
      ...onRole,
      order: 140,
      available: ctx => followMoves(ctx) !== null,
      run: ctx => show(followMoves(ctx)),
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
        if (p) deleteRole(p.v, p.r, ctx.acct)
      },
    },
  ]

  // Categories: who manages channels creates, renames and deletes them, moves channels between
  // them and syncs a channel's overwrites with its category's.
  const categoryOf = ({ target }: ActionCtx) => (target.kind === 'p2p_category' ? target : null)
  const managedCategory = (ctx: ActionCtx) => {
    const t = categoryOf(ctx)
    return t && can(t.v, P.ManageChannels) ? t : null
  }
  const nameArg = (prompt: string) => ({
    kind: 'text' as const,
    name: 'name',
    prompt,
    check: (text: string) => (text.trim() ? null : 'Enter a name'),
  })
  const onCategory = { scope: 'p2p', targets: ['p2p_category'] } as const

  const categoryActions: Action[] = [
    {
      id: 'p2p_category_create',
      title: 'Create Category',
      scope: 'p2p',
      targets: ['p2p_server'],
      order: 260,
      args: [nameArg('Category name')],
      available: ctx => {
        const t = ctx.target.kind === 'p2p_server' ? ctx.target : null
        return !!t && can(t.v, P.ManageChannels)
      },
      run: (ctx, { name }) => {
        const t = ctx.target.kind === 'p2p_server' ? ctx.target : null
        if (t && name?.trim()) void identity().p2pServer.createCategory(t.v.id, name)
      },
    },
    {
      id: 'p2p_category_channel',
      title: 'Create Channel',
      ...onCategory,
      order: 100,
      args: [nameArg('Channel name')],
      available: ctx => managedCategory(ctx) !== null,
      run: (ctx, { name }) => {
        const t = managedCategory(ctx)
        if (t && name?.trim()) void identity().p2pServer.addChannelIn(t.v.id, name, t.cat.id)
      },
    },
    {
      id: 'p2p_category_edit',
      title: 'Rename Category',
      ...onCategory,
      order: 110,
      args: [nameArg('Category name')],
      available: ctx => managedCategory(ctx) !== null,
      run: (ctx, { name }) => {
        const t = managedCategory(ctx)
        if (t && name?.trim()) void identity().p2pServer.editCategory(t.v.id, t.cat.id, { name })
      },
    },
    {
      id: 'p2p_category_permissions',
      title: 'Permissions',
      ...onCategory,
      order: 120,
      available: ctx => managedCategory(ctx) !== null,
      run: ctx => {
        const t = managedCategory(ctx)
        if (t) identity().p2p.openDialog({ kind: 'perms', room: t.v.id, cat: t.cat.id })
      },
    },
    {
      id: 'p2p_category_delete',
      title: 'Delete Category',
      danger: true,
      ...onCategory,
      order: 130,
      available: ctx => managedCategory(ctx) !== null,
      run: ctx => {
        const t = managedCategory(ctx)
        if (!t) return
        ctx.acct.store.getState().askConfirm({
          title: 'Delete Category',
          body: `Delete the category ${t.cat.name}? Its channels are kept and move out of it.`,
          confirm: 'Delete',
          action: identity().inIdentity(
            () => void identity().p2pServer.deleteCategory(t.v.id, t.cat.id)
          ),
        })
      },
    },
    {
      id: 'p2p_channel_move_category',
      title: 'Move to Category',
      scope: 'p2p',
      targets: ['p2p_channel'],
      order: 305,
      args: [
        {
          kind: 'choice',
          name: 'cat',
          prompt: 'Category',
          choices: ctx => {
            const t = managed(ctx)
            if (!t) return []
            return [
              { value: '', label: 'No category', checked: t.ch.cat === null },
              ...t.v.categories.map(c => ({
                value: c.id,
                label: c.name,
                checked: t.ch.cat === c.id,
              })),
            ]
          },
        },
      ],
      available: ctx => {
        const t = managed(ctx)
        return !!t && t.v.categories.length > 0
      },
      run: (ctx, { cat }) => {
        const t = managed(ctx)
        if (t && cat !== undefined && (cat || null) !== t.ch.cat)
          void identity().p2pServer.placeChannel(t.v.id, t.ch.id, cat || null)
      },
    },
    {
      id: 'p2p_channel_perm_sync',
      title: 'Sync Permissions',
      subtitle: () => 'With its category',
      scope: 'p2p',
      targets: ['p2p_channel'],
      order: 306,
      available: ctx => {
        const t = managed(ctx)
        return !!t && t.ch.cat !== null && !t.ch.sync
      },
      run: async ctx => {
        const t = managed(ctx)
        const cat = t && t.v.categories.find(c => c.id === t.ch.cat)
        if (!t || !cat) return
        const widens = await identity().p2pServer.syncWidens(t.v.id, t.ch.id)
        if (widens === null) return
        const go = () => void identity().p2pServer.syncChannel(t.v.id, t.ch.id)
        if (!widens.length) return go()
        ctx.acct.store.getState().askConfirm({
          title: 'Sync Permissions',
          body: syncConfirmText(
            cat.name,
            `#${t.ch.name}`,
            subjectNames(widens, subj =>
              subjectName(t.v, subj, roleMask(t.v, ctx.acct), ctx.s.streamer)
            )
          ),
          confirm: 'Sync',
          action: identity().inIdentity(go),
        })
      },
    },
  ]

  const p2pServerActions: Action[] = [
    ...serverActions,
    ...folderActions,
    ...channelActions,
    ...memberActions,
    ...roleActions,
    ...categoryActions,
  ]

  return {
    actions: p2pServerActions,
    withdrawRequest,
    transferRequest,
    confirmForget,
    kickRequest,
    roleMask,
    moveRoles,
    deleteRole,
    takeRole,
  }
})
export const p2pServerActions = peerServer.actions
