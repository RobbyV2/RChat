// The DMs below the pins: how they are sorted and filtered (saved with the layout), the server
// query that pages them, and the live changes that move them.

export type DmSort = 'recent' | 'oldest' | 'name' | 'custom'

export type DmServerSort = Exclude<DmSort, 'custom'>

export interface DmListPrefs {
  sort: DmSort
  friends: boolean
  unread: boolean
  unreadTop: boolean
}

export interface DmQuery {
  sort: DmServerSort
  friends: boolean
}

export interface DmLike {
  id: number
  is_self?: boolean
  friend?: boolean
  last_message_id?: number | null
  other: { username: string; display_name: string }
}

export const DM_SORTS: readonly { sort: DmSort; label: string }[] = [
  { sort: 'recent', label: 'Recent activity' },
  { sort: 'oldest', label: 'Oldest activity' },
  { sort: 'name', label: 'Name' },
  { sort: 'custom', label: 'Custom' },
]

const SORTS = new Set<unknown>(DM_SORTS.map(s => s.sort))

export const DEFAULT_DM_QUERY: DmQuery = { sort: 'recent', friends: false }

export const parseDmList = (x: unknown): DmListPrefs | null => {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null
  const { sort, friends, unread, unreadTop } = x as Record<string, unknown>
  if (!SORTS.has(sort)) return null
  return {
    sort: sort as DmSort,
    friends: friends === true,
    unread: unread === true,
    unreadTop: unreadTop === true,
  }
}

// Without a choice: recent activity, or custom for an account that dragged its DMs into an order.
export const dmListPrefs = (layout: { dmList?: DmListPrefs; dmOrder: number[] }): DmListPrefs =>
  layout.dmList ?? {
    sort: layout.dmOrder.length ? 'custom' : 'recent',
    friends: false,
    unread: false,
    unreadTop: false,
  }

export const filtersOn = (p: DmListPrefs) => Number(p.friends) + Number(p.unread)

export const clearDmFilters = (p: DmListPrefs): DmListPrefs => ({
  ...p,
  friends: false,
  unread: false,
})

export const dmQuery = ({ sort, friends }: DmListPrefs): DmQuery => ({
  sort: sort === 'custom' ? 'recent' : sort,
  friends,
})

export const queryKey = ({ sort, friends }: DmQuery) => `${sort}${friends ? ':friends' : ''}`

export const queryParams = ({ sort, friends }: DmQuery) =>
  `${sort === 'recent' ? '' : `&sort=${sort}`}${friends ? '&friends=true' : ''}`

// How far a server-paged order has come: up to `last`, the last row paged for `query` (`null`:
// none yet). Rows past it (known from `/me`, lookups by id or live events) wait for their page.
export interface DmEdge {
  query: DmQuery
  last: DmLike | null
}

export const NO_DM_EDGE: DmEdge = { query: DEFAULT_DM_QUERY, last: null }

// An older server sends no activity: its rows keep the order it paged them in.
const byActivity = (a: DmLike, b: DmLike) =>
  a.last_message_id === undefined || b.last_message_id === undefined
    ? 0
    : (a.last_message_id ?? 0) - (b.last_message_id ?? 0) || a.id - b.id

const nameOf = (d: DmLike) => d.other.display_name.replace(/[A-Z]+/g, c => c.toLowerCase())

const surrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdfff

// By code point, as the server's byte order of UTF-8.
const byText = (a: string, b: string) => {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const x = a.charCodeAt(i)
    const y = b.charCodeAt(i)
    if (x === y) continue
    return surrogate(x) === surrogate(y) ? x - y : surrogate(x) ? 1 : -1
  }
  return a.length - b.length
}

// The server's orders, the self DM first.
export const compareDms =
  (sort: DmServerSort) =>
  (a: DmLike, b: DmLike): number => {
    if (!!a.is_self !== !!b.is_self) return a.is_self ? -1 : 1
    switch (sort) {
      case 'recent':
        return byActivity(b, a)
      case 'oldest':
        return byActivity(a, b)
      case 'name':
        return byText(nameOf(a), nameOf(b)) || byText(a.other.username, b.other.username)
    }
  }

const pagedUpTo = (prefs: DmListPrefs, edge: DmEdge | null): ((d: DmLike) => boolean) => {
  if (!edge || prefs.sort === 'custom') return () => true
  const { query, last } = edge
  if (last && last.last_message_id === undefined) return () => true
  const want = dmQuery(prefs)
  if (!last || queryKey(query) !== queryKey(want)) return d => d.is_self === true
  const cmp = compareDms(want.sort)
  return d => cmp(d, last) <= 0
}

