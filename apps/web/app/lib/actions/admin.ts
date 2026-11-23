// Site admin actions. They show only in the hidden site admin's own session.

import { KeyRound, LogOut, Shield, UserPlus, UserRound } from 'lucide-react'
import { isNotice } from '../system_messages'
import type { UserRef } from '../types'
import { isWebhookAuthor, isWebhookMessage } from '../webhooks'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

// The person a site ban or phrase removal row is about: someone else on a member list row or
// on a row of the admin page's accounts, or the author of a message in a channel or DM.
const banned = ({ s, target }: ActionCtx): UserRef | null => {
  if (!signedIn(s) || !s.me?.is_site_admin) return null
  const u =
    target.kind === 'member'
      ? target.where === 'list' || target.where === 'admin'
        ? target.user
        : null
      : target.kind === 'message' &&
          !target.list.startsWith('t') &&
          !isNotice(target.message) &&
          !isWebhookMessage(target.message)
        ? target.message.author
        : null
  return u && u.username !== s.me.username && !isWebhookAuthor(u.username) ? u : null
}

// The account of a row of the admin page's accounts.
const listed = ({ s, target }: ActionCtx): UserRef | null =>
  signedIn(s) && s.me?.is_site_admin && target.kind === 'member' && target.where === 'admin'
    ? target.user
    : null

// That account, when it is not the admin's own.
const other = (ctx: ActionCtx): UserRef | null => {
  const u = listed(ctx)
  return u && u.username !== ctx.s.me?.username ? u : null
}

export const adminActions: Action[] = [
  {
    id: 'open_site_admin',
    title: 'Open site administration',
    scope: 'admin',
    icon: Shield,
    keywords: ['admin', 'features', 'users', 'servers', 'audit'],
    available: ({ s }) => signedIn(s) && s.me?.is_site_admin === true,
    run: ({ acct }) => acct.store.getState().openAdmin(),
  },
  {
    id: 'admin_ban_site_wide',
    title: 'Ban site-wide',
    scope: 'admin',
    danger: true,
    targets: ['member', 'message'],
    order: 490,
    available: ctx => banned(ctx) !== null,
    run: ctx => {
      const u = banned(ctx)
      if (u) ctx.acct.store.getState().openDialog({ kind: 'ban_confirm', username: u.username })
    },
  },
  {
    id: 'admin_open_account',
    title: 'Open account',
    scope: 'admin',
    icon: UserRound,
    targets: ['member'],
    order: 480,
    available: ctx => listed(ctx) !== null,
    run: ctx => {
      const u = listed(ctx)
      if (u) ctx.acct.store.getState().openAdmin('users', u.username)
    },
  },
  {
    id: 'admin_new_password',
    title: 'New temporary password',
    scope: 'admin',
    icon: KeyRound,
    targets: ['member'],
    order: 481,
    available: ctx => other(ctx) !== null,
    run: ctx => {
      const u = other(ctx)
      if (u)
        ctx.acct.store.getState().openDialog({ kind: 'new_password_confirm', username: u.username })
    },
  },
  {
    id: 'admin_sign_out',
    title: 'Sign out everywhere',
    scope: 'admin',
    icon: LogOut,
    targets: ['member'],
    order: 482,
    available: ctx => other(ctx) !== null,
    run: ctx => {
      const u = other(ctx)
      if (u)
        ctx.acct.store.getState().openDialog({ kind: 'sign_out_confirm', username: u.username })
    },
  },
  {
    id: 'admin_add_to_server',
    title: 'Add to server',
    scope: 'admin',
    icon: UserPlus,
    targets: ['member'],
    order: 483,
    available: ctx => listed(ctx) !== null,
    run: ctx => {
      const u = listed(ctx)
      if (u)
        ctx.acct.store.getState().openDialog({ kind: 'admin_add_to_server', username: u.username })
    },
  },
  {
    id: 'admin_delete_account',
    title: 'Delete account',
    scope: 'admin',
    danger: true,
    targets: ['member'],
    order: 491,
    available: ctx => other(ctx) !== null,
    run: ctx => {
      const u = other(ctx)
      if (u)
        ctx.acct.store.getState().openDialog({ kind: 'delete_user_confirm', username: u.username })
    },
  },
  {
    id: 'admin_remove_phrase',
    title: 'Remove backup phrase',
    scope: 'admin',
    icon: KeyRound,
    danger: true,
    targets: ['member', 'message'],
    order: 489,
    available: ctx => banned(ctx) !== null,
    run: ctx => {
      const u = banned(ctx)
      if (u)
        ctx.acct.store
          .getState()
          .openDialog({ kind: 'remove_phrase_confirm', username: u.username })
    },
  },
]
