import type { CategoryView, ChannelView, ServerView } from './p2p/server/types'
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

// Something the sidebar lists in order: by `position`, then by id.
export interface Placed<Id extends number | string> {
  id: Id
  position?: number
}

// A channel in a category (`category_id`), or in none.
export interface InCategory<Id extends number | string> extends Placed<Id> {
  category_id?: Id | null
}

export interface Groups<Ch, Cat> {
  uncategorized: Ch[]
  categories: { category: Cat; channels: Ch[] }[]
}

const byPlace = <Id extends number | string>(a: Placed<Id>, b: Placed<Id>) =>
  (a.position ?? 0) - (b.position ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The sidebar order of hosted servers and P2P rooms alike: channels without a category first,
// then each category with its channels, every list by place. A channel whose category is not
// listed shows without one. Categories without a channel are left out unless `keepEmpty`
// (people who manage channels see them all).
export const groupChannels = <
  Id extends number | string,
  Ch extends InCategory<Id>,
  Cat extends Placed<Id>,
>(
  channels: readonly Ch[],
  categories: readonly Cat[],
  keepEmpty: boolean
): Groups<Ch, Cat> => {
  const sorted = [...categories].sort(byPlace)
  const known = new Set(sorted.map(c => c.id))
  const listed = [...channels].sort(byPlace)
  const inCategory = (id: Id | null) =>
    listed.filter(
      c => (c.category_id != null && known.has(c.category_id) ? c.category_id : null) === id
    )
  return {
    uncategorized: inCategory(null),
    categories: sorted
      .map(category => ({ category, channels: inCategory(category.id) }))
      .filter(g => keepEmpty || g.channels.length > 0),
  }
}

export type ChannelGroups = Groups<Channel, Category>
export type ChannelGroup = ChannelGroups['categories'][number]

export const channelGroups = (detail: ServerDetail, keepEmpty: boolean): ChannelGroups =>
  groupChannels(detail.channels, detail.categories ?? [], keepEmpty)

// A P2P room's channels and categories in the same order.
export const roomGroups = (
  v: Pick<ServerView, 'channels' | 'categories'>,
  keepEmpty: boolean
): Groups<ChannelView, CategoryView> => {
  const groups = groupChannels(
    v.channels.map(ch => ({ id: ch.id, position: ch.pos, category_id: ch.cat, ch })),
    v.categories.map(cat => ({ id: cat.id, position: cat.pos, cat })),
    keepEmpty
  )
  return {
    uncategorized: groups.uncategorized.map(c => c.ch),
    categories: groups.categories.map(g => ({
      category: g.category.cat,
      channels: g.channels.map(c => c.ch),
    })),
  }
}

// "@everyone, Mods and bob".
export const namesText = (names: readonly string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`

// The names of the subjects a sync lets in; a pair of roles (`a+b`) reads "A with B".
export const subjectNames = (subjects: readonly string[], nameOf: (subject: string) => string) =>
  subjects.map(s => s.split('+').map(nameOf).join(' with '))

// What syncing a channel with its category asks before it lets more people in.
export const syncConfirmText = (category: string, channel: string, names: readonly string[]) =>
  `Syncing with ${category} lets ${namesText(names)} see or send in ${channel}.`

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
      if (!p) return c
      // A move ends copying a category's rules.
      const moved = (c.category_id ?? null) !== p.category_id
      return moved ? { ...c, ...p, perm_sync: false } : { ...c, ...p }
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
