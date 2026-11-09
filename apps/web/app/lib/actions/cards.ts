// The menu of a Home card (Jump back in, Unread), with the card's own open, mark-read and forget.

import { CheckCheck, ExternalLink, Trash2 } from 'lucide-react'
import type { Action, ActionCtx } from './types'

const cardOf = ({ target }: ActionCtx) => (target.kind === 'card' ? target : null)

const onCard = { scope: 'global', targets: ['card'] } as const

export const cardActions: Action[] = [
  {
    id: 'card_open',
    title: 'Open',
    icon: ExternalLink,
    ...onCard,
    order: 100,
    available: ctx => cardOf(ctx) !== null,
    run: ctx => cardOf(ctx)?.open(),
  },
  {
    id: 'card_mark_read',
    title: 'Mark as read',
    icon: CheckCheck,
    ...onCard,
    order: 110,
    available: ctx => cardOf(ctx) !== null,
    disabled: ctx => !cardOf(ctx)?.read.length,
    run: ctx => cardOf(ctx)?.markRead(),
  },
  {
    id: 'card_forget',
    title: 'Remove from Jump back in',
    icon: Trash2,
    ...onCard,
    order: 120,
    available: ctx => !!cardOf(ctx)?.forget,
    run: ctx => cardOf(ctx)?.forget?.(),
  },
]
