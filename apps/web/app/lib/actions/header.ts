// What a narrow channel or DM header folds into its More button.

import { Pin, Search, SquareCheckBig } from 'lucide-react'
import { PINS_TITLE } from '../pins'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

const headerOf = ({ target }: ActionCtx) => (target.kind === 'header' ? target : null)

// The header's conversation; none in a voice channel.
const listOf = (ctx: ActionCtx) => headerOf(ctx)?.list ?? null

const onHeader = { scope: 'channel', targets: ['header'] } as const

export const headerActions: Action[] = [
  {
    id: 'header_select',
    title: 'Select Messages',
    icon: SquareCheckBig,
    ...onHeader,
    order: 100,
    available: ctx => listOf(ctx) !== null && signedIn(ctx.s),
    run: ctx => {
      const list = listOf(ctx)
      if (list) ctx.acct.store.getState().startSelection(list)
    },
  },
  {
    id: 'header_pins',
    title: PINS_TITLE,
    icon: Pin,
    ...onHeader,
    order: 110,
    available: ctx => listOf(ctx) !== null,
    run: ({ acct }) => acct.store.getState().openPins(),
  },
  {
    id: 'header_search',
    title: 'Search',
    icon: Search,
    ...onHeader,
    order: 120,
    available: ctx => headerOf(ctx)?.search === true,
    run: ({ acct }) => acct.store.getState().openSearch(),
  },
]
