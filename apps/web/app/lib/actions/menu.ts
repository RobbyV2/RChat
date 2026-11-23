import { useSyncExternalStore } from 'react'
import { client } from '../client/client'
import type { AccountSession } from '../client/session'
import { guestPostingStatus } from '../guest_chat'
import { openPaletteAt } from '../palette_store'
import { useStore } from '../store'
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
  if (step.kind !== 'choice') return { action: () => openPaletteAt(a.id, ctx.target) }
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
  const a = actionById(id)
  return a && isAvailable(a, ctx) ? (guardAction(a, () => rows(a, ctx), [])[0]?.item ?? null) : null
}

const idsOf = (built: Built[]) => JSON.stringify(built.map(r => r.id))

interface OpenActionMenu {
  ctx: ActionCtx
  store: AccountSession['store']
  menu: ContextMenuState
  ids: string
  unsubscribe: () => void
}
let live: OpenActionMenu | null = null

// Whether the menu of `target` has a row now, as the store and the registry change; none for
// no target. A button that opens the menu shows only while it does.
export const useHasMenu = (target: Target | null) => {
  useSyncExternalStore(subscribeActions, actionsVersion, actionsVersion)
  return useStore(s => target !== null && menuRows(ctxFor(s, target, 'menu')).length > 0)
}

// Whether `menu` is the open action menu, which follows the registry by itself.
export const isActionMenu = (menu: ContextMenuState | null) => menu !== null && live?.menu === menu

export const openActionMenu = (
  x: number,
  y: number,
  target: Target,
  opts: ContextMenuOptions = {},
  account = client.shown()
) => {
  const { store } = account
  const st = store.getState()
  const ctx = ctxFor(st, target, 'menu')
  ctx.current = store.getState
  const built = menuRows(ctx)
  if (!built.length) return
  const items = built.map(r => r.item)
  st.openContextMenu(x, y, items, opts)
  const menu = store.getState().contextMenu
  if (!menu) return
  live?.unsubscribe()
  const unsubscribe = store.subscribe((state, previous) => {
    if (live?.store !== store) return
    if (state.contextMenu !== live.menu) {
      live.unsubscribe()
      live = null
      return
    }
    if (live.ctx.target.kind !== 'message') return
    const { server, message } = live.ctx
    const channel = message?.channel_id ?? null
    if (
      guestPostingStatus(state, server, channel) !== guestPostingStatus(previous, server, channel)
    )
      refreshOpenMenu()
  })
  live = { ctx, store, menu, ids: idsOf(built), unsubscribe }
}

// One action's choices as a menu of their own, as its submenu shows them (a row's Roles button).
export const openChoiceMenu = (
  x: number,
  y: number,
  id: string,
  target: Target,
  opts: ContextMenuOptions = {},
  current = useStore.getState
) => {
  const st = current()
  const ctx = ctxFor(st, target, 'menu')
  ctx.current = current
  const items = itemFor(id, ctx)?.submenu
  if (items?.length) st.openContextMenu(x, y, items, opts)
}

// An open action menu (or sheet) follows actions defined or removed while it shows, and keeps
// its state while its rows stay the same.
const refreshOpenMenu = () => {
  const open = live
  if (!open) return
  const ctx = refreshCtx(open.ctx)
  const built = ctx ? menuRows(ctx) : []
  if (!ctx || !built.length) {
    open.store.getState().closeContextMenu()
    return
  }
  const ids = idsOf(built)
  if (ids === open.ids) return
  const next = { ...open.menu, items: built.map(r => r.item) }
  live = { ...open, ctx, menu: next, ids }
  open.store.setState({ contextMenu: next })
}

subscribeActions(refreshOpenMenu)
