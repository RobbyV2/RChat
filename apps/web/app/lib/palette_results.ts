// What the palette lists for the typed text: places to go, people, commands, messages from the
// local index, API operations and help, ranked and grouped. Pure apart from the actions the
// items run, so it is tested without a DOM.

import {
  AtSign,
  Bot,
  CircleHelp,
  Command,
  Folder,
  Hash,
  History,
  Keyboard,
  MessageSquare,
  MessagesSquare,
  Search,
  Server,
  User,
  Volume2,
} from 'lucide-react'
import type { Recent } from './home'
import { previewText } from './invite'
import { fillPath, type HistoryEntry, type Operation } from './openapi'
import {
  GROUP_LABELS,
  prefixesFor,
  parseQuery,
  rank,
  type PaletteGroup,
  type PaletteItem,
  type Ranked,
  type UsageMap,
} from './palette'
import { paletteCtx } from './actions/ctx'
import { paletteCommands } from './actions/palette'
import type { IndexDoc, PaletteIndex } from './palette_index'
import { indexSource } from './palette_sync'
import { openPalette, setPaletteView } from './palette_store'
import { SHORTCUTS, shortcutLabel } from './shortcuts'
import { useStore } from './store'
import type { RChatState } from './store_types'
import type { Message, UserRef } from './types'

export interface ResultCtx {
  usage: UsageMap
  now: number
  index: PaletteIndex | null
  visible: (d: IndexDoc) => boolean
  ops: Operation[] | null
  history: HistoryEntry[]
  recents: Recent[]
  mask: (text: string) => string
}

export interface Section {
  group: PaletteGroup
  label: string
  items: Ranked<PaletteItem>[]
}

const get = () => useStore.getState()

const SNIPPET_MAX = 120

// One line of a message for a result row: spoilers as blocks, the personal filter applied.
export const snippet = (text: string, mask: (t: string) => string) => {
  const line = previewText(mask(text))
  return line.length > SNIPPET_MAX ? `${line.slice(0, SNIPPET_MAX - 1)}…` : line
}

const serverLabel = (s: RChatState, name: string) =>
  s.me?.servers.find(x => x.name === name)?.display_name ??
  s.servers[name]?.display_name ??
  s.guestNames[name] ??
  name

const channelName = (s: RChatState, server: string, id: number) =>
  s.servers[server]?.channels.find(c => c.id === id)?.name ?? null

export const serverItems = (s: RChatState): PaletteItem[] => {
  const names = [...(s.me?.servers.map(x => x.name) ?? []), ...s.guestServers]
  return [...new Set(names)].map(name => ({
    id: `server_${name}`,
    title: serverLabel(s, name),
    subtitle: 'Server',
    keywords: [name],
    group: 'navigation',
    icon: Server,
    name: true,
    run: () => void get().openServer(name),
  }))
}

export const channelItems = (s: RChatState): PaletteItem[] => {
  const out: PaletteItem[] = []
  for (const [server, d] of Object.entries(s.servers)) {
    const label = serverLabel(s, server)
    const cats = new Map((d.categories ?? []).map(c => [c.id, c.name]))
    for (const c of d.channels) {
      const cat = c.category_id != null ? cats.get(c.category_id) : undefined
      out.push({
        id: `channel_${c.id}`,
        title: c.name,
        subtitle: cat ? `${label} · ${cat}` : label,
        subtitleName: true,
        keywords: cat ? [cat] : [],
        group: 'navigation',
        icon: c.kind === 'voice' ? Volume2 : Hash,
        run: () => void get().openChannel(server, c.id),
      })
    }
    for (const cat of d.categories ?? []) {
      const first = d.channels.find(c => c.category_id === cat.id)
      out.push({
        id: `category_${cat.id}`,
        title: cat.name,
        subtitle: `Category in ${label}`,
        subtitleName: true,
        group: 'navigation',
        icon: Folder,
        run: () => {
          get().setCategoriesCollapsed(server, [cat.id], false)
          if (first) void get().openChannel(server, first.id)
          else void get().openServer(server)
        },
      })
    }
  }
  return out
}

