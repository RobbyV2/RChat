import { Eye } from 'lucide-react'
import { hiddenOnScreen, hiddenWords, revealWords, withActionElement } from '../masked_reveal'
import { useStore } from '../store'
import { ctxFor } from './ctx'
import { actionById, isAvailable, runAction } from './registry'
import type { Action, ActionCtx, Target } from './types'

export const REVEAL_ACTION = 'show_masked_text'

// The masked words of the row or option acted on; from the palette itself, those on screen.
const hiddenFor = (ctx: ActionCtx) =>
  ctx.element
    ? hiddenWords(ctx.element)
    : ctx.via === 'palette' && ctx.target.kind === 'none'
      ? hiddenOnScreen()
      : []

// Whether a target's row can show masked text; every kind is listed, so a new one is decided here.
const ROWS: Record<Target['kind'], boolean> = {
  none: false,
  message: true,
  selection: false,
  member: true,
  server: true,
  folder: true,
  channel: true,
  category: true,
  dm: true,
  home: false,
  embed: true,
  timestamp: false,
  inbox: true,
  card: true,
  call: false,
  p2p_contact: true,
}

export const maskedActions: Action[] = [
  {
    id: REVEAL_ACTION,
    title: 'Show masked text',
    keywords: ['reveal', 'unmask', 'profanity', 'filter', 'censored'],
    icon: Eye,
    scope: 'global',
    targets: (Object.keys(ROWS) as Target['kind'][]).filter(k => ROWS[k]),
    order: 890,
    available: ctx => hiddenFor(ctx).length > 0,
    run: ctx => revealWords(hiddenFor(ctx)),
  },
]

// Alt+Enter in the palette: the action on `el` (the active option) when it shows masked words.
export const revealMasked = (el: Element | null): boolean =>
  withActionElement(el, () => {
    const a = actionById(REVEAL_ACTION)
    const ctx = ctxFor(useStore.getState(), { kind: 'none' }, 'key')
    if (!el || !a || !isAvailable(a, ctx)) return false
    void runAction(REVEAL_ACTION, ctx)
    return true
  })
