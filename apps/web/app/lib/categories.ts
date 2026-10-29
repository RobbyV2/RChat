import type { Category, Channel, ChannelLayout, ServerDetail } from './types'

export const NO_CATEGORY = 'c:none'
export const CATEGORIES_ZONE = 'cats'

export const zoneOf = (category: number | null) =>
  category === null ? NO_CATEGORY : `c:${category}`

export const categoryOfZone = (zone: string): number | null | undefined => {
  if (zone === NO_CATEGORY) return null
  const m = /^c:(\d+)$/.exec(zone)
  return m ? Number(m[1]) : undefined
}

export const categoryKey = (id: number) => `cat:${id}`

export interface ChannelGroup {
  category: Category
  channels: Channel[]
}

export interface ChannelGroups {
  uncategorized: Channel[]
  categories: ChannelGroup[]
}

const byPosition = <T extends { id: number; position?: number }>(a: T, b: T) =>
  (a.position ?? 0) - (b.position ?? 0) || a.id - b.id

// The sidebar order: channels without a category first, then each category with its channels.
// Categories without a visible channel are left out unless `keepEmpty` (people who manage
// channels see them all).
export const channelGroups = (detail: ServerDetail, keepEmpty: boolean): ChannelGroups => {
  const categories = [...(detail.categories ?? [])].sort(byPosition)
  const known = new Set(categories.map(c => c.id))
  const channels = [...detail.channels].sort(byPosition)
  const inCategory = (id: number | null) =>
    channels.filter(
      c => (c.category_id != null && known.has(c.category_id) ? c.category_id : null) === id
    )
  return {
    uncategorized: inCategory(null),
    categories: categories
      .map(category => ({ category, channels: inCategory(category.id) }))
      .filter(g => keepEmpty || g.channels.length > 0),
  }
}

// Applies a layout to the cached server: the category list is replaced, channels it lists get
// their category and position, channels it leaves out stay where they were.
export const applyLayout = (detail: ServerDetail, layout: ChannelLayout): ServerDetail => {
  const place = new Map<number, { category_id: number | null; position: number }>()
  let position = 0
  for (const id of layout.uncategorized) place.set(id, { category_id: null, position: position++ })
  for (const c of layout.categories)
    for (const id of c.channels) place.set(id, { category_id: c.id, position: position++ })
  return {
    ...detail,
    layout_version: layout.version,
    categories: layout.categories.map((c, i) => ({ id: c.id, name: c.name, position: i })),
    channels: detail.channels.map(c => {
      const p = place.get(c.id)
      return p ? { ...c, ...p } : c
    }),
  }
}

export interface LayoutOrder {
  uncategorized: number[]
  categories: { id: number; channels: number[] }[]
}

export const layoutOrder = (detail: ServerDetail): LayoutOrder => {
  const groups = channelGroups(detail, true)
  return {
    uncategorized: groups.uncategorized.map(c => c.id),
    categories: groups.categories.map(g => ({
      id: g.category.id,
      channels: g.channels.map(c => c.id),
    })),
  }
}

const insertAt = (list: number[], id: number, index: number) => {
  const rest = list.filter(x => x !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

// Moves a channel to `index` among the channels of `category` (null: no category), the index
// counted without the moved channel.
export const moveChannel = (
  order: LayoutOrder,
  id: number,
  category: number | null,
  index: number
): LayoutOrder => {
  if (category !== null && !order.categories.some(c => c.id === category)) return order
  const strip = (list: number[]) => list.filter(x => x !== id)
  return {
    uncategorized:
      category === null ? insertAt(order.uncategorized, id, index) : strip(order.uncategorized),
    categories: order.categories.map(c => ({
      id: c.id,
      channels: c.id === category ? insertAt(c.channels, id, index) : strip(c.channels),
    })),
  }
}

export const moveCategory = (order: LayoutOrder, id: number, index: number): LayoutOrder => {
  const moved = order.categories.find(c => c.id === id)
  if (!moved) return order
  const rest = order.categories.filter(c => c.id !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return { ...order, categories: [...rest.slice(0, at), moved, ...rest.slice(at)] }
}

// The optimistic layout of an order, before the server answers.
export const orderLayout = (detail: ServerDetail, order: LayoutOrder): ChannelLayout => {
  const names = new Map((detail.categories ?? []).map(c => [c.id, c.name]))
  return {
    version: detail.layout_version ?? 0,
    uncategorized: order.uncategorized,
    categories: order.categories.map(c => ({
      id: c.id,
      name: names.get(c.id) ?? '',
      channels: c.channels,
    })),
  }
}

// Where a drop at `index` among the `shown` items of a list lands in the `full` list (both
// without the moved item): before the shown item at `index`, else after the last shown one.
export const fullIndex = (full: number[], shown: number[], id: number, index: number) => {
  const base = full.filter(x => x !== id)
  const rest = shown.filter(x => x !== id)
  const anchor = rest[index]
  if (anchor !== undefined) {
    const at = base.indexOf(anchor)
    return at < 0 ? base.length : at
  }
  const last = rest[rest.length - 1]
  return last === undefined ? base.length : base.indexOf(last) + 1
}