const dmTitle = (s: RChatState, other: UserRef, self: boolean) =>
  self ? `${other.display_name} (you)` : other.display_name

export const dmItems = (s: RChatState): PaletteItem[] =>
  s.dms
    .filter(d => !d.closed)
    .map(d => ({
      id: `dm_${d.id}`,
      title: dmTitle(s, d.other, d.is_self),
      subtitle: `@${d.other.username}`,
      subtitleName: true,
      keywords: [d.other.username],
      group: 'navigation',
      icon: MessageSquare,
      name: true,
      run: () => void get().openDm(d.id),
    }))

const THREADS_MAX = 40

export const threadItems = (s: RChatState, mask: (t: string) => string): PaletteItem[] => {
  const roots: { m: Message; server: string }[] = []
  for (const [server, d] of Object.entries(s.servers))
    for (const c of d.channels)
      for (const m of s.messages[`c${c.id}`] ?? [])
        if (m.reply_count > 0 && m.kind === 'user') roots.push({ m, server })
  roots.sort((a, b) => b.m.created_at - a.m.created_at)
  return roots.slice(0, THREADS_MAX).map(({ m, server }) => {
    const ch = m.channel_id !== null ? channelName(s, server, m.channel_id) : null
    return {
      id: `thread_${m.id}`,
      title: snippet(m.content, mask) || 'Thread',
      subtitle: `Thread${ch ? ` in #${ch}` : ''} · ${m.reply_count} ${m.reply_count === 1 ? 'reply' : 'replies'}`,
      group: 'navigation',
      icon: MessagesSquare,
      run: async () => {
        if (m.channel_id !== null) await get().openChannel(server, m.channel_id)
        await get().openThread(m)
      },
    }
  })
}

export const recentItems = (s: RChatState, recents: Recent[]): PaletteItem[] =>
  recents.flatMap((r): PaletteItem[] => {
    if (r.kind === 'p2p') return []
    const v = s.view
    if (
      v &&
      (v.kind === 'dm'
        ? r.kind === 'dm' && r.dmId === v.dmId
        : r.kind === 'channel' && r.channelId === v.channelId)
    )
      return []
    if (r.kind === 'dm') {
      const d = s.dms.find(x => x.id === r.dmId && !x.closed)
      return d
        ? [
            {
              id: `dm_${d.id}`,
              title: dmTitle(s, d.other, d.is_self),
              subtitle: 'Direct message',
              group: 'recent',
              icon: MessageSquare,
              name: true,
              run: () => void get().openDm(d.id),
            },
          ]
        : []
    }
    const name = channelName(s, r.server, r.channelId) ?? r.channel
    if (!name || !s.me?.servers.some(x => x.name === r.server)) return []
    return [
      {
        id: `channel_${r.channelId}`,
        title: name,
        subtitle: s.servers[r.server] ? serverLabel(s, r.server) : (r.serverName ?? r.server),
        subtitleName: true,
        group: 'recent',
        icon: Hash,
        run: () => void get().openChannel(r.server, r.channelId),
      },
    ]
  })

const personRun = (s: RChatState, u: UserRef) =>
  s.me && !s.guest
    ? () => void get().startDm(u.username)
    : () => get().openProfile(u, null, Math.round(window.innerWidth / 2), 96)

export const peopleItems = (s: RChatState, ctx: ResultCtx, q: string): PaletteItem[] => {
  const seen = new Map<string, UserRef>()
  const note = (u: UserRef) => {
    if (!seen.has(u.username)) seen.set(u.username, u)
  }
  for (const d of s.dms) if (!d.closed && !d.is_self) note(d.other)
  for (const f of s.friends.list) note(f.user)
  for (const f of s.onlineFriends.list) note(f.user)
  for (const r of s.incomingRequests.list) note(r.user)
  for (const list of Object.values(s.members)) for (const m of list.list) note(m)
  for (const info of Object.values(s.memberInfo))
    for (const m of Object.values(info)) if (m) note(m)
  if (ctx.index && q)
    for (const hit of ctx.index.search(q, { kind: 'member', limit: 30, visible: ctx.visible }))
      note({
        username: hit.doc.author,
        display_name: hit.doc.name,
        avatar_kind: 'identicon',
        avatar_color: null,
      })
  const me = s.me?.username
  return [...seen.values()]
    .filter(u => u.username !== me && !Object.hasOwn(s.blocked, u.username))
    .map(u => ({
      id: `person_${u.username}`,
      title: u.display_name,
      subtitle: `@${u.username}`,
      subtitleName: true,
      keywords: [u.username],
      group: 'people',
      icon: User,
      name: true,
      run: personRun(s, u),
    }))
}

