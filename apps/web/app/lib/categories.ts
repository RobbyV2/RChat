import type { CategoryView, ChannelView, SeparatorView, ServerView } from './p2p/server/types'
import type {
  Category,
  CategoryStyle,
  Channel,
  ChannelLayout,
  Separator,
  SeparatorStyle,
  ServerDetail,
} from './types'

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
export const separatorKey = (id: number | string) => `sep:${id}`

export const CATEGORY_STYLES = ['default', 'dots', 'line'] as const satisfies CategoryStyle[]
export const SEPARATOR_STYLES = ['dots', 'line', 'plain'] as const satisfies SeparatorStyle[]
export const STYLE_NAMES: Record<CategoryStyle | SeparatorStyle, string> = {
  default: 'Plain caps',
  dots: 'Dotted line',
  line: 'Solid line',
  plain: 'No line',
}
// Separator labels, in characters.
export const SEPARATOR_LABEL_MAX = 100

// A style as received or stored; anything unknown reads as the default.
export const categoryStyleOf = (x: unknown): CategoryStyle =>
  CATEGORY_STYLES.find(s => s === x) ?? 'default'
export const separatorStyleOf = (x: unknown): SeparatorStyle =>
  SEPARATOR_STYLES.find(s => s === x) ?? 'dots'

// A label as it is saved: trimmed, kept as written, null when too long or with control
// characters.
export const separatorLabel = (raw: string): string | null => {
  const label = raw.trim()
  // eslint-disable-next-line no-control-regex
  return [...label].length > SEPARATOR_LABEL_MAX || /[\u0000-\u001f\u007f-\u009f]/.test(label)
    ? null
    : label
}

// Something the sidebar lists in order: by `position`, then by id.
export interface Placed<Id extends number | string> {
  id: Id
  position?: number
}

// A channel in a category (`category_id`), or in none.
export interface InCategory<Id extends number | string> extends Placed<Id> {
  category_id?: Id | null
}

// A separator in a category (`category_id`), or in none, below the first `after` channels of
// its list.
export interface InList<Id extends number | string> {
  category_id?: Id | null
  after: number
}

// A row of a channel list: a channel, or a separator between channels.
export type ListItem<Ch, Sep> =
  { kind: 'channel'; channel: Ch } | { kind: 'separator'; separator: Sep }

export interface Groups<Ch, Cat, Sep = never> {
  uncategorized: Ch[]
  // The channels without a category with their separators.
  loose: ListItem<Ch, Sep>[]
  categories: { category: Cat; channels: Ch[]; items: ListItem<Ch, Sep>[] }[]
}

const byPlace = <Id extends number | string>(a: Placed<Id>, b: Placed<Id>) =>
  (a.position ?? 0) - (b.position ?? 0) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

// The channels of a list with its separators between them: each separator below the first
// `after` channels, separators at one place in their given order.
export const mergeChannelsAndSeparators = <Ch, Sep extends { after: number }>(
  channels: readonly Ch[],
  separators: readonly Sep[]
): ListItem<Ch, Sep>[] => {
  const at = (s: Sep) => Math.max(0, Math.min(s.after, channels.length))
  const seps = separators.map((s, i) => ({ s, i })).sort((a, b) => at(a.s) - at(b.s) || a.i - b.i)
  const out: ListItem<Ch, Sep>[] = []
  let next = 0
  for (let k = 0; k <= channels.length; k++) {
    while (next < seps.length && at(seps[next].s) <= k)
      out.push({ kind: 'separator', separator: seps[next++].s })
    if (k < channels.length) out.push({ kind: 'channel', channel: channels[k] })
  }
  return out
}

// The sidebar order of hosted servers and P2P rooms alike: channels without a category first,
// then each category with its channels, every list by place, with the separators of each list.
// A channel or separator whose category is not listed shows without one. Categories without a
// channel are left out with their separators unless `keepEmpty` (people who manage channels
// see them all).
export const groupChannels = <
  Id extends number | string,
  Ch extends InCategory<Id>,
  Cat extends Placed<Id>,
  Sep extends InList<Id> = never,
>(
  channels: readonly Ch[],
  categories: readonly Cat[],
  keepEmpty: boolean,
  separators: readonly Sep[] = []
): Groups<Ch, Cat, Sep> => {
  const sorted = [...categories].sort(byPlace)
  const known = new Set(sorted.map(c => c.id))
  const listed = [...channels].sort(byPlace)
  const home = (id: Id | null | undefined) => (id != null && known.has(id) ? id : null)
  const inCategory = (id: Id | null) => listed.filter(c => home(c.category_id) === id)
  const items = (id: Id | null, list: Ch[]) =>
    mergeChannelsAndSeparators(
      list,
      separators.filter(s => home(s.category_id) === id)
    )
  const uncategorized = inCategory(null)
  return {
    uncategorized,
    loose: items(null, uncategorized),
    categories: sorted
      .map(category => {
        const list = inCategory(category.id)
        return { category, channels: list, items: items(category.id, list) }
      })
      .filter(g => keepEmpty || g.channels.length > 0),
  }
}

