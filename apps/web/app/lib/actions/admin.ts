// Site admin actions. They show only in the hidden site admin's own session.

import { useStore } from '../store'
import { isWebhookAuthor } from '../webhooks'
import { signedIn } from './global'
import type { Action } from './types'

export const adminActions: Action[] = [
  {
    id: 'admin_ban_site_wide',
    title: 'Ban site-wide',
    scope: 'admin',
    danger: true,
    targets: ['member'],
    order: 490,
    available: ({ s, target }) =>
      signedIn(s) &&
      !!s.me?.is_site_admin &&
      target.kind === 'member' &&
      target.where === 'list' &&
      target.user.username !== s.me.username &&
      !isWebhookAuthor(target.user.username),
    run: ({ target }) => {
      if (target.kind === 'member')
        useStore.getState().openDialog({ kind: 'ban_confirm', username: target.user.username })
    },
  },
]
