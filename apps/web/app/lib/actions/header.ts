// What a narrow channel or DM header folds into its More button.

import { MessagesSquare, Pin, Search, SquareCheckBig } from 'lucide-react'
import { PINS_TITLE } from '../pins'
import { THREADS_TITLE } from '../thread_list'
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
    available: ctx => listOf(ctx) !== null || !!headerOf(ctx)?.pins,
    run: ctx => {
      const pins = headerOf(ctx)?.pins
      if (pins) pins.open()
      else ctx.acct.store.getState().openPins()
    },
  },
  {
    id: 'header_threads',
    title: THREADS_TITLE,
    icon: MessagesSquare,
    ...onHeader,
    order: 115,
    available: ctx => listOf(ctx) !== null || !!headerOf(ctx)?.threads,
    run: ctx => {
      const threads = headerOf(ctx)?.threads
      if (threads) threads.open()
      else ctx.acct.store.getState().openThreads()
    },
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