export type ChannelGroups = Groups<Channel, Category, Separator>
export type ChannelGroup = ChannelGroups['categories'][number]
export type ChannelItem = ListItem<Channel, Separator>

export const channelGroups = (detail: ServerDetail, keepEmpty: boolean): ChannelGroups =>
  groupChannels(detail.channels, detail.categories ?? [], keepEmpty, detail.separators ?? [])

export type RoomGroups = Groups<ChannelView, CategoryView, SeparatorView>
export type RoomItem = ListItem<ChannelView, SeparatorView>

// A P2P room's channels, categories and separators in the same order. A separator sits below
// the channels of its list placed at or above it (`pos`), separators at one place by id.
export const roomGroups = (
  v: Pick<ServerView, 'channels' | 'categories'> & { separators?: readonly SeparatorView[] },
  keepEmpty: boolean
): RoomGroups => {
  const known = new Set(v.categories.map(c => c.id))
  const home = (cat: string | null | undefined) => (cat != null && known.has(cat) ? cat : null)
  const seps = [...(v.separators ?? [])]
    .sort((a, b) => a.pos - b.pos || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map(sep => ({
      category_id: sep.cat,
      after: v.channels.filter(c => home(c.cat) === home(sep.cat) && c.pos <= sep.pos).length,
      sep,
    }))
  const groups = groupChannels(
    v.channels.map(ch => ({ id: ch.id, position: ch.pos, category_id: ch.cat, ch })),
    v.categories.map(cat => ({ id: cat.id, position: cat.pos, cat })),
    keepEmpty,
    seps
  )
  const item = (i: ListItem<{ ch: ChannelView }, { sep: SeparatorView }>): RoomItem =>
    i.kind === 'channel'
      ? { kind: 'channel', channel: i.channel.ch }
      : { kind: 'separator', separator: i.separator.sep }
  return {
    uncategorized: groups.uncategorized.map(c => c.ch),
    loose: groups.loose.map(item),
    categories: groups.categories.map(g => ({
      category: g.category.cat,
      channels: g.channels.map(c => c.ch),
      items: g.items.map(item),
    })),
  }
}

// Where a separator of a room goes when it moves one row up (-1) or down (1) in its list: the
// place between its new neighbours, null at the end of the list.
export const roomSeparatorStep = (
  items: readonly RoomItem[],
  id: string,
  step: -1 | 1
): number | null => {
  const at = items.findIndex(i => i.kind === 'separator' && i.separator.id === id)
  const to = at + step
  if (at < 0 || to < 0 || to >= items.length) return null
  const rest = items.filter((_, i) => i !== at)
  const posOf = (i: RoomItem | undefined) =>
    i === undefined ? undefined : i.kind === 'channel' ? i.channel.pos : i.separator.pos
  const above = posOf(rest[to - 1])
  const below = posOf(rest[to])
  if (above === undefined && below === undefined) return null
  if (above === undefined) return below! - 1
  if (below === undefined) return above + 1
  return (above + below) / 2
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

// Applies a layout to the cached server: the category and separator lists are replaced,
// channels it lists get their category and position, channels it leaves out stay where they
// were.
export const applyLayout = (detail: ServerDetail, layout: ChannelLayout): ServerDetail => {
  const place = new Map<number, { category_id: number | null; position: number }>()
  let position = 0
  for (const id of layout.uncategorized) place.set(id, { category_id: null, position: position++ })
  for (const c of layout.categories)
    for (const id of c.channels) place.set(id, { category_id: c.id, position: position++ })
  return {
    ...detail,
    layout_version: layout.version,
    categories: layout.categories.map((c, i) => ({
      id: c.id,
      name: c.name,
      position: i,
      ...(c.style ? { style: c.style } : {}),
    })),
    separators: layout.separators ?? detail.separators,
    channels: detail.channels.map(c => {
      const p = place.get(c.id)
      if (!p) return c
      // A move ends copying a category's rules.
      const moved = (c.category_id ?? null) !== p.category_id
      return moved ? { ...c, ...p, perm_sync: false } : { ...c, ...p }
    }),
  }
}

export interface SeparatorPlace {
  id: number
  category_id: number | null
  after: number
}

export interface LayoutOrder {
  uncategorized: number[]
  categories: { id: number; channels: number[] }[]
  separators: SeparatorPlace[]
}

// The key of a row of a hosted list in an order: `c<id>` for a channel, `s<id>` for a
// separator.
export const itemKey = (item: ChannelItem) =>
  item.kind === 'channel' ? `c${item.channel.id}` : `s${item.separator.id}`

const placesOf = (category: number | null, items: readonly ChannelItem[]): SeparatorPlace[] => {
  let after = 0
  const out: SeparatorPlace[] = []
  for (const i of items)
    if (i.kind === 'channel') after += 1
    else out.push({ id: i.separator.id, category_id: category, after })
  return out
}

export const layoutOrder = (detail: ServerDetail): LayoutOrder => {
  const groups = channelGroups(detail, true)
  return {
    uncategorized: groups.uncategorized.map(c => c.id),
    categories: groups.categories.map(g => ({
      id: g.category.id,
      channels: g.channels.map(c => c.id),
    })),
    separators: [
      ...placesOf(null, groups.loose),
      ...groups.categories.flatMap(g => placesOf(g.category.id, g.items)),
    ],
  }
}

// The keys of a list of an order (`category` null: the channels without one), top first.
export const orderKeys = (order: LayoutOrder, category: number | null): string[] => {
  const channels =
    category === null
      ? order.uncategorized
      : (order.categories.find(c => c.id === category)?.channels ?? [])
  const seps = order.separators.filter(s => s.category_id === category)
  return mergeChannelsAndSeparators(channels, seps).map(i =>
    i.kind === 'channel' ? `c${i.channel}` : `s${i.separator.id}`
  )
}

const fromKeys = (category: number | null, keys: readonly string[]) => {
  const channels: number[] = []
  const separators: SeparatorPlace[] = []
  for (const k of keys)
    if (k.startsWith('c')) channels.push(Number(k.slice(1)))
    else separators.push({ id: Number(k.slice(1)), category_id: category, after: channels.length })
  return { channels, separators }
}

const insertAt = <T>(list: readonly T[], id: T, index: number) => {
  const rest = list.filter(x => x !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, at), id, ...rest.slice(at)]
}

// Moves the row `key` (see `itemKey`) to `index` among the rows of `category` (null: no
// category), the index counted without the moved row.
export const moveItem = (
  order: LayoutOrder,
  key: string,
  category: number | null,
  index: number
): LayoutOrder => {
  if (category !== null && !order.categories.some(c => c.id === category)) return order
  const lists = [null, ...order.categories.map(c => c.id)].map(id => {
    const keys = orderKeys(order, id).filter(k => k !== key)
    return fromKeys(id, id === category ? insertAt(keys, key, index) : keys)
  })
  return {
    uncategorized: lists[0].channels,
    categories: order.categories.map((c, i) => ({ id: c.id, channels: lists[i + 1].channels })),
    separators: lists.flatMap(l => l.separators),
  }
}

export const moveChannel = (
  order: LayoutOrder,
  id: number,
  category: number | null,
  index: number
): LayoutOrder => moveItem(order, `c${id}`, category, index)

export const moveSeparator = (
  order: LayoutOrder,
  id: number,
  category: number | null,
  index: number
): LayoutOrder => moveItem(order, `s${id}`, category, index)

export const moveCategory = (order: LayoutOrder, id: number, index: number): LayoutOrder => {
  const moved = order.categories.find(c => c.id === id)
  if (!moved) return order
  const rest = order.categories.filter(c => c.id !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return { ...order, categories: [...rest.slice(0, at), moved, ...rest.slice(at)] }
}

// The optimistic layout of an order, before the server answers.
export const orderLayout = (detail: ServerDetail, order: LayoutOrder): ChannelLayout => {
  const cats = new Map((detail.categories ?? []).map(c => [c.id, c]))
  const seps = new Map((detail.separators ?? []).map(s => [s.id, s]))
  return {
    version: detail.layout_version ?? 0,
    uncategorized: order.uncategorized,
    categories: order.categories.map(c => ({
      id: c.id,
      name: cats.get(c.id)?.name ?? '',
      ...(cats.get(c.id)?.style ? { style: cats.get(c.id)!.style } : {}),
      channels: c.channels,
    })),
    separators: order.separators.flatMap(p => {
      const s = seps.get(p.id)
      return s ? [{ ...s, category_id: p.category_id, after: p.after }] : []
    }),
  }
}

// Where a drop at `index` among the `shown` items of a list lands in the `full` list (both
// without the moved item): before the shown item at `index`, else after the last shown one.
export const fullIndex = <T>(full: readonly T[], shown: readonly T[], id: T, index: number) => {
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
