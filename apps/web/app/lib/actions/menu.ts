import { openPaletteAt } from '../palette_store'
import { useStore } from '../store'
import type { ContextMenuItem, ContextMenuOptions, ContextMenuState } from '../store_types'
import { ctxFor, refreshCtx } from './ctx'
import {
  actionById,
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
  if (!a.expand) return a.menuRun || askable(a, ctx) ? [{ id: a.id, item: rowOf(a, ctx) }] : []
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

let live: { ctx: ActionCtx; menu: ContextMenuState | null; ids: string } | null = null

export const openActionMenu = (
  x: number,
  y: number,
  target: Target,
  opts: ContextMenuOptions = {}
) => {
  const st = useStore.getState()
  const ctx = ctxFor(st, target, 'menu')
  const built = menuRows(ctx)
  if (!built.length) return
  const items = built.map(r => r.item)
  st.openContextMenu(x, y, items, opts)
  live = { ctx, menu: useStore.getState().contextMenu, ids: idsOf(built) }
}

// An open action menu (or sheet) follows actions defined or removed while it shows, and keeps
// its state while its rows stay the same.
subscribeActions(() => {
  const open = live
  const menu = useStore.getState().contextMenu
  live = null
  if (!open || !menu || menu !== open.menu) return
  const ctx = refreshCtx(open.ctx)
  const built = ctx ? menuRows(ctx) : []
  if (!ctx || !built.length) {
    useStore.getState().closeContextMenu()
    return
  }
  const ids = idsOf(built)
  if (ids === open.ids) {
    live = open
    return
  }
  const next = { ...menu, items: built.map(r => r.item) }
  useStore.setState({ contextMenu: next })
  live = { ctx, menu: next, ids }
})
