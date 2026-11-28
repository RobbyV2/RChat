import type { ContextMenuItem, ContextMenuOptions, ContextMenuState } from '../../store_types'

// An open menu with rows a test wrote by hand, as the menu on screen draws any rows.
export const menuOf = (
  x: number,
  y: number,
  items: ContextMenuItem[],
  opts: ContextMenuOptions = {}
) => ({ ...opts, x, y, items }) as ContextMenuState