const when = (at: number) => new Date(at * 1000).toLocaleDateString()

export const messageItems = (
  s: RChatState,
  ctx: ResultCtx,
  q: string,
  limit: number
): Ranked<PaletteItem>[] => {
  if (!ctx.index || q.length < 2) return []
  return ctx.index
    .search(q, { kind: 'message', limit, visible: ctx.visible })
    .map(({ doc, score }) => {
      const source = doc.source === 'instance' ? null : indexSource(doc.source)
      const place = source
        ? (source.place?.(doc) ?? '')
        : doc.dm !== null
          ? 'Direct message'
          : doc.server !== null && doc.channel !== null
            ? `#${channelName(s, doc.server, doc.channel) ?? 'channel'}${doc.thread !== null ? ' thread' : ''}`
            : ''
      const id = doc.msg
      const item: PaletteItem = {
        id: `message_${doc.id}`,
        // Streamer mode shows where, never what.
        title: s.streamer ? `Message from ${doc.name}` : snippet(doc.text, ctx.mask),
        subtitle: [s.streamer ? null : doc.name, place, when(doc.at)].filter(Boolean).join(' · '),
        group: 'messages',
        icon: AtSign,
        name: s.streamer,
        subtitleName: true,
        run: () => {
          if (source) source.open(doc)
          else if (id !== null) void get().openMessage(id)
        },
      }
      return { item, score, hits: [] }
    })
}

export const apiItems = (ops: Operation[]): PaletteItem[] =>
  ops.map(op => ({
    id: `api_${op.id}`,
    title: op.summary,
    subtitle: `${op.method} ${op.path}`,
    aliases: [`${op.method} ${op.path}`, op.path.slice('/api'.length)],
    keywords: [op.tag],
    group: 'api',
    icon: Bot,
    hint: op.method,
    keepOpen: true,
    run: () => setPaletteView({ kind: 'api', op: op.id }),
  }))

export const historyItems = (history: HistoryEntry[], ops: Operation[]): PaletteItem[] =>
  history.flatMap((h, i): PaletteItem[] => {
    const op = ops.find(o => o.id === h.op)
    return op
      ? [
          {
            id: `apihistory_${i}`,
            // From the template and the saved (redacted) values: secrets stay `{name}`.
            title: `${op.method} ${fillPath(op, h.values)}`,
            subtitle: `${h.status || 'No answer'} · ${op.summary}`,
            group: 'recent',
            icon: History,
            hint: h.method,
            keepOpen: true,
            run: () => setPaletteView({ kind: 'api', op: op.id, values: h.values }),
          },
        ]
      : []
  })

export const helpItems = (guest = false): PaletteItem[] => [
  ...prefixesFor(guest).map(p => ({
    id: `help_${p.mode}`,
    title: `${p.prefix}  ${p.label}`,
    subtitle:
      p.mode === 'channels'
        ? 'Channels, categories, threads and servers'
        : p.mode === 'people'
          ? 'Friends, DMs and members'
          : p.mode === 'commands'
            ? 'Every action, settings included'
            : p.mode === 'api'
              ? 'Send requests to the API as yourself'
              : 'This list',
    group: 'help' as const,
    icon: p.mode === 'help' ? CircleHelp : Command,
    keepOpen: true,
    run: () => openPalette(p.prefix),
  })),
  ...SHORTCUTS.filter(sc => sc.where === 'anywhere').map(sc => ({
    id: `help_key_${sc.keys}`,
    title: sc.action,
    subtitle: 'Shortcut',
    hint: shortcutLabel(sc.keys),
    group: 'help' as const,
    icon: Keyboard,
    run: () => get().openDialog({ kind: 'settings', section: 'information' }),
  })),
]