// Past `edge` and not known from the unread list: waits for its page.
export const waitsForPage = <T extends DmLike>(
  prefs: DmListPrefs,
  unread: (d: T) => boolean,
  edge: DmEdge | null
): ((d: T) => boolean) => {
  const paged = pagedUpTo(prefs, edge)
  return d => !paged(d) && !((prefs.unread || prefs.unreadTop) && unread(d))
}

// `order`: the unpinned DMs in the custom order. The open DM (`keep`) is never filtered out.
// `edge`: where the server's pages stop while more remain; unread DMs are known without them.
export const arrangeDms = <T extends DmLike>(
  order: T[],
  prefs: DmListPrefs,
  unread: (d: T) => boolean,
  keep: number | null = null,
  edge: DmEdge | null = null
): T[] => {
  const waits = waitsForPage(prefs, unread, edge)
  const shown = order.filter(
    d =>
      d.id === keep ||
      ((!prefs.friends || d.friend !== false || d.is_self === true) &&
        (!prefs.unread || unread(d)) &&
        !waits(d))
  )
  const sort = prefs.sort
  const sorted = sort === 'custom' ? shown : [...shown].sort(compareDms(sort))
  if (!prefs.unreadTop) return sorted
  const first = sort === 'custom' ? [] : sorted.filter(d => d.is_self)
  const rest = sorted.filter(d => !first.includes(d))
  return [...first, ...rest.filter(d => unread(d)), ...rest.filter(d => !unread(d))]
}

// The rows the list shows: `tail` is the open DM while it waits for its page.
export interface DmRows<K> {
  ids: K[]
  tail: K[]
}

// The DMs below the pins as `arrangeDms` orders them, with the open DM as the tail while it waits.
export const dmRows = <T extends DmLike>(
  order: T[],
  prefs: DmListPrefs,
  unread: (d: T) => boolean,
  open: number | null,
  edge: DmEdge | null
): DmRows<number> => {
  const waits = waitsForPage(prefs, unread, edge)
  return {
    ids: arrangeDms(order, prefs, unread, open, edge).map(d => d.id),
    tail: order.filter(d => d.id === open && waits(d)).map(d => d.id),
  }
}

// While held (pointer or keyboard focus in the list), rows keep their places: new rows go to the
// end and only rows that are gone leave. A tail is never held: it goes where `next` has it among
// the new rows, so paged rows land above it.
export const holdOrder = <K>(was: DmRows<K>, next: DmRows<K>, alive: ReadonlySet<K>): DmRows<K> => {
  const loose = new Set([...was.tail, ...next.tail])
  const kept = was.ids.filter(k => alive.has(k) && !loose.has(k))
  const have = new Set(kept)
  return { ids: [...kept, ...next.ids.filter(k => !have.has(k))], tail: next.tail }
}

export const noteDmMessage = <
  T extends { id: number; last_message_id?: number | null; last_message_at?: number | null },
>(
  dms: T[],
  dmId: number,
  id: number,
  at: number
): T[] => {
  const dm = dms.find(d => d.id === dmId)
  if (!dm || (dm.last_message_id ?? 0) >= id) return dms
  return dms.map(d => (d === dm ? { ...d, last_message_id: id, last_message_at: at } : d))
}

export const setDmFriend = <
  T extends { is_self?: boolean; friend?: boolean; other: { username: string } },
>(
  dms: T[],
  username: string,
  friend: boolean
): T[] => {
  const hit = (d: T) => !d.is_self && d.other.username === username
  return dms.some(d => hit(d) && d.friend !== friend)
    ? dms.map(d => (hit(d) ? { ...d, friend } : d))
    : dms
}

export const UNREAD_DMS_MAX = 100

export const unreadDmIds = (
  reads: Record<string, { lastRead: number; latest: number }>,
  cap = UNREAD_DMS_MAX
): number[] =>
  Object.entries(reads)
    .flatMap(([scope, r]): [number, number][] => {
      const id = Number(scope.slice(1))
      return scope[0] === 'd' && r.latest > r.lastRead && Number.isSafeInteger(id) && id > 0
        ? [[id, r.latest]]
        : []
    })
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([id]) => id)

// Every unread DM is in the unread list and few enough to load by id, so Unread only needs no pages.
export const unreadListed = (
  reads: Record<string, { lastRead: number; latest: number }>,
  cut: boolean
): boolean => !cut && unreadDmIds(reads, UNREAD_DMS_MAX + 1).length <= UNREAD_DMS_MAX

// What your DM with yourself says while it is empty.
export const SELF_DM_TITLE = 'Your personal space'
export const SELF_DM_TEXT =
  'This space is just for you. Jot down notes, forward messages here to save for later, drop files and links, or organize topics into threads.'
