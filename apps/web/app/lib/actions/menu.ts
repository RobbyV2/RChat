import { useSyncExternalStore } from 'react'
import { guestPostingStatus } from '../guest_chat'
import { openPaletteAt } from '../palette_store'
import { useStore } from 'zustand'
import { useAccount } from '../client/react'
import { client } from '../client/client'
import type { ContextMenuItem, ContextMenuOptions, ContextMenuState } from '../store_types'
import { ctxFor, refreshCtx } from './ctx'
import {
  actionById,
  actionsVersion,
  guardAction,
  isAvailable,
  labelOf,
  recheckAction,
  subscribeActions,
  targetActions,
} from './registry'
import {
  askable,
  confirmThenRun,
  dangerOf,
  expansionsOf,
  iconOf,
  runExpansion,
  valueSteps,
} from './steps'
import type { Action, ActionCtx, Target } from './types'

const picked = (a: Action, ctx: ActionCtx): Pick<ContextMenuItem, 'action' | 'submenu'> => {
  if (a.menuRun)
    return {
      action: () => {
        const hit = recheckAction(a.id, ctx)
        if (hit) hit.action.menuRun?.(hit.ctx)
      },
    }
  const [step] = valueSteps(a)
  if (!step) return { action: () => void confirmThenRun(a, ctx, {}) }
  if (step.kind !== 'choice') return { action: () => openPaletteAt(a.id, ctx.target, ctx.acct) }
  return {
    submenu: step.choices(ctx, '').map(c => ({
      label: c.label,
      subtitle: c.subtitle,
      wrap: c.wrap,
      danger: c.danger,
      disabled: c.disabled,
      icon: c.icon,
      swatch: c.swatch,
      checked: c.checked,
      radio: c.radio,
      action: () => void confirmThenRun(a, ctx, { [step.name]: c.value }),
    })),
  }
}

const rowOf = (a: Action, ctx: ActionCtx): ContextMenuItem => ({
  label: labelOf(a, ctx),
  subtitle: a.subtitle?.(ctx),
  wrap: a.wrap,
  danger: dangerOf(a, ctx),
  disabled: a.disabled?.(ctx),
  icon: iconOf(a, ctx),
  checked: a.checked?.(ctx),
  radio: a.radio,
  ...picked(a, ctx),
})

interface Built {
  id: string
  item: ContextMenuItem
}

const rows = (a: Action, ctx: ActionCtx): Built[] => {
  if (!a.expand) {
    if (a.menuRun || askable(a, ctx)) return [{ id: a.id, item: rowOf(a, ctx) }]
    // A choice with nothing to pick keeps its row, open to its dimmed choices, when the action
    // says it is disabled.
    if (valueSteps(a).length !== 1 || !a.disabled?.(ctx)) return []
    const item = rowOf(a, ctx)
    return item.submenu?.length ? [{ id: a.id, item: { ...item, disabled: false } }] : []
  }
  const disabled = a.disabled?.(ctx)
  return expansionsOf(a, ctx).map(x => ({
    id: `${a.id}_${x.key}`,
    item: {
      label: x.label,
      subtitle: x.subtitle,
      wrap: x.wrap,
      danger: x.danger ?? a.danger,
      disabled,
      icon: x.icon ?? iconOf(a, ctx),
      checked: x.checked,
      radio: x.radio,
      action: () => void runExpansion(a, ctx, x.key),
    },
  }))
}

const menuRows = (ctx: ActionCtx) =>
  targetActions(ctx).flatMap(a => (a.menu === false ? [] : guardAction(a, () => rows(a, ctx), [])))

export const menuItems = (ctx: ActionCtx): ContextMenuItem[] => menuRows(ctx).map(r => r.item)

export const itemFor = (id: string, ctx: ActionCtx): ContextMenuItem | null => {
  const a = actionById(id, ctx)
  return a && isAvailable(a, ctx) ? (guardAction(a, () => rows(a, ctx), [])[0]?.item ?? null) : null
}

const idsOf = (built: Built[]) => JSON.stringify(built.map(r => r.id))

let live: { ctx: ActionCtx; menu: ContextMenuState | null; ids: string } | null = null

let unwatch: (() => void) | null = null
const clearLive = () => {
  unwatch?.()
  unwatch = null
  live = null
}

// Whether the menu of `target` has a row now, as the store and the registry change; none for
// no target. A button that opens the menu shows only while it does.
export const useHasMenu = (target: Target | null) => {
  useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion)
  const acct = useAccount()
  return useStore(
    acct.store,
    s => target !== null && menuRows(ctxFor(s, target, 'menu', acct)).length > 0
  )
}

// Whether `menu` is the open action menu, which follows the registry by itself.
export const isActionMenu = (menu: ContextMenuState | null) => menu !== null && live?.menu === menu

export const openActionMenu = (
  x: number,
  y: number,
  target: Target,
  opts: ContextMenuOptions = {},
  acct = client.shown(),
  identity?: ActionCtx['identity']
) => {
  if (identity) acct.identities.show(identity)
  const st = acct.store.getState()
  const ctx = ctxFor(st, target, 'menu', acct, identity)
  const built = menuRows(ctx)
  if (!built.length) return
  const items = built.map(r => r.item)
  st.openContextMenu(x, y, items, opts)
  clearLive()
  const menu = acct.store.getState().contextMenu
  if (!menu) return
  live = { ctx, menu, ids: idsOf(built) }
  const off = acct.store.subscribe((state, previous) => {
    if (live?.ctx.acct !== acct) return
    if (state.contextMenu !== live.menu) {
      clearLive()
      return
    }
    if (ctx.target.kind !== 'message') return
    const channel = ctx.message?.channel_id ?? null
    if (
      guestPostingStatus(state, ctx.server, channel) !==
      guestPostingStatus(previous, ctx.server, channel)
    )
      refreshOpenMenu()
  })
  const offClient = client.subscribe(() => {
    if (live?.ctx.acct === acct && !client.live().includes(acct)) clearLive()
  })
  unwatch = () => {
    off()
    offClient()
  }
}

// One action's choices as a menu of their own, as its submenu shows them (a row's Roles button).
export const openChoiceMenu = (
  x: number,
  y: number,
  id: string,
  target: Target,
  opts: ContextMenuOptions = {},
  acct = client.shown(),
  identity?: ActionCtx['identity']
) => {
  if (identity) acct.identities.show(identity)
  const st = acct.store.getState()
  const ctx = ctxFor(st, target, 'menu', acct, identity)
  const items = itemFor(id, ctx)?.submenu
  if (items?.length) st.openContextMenu(x, y, items, opts)
}

// An open action menu (or sheet) follows actions defined or removed while it shows, and keeps
// its state while its rows stay the same.
const refreshOpenMenu = () => {
  const open = live
  if (!open) return
  const { acct } = open.ctx
  const menu = acct.store.getState().contextMenu
  if (!menu || menu !== open.menu) return
  const ctx = refreshCtx(open.ctx)
  const built = ctx ? menuRows(ctx) : []
  if (!ctx || !built.length) {
    acct.store.getState().closeContextMenu()
    return
  }
  const ids = idsOf(built)
  if (ids === open.ids) return
  const next = { ...menu, items: built.map(r => r.item) }
  live = { ctx, menu: next, ids }
  acct.store.setState({ contextMenu: next })
}

subscribeActions(refreshOpenMenu)