const take = (
  out: Section[],
  group: PaletteGroup,
  items: Ranked<PaletteItem>[],
  max: number,
  label = GROUP_LABELS[group]
) => {
  if (items.length) out.push({ group, label, items: items.slice(0, max) })
}

const searchServerItem = (s: RChatState, q: string): Ranked<PaletteItem>[] =>
  s.view?.kind === 'channel' && q
    ? [
        {
          item: {
            id: 'search_server',
            title: `Search the server for “${q}”`,
            group: 'messages',
            icon: Search,
            run: () => get().openSearch(q),
          },
          score: 0,
          hits: [],
        },
      ]
    : []

// Guests get no API console.
export const noApi = (s: Pick<RChatState, 'guest' | 'me'>) => s.guest || !s.me

export const buildSections = (s: RChatState, text: string, ctx: ResultCtx): Section[] => {
  const { mode, q } = parseQuery(text)
  const { usage, now } = ctx
  const out: Section[] = []
  const commands = paletteCommands(paletteCtx(s))
  const selection = commands.filter(c => c.group === 'selection')
  const others = commands.filter(c => c.group !== 'selection')
  const r = <T extends PaletteItem>(items: T[], query = q) => rank(items, query, usage, now)

  if (mode === 'help') {
    take(out, 'help', r(helpItems(noApi(s))), 50)
    return out
  }
  if (mode === 'api') {
    const slash = others
      .filter(c => c.slash && (!q || c.slash.startsWith(q.split(/\s/)[0].toLowerCase())))
      .map(c => ({ ...c, title: `/${c.slash}  ${c.title}` }))
    take(out, 'commands', r(slash, ''), 5)
    if (noApi(s) || !ctx.ops) return out
    if (!q) take(out, 'recent', r(historyItems(ctx.history, ctx.ops), ''), 8, 'Recent requests')
    take(out, 'api', r(apiItems(ctx.ops)), q ? 40 : 200)
    return out
  }
  if (mode === 'commands') {
    take(out, 'selection', r(selection), 20)
    take(out, 'commands', r(others), 100, 'Commands')
    return out
  }
  if (mode === 'channels') {
    take(
      out,
      'navigation',
      r([...channelItems(s), ...threadItems(s, ctx.mask), ...serverItems(s)]),
      50
    )
    return out
  }
  if (mode === 'people') {
    take(out, 'people', r(peopleItems(s, ctx, q)), 50)
    return out
  }
  // Everything: what was selected first, then a typed command with its argument.
  take(out, 'selection', r(selection), 20)
  if (q) {
    const parsed = others.flatMap(c => {
      const arg = c.parse?.(q)
      return arg
        ? [{ ...c, id: c.id, title: `${c.title}: ${arg}`, arg: undefined, run: () => c.run(arg) }]
        : []
    })
    take(
      out,
      'commands',
      parsed.map(item => ({ item, score: 0, hits: [] })),
      3,
      'Run'
    )
  }
  if (!q) {
    take(out, 'recent', r(recentItems(s, ctx.recents), ''), 5)
    const used = r(others, '').filter(x => Object.hasOwn(usage, x.item.id))
    take(out, 'commands', used, 6, 'Frequent commands')
    take(
      out,
      'commands',
      r(
        others.filter(c => !Object.hasOwn(usage, c.id)),
        ''
      ),
      6,
      'Suggestions'
    )
    return out
  }
  take(
    out,
    'navigation',
    r([...serverItems(s), ...channelItems(s), ...dmItems(s), ...threadItems(s, ctx.mask)]),
    8
  )
  take(out, 'people', r(peopleItems(s, ctx, q)), 5)
  take(out, 'commands', r(others), 8, 'Commands')
  take(out, 'messages', [...messageItems(s, ctx, q, 6), ...searchServerItem(s, q)], 7)
  return out
}

export const flatItems = (sections: Section[]) => sections.flatMap(x => x.items.map(i => i.item))
