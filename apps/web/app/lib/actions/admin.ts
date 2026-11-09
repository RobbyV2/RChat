// Site admin actions. They show only in the hidden site admin's own session.

import { KeyRound } from 'lucide-react'
import { useStore } from '../store'
import { isNotice } from '../system_messages'
import type { UserRef } from '../types'
import { isWebhookAuthor, isWebhookMessage } from '../webhooks'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

// The person a site ban or phrase removal row is about: someone else on a member list row, or the
// author of a message in a channel or DM.
const banned = ({ s, target }: ActionCtx): UserRef | null => {
  if (!signedIn(s) || !s.me?.is_site_admin) return null
  const u =
    target.kind === 'member'
      ? target.where === 'list'
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

export const adminActions: Action[] = [
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
      if (u) useStore.getState().openDialog({ kind: 'ban_confirm', username: u.username })
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
      if (u) useStore.getState().openDialog({ kind: 'remove_phrase_confirm', username: u.username })
    },
  },
]
