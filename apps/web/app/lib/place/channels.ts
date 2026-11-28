import { openActionMenu } from '../actions/menu'
import { categoryStyleOf, channelGroups, roomGroups, separatorStyleOf } from '../categories'
import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { viewCan } from '../p2p/roles'
import { ownsP2pServer } from '../p2p/server/types'
import { P } from '../p2p/state'
import { badgePings, myPerms, scopeMuted, scopeUnread } from '../selectors'
import { levelOf, mutedOf, type NotifyScope } from '../notify'
import { channelScope, serverScope } from '../p2p/app'
import { scopePings } from '../pings'
import { p2pRowTypers, rowTypers } from '../typing_rows'
import { Perm, hasPerm, type CategoryStyle, type SeparatorStyle } from '../types'
import { defineFeature, notInDms } from './feature'
import { built, constant, type Live } from './live'

// A channel of a server or room as its list shows it; `key` names it to the place.
export interface ChannelEntry {
  key: string
  name: string
  kind: 'text' | 'voice'
  // Only some members see it.
  private: boolean
  // The channel on screen.
  active: boolean
  // A voice channel you are connected to.
  connected: boolean
}

// A decorative line between the channels of a list; `key` names it to the place.
export interface SeparatorEntry {
  key: string
  label: string
  style: SeparatorStyle
}

// A row of a channel list: a channel, or a separator between channels.
export type ListEntry =
  { kind: 'channel'; channel: ChannelEntry } | { kind: 'separator'; separator: SeparatorEntry }

export interface CategoryEntry {
  key: string
  name: string
  style: CategoryStyle
  open: boolean
  channels: ChannelEntry[]
  // The channels with the separators between them.
  rows: ListEntry[]
}

export interface ChannelsState {
  // False while the place's channels are not here yet.
  ready: boolean
  // The names are your own text.
  ownPlace: boolean
  // Whether you may add, move and rename channels.
  canManage: boolean
  uncategorized: ChannelEntry[]
  // The channels outside any category with the separators between them.
  loose: ListEntry[]
  categories: CategoryEntry[]
  // What the list says with no channel to show.
  empty: string | null
}

// The end of a text channel's row: what you have not read there, who types, and whether it is
// muted.
export interface ChannelEnding {
  // What the notification settings know the channel as.
  scope: NotifyScope
  muted: boolean
  // The row stands out while something there is unread.
  bold: boolean
  pings: number
  unread: boolean
  typers: readonly string[]
}

export interface EndingsState {
  of: ReadonlyMap<string, ChannelEnding>
  // The typers whose look in `server` is not loaded yet.
  ask: readonly string[]
  server: string | null
}

const NO_NAMES: readonly string[] = []

export const noEndings: Live<EndingsState> = constant({
  of: new Map(),
  ask: NO_NAMES,
  server: null,
})

export interface Channels {
  state: Live<ChannelsState>
  ends: Live<EndingsState>
  // Shows a text channel.
  open: (key: string) => void
  setOpen: (category: string, open: boolean) => void
  channelMenu: (key: string, x: number, y: number) => void
  categoryMenu: (key: string, x: number, y: number) => void
  separatorMenu: (key: string, x: number, y: number) => void
}

const WAITING: ChannelsState = {
  ready: false,
  ownPlace: false,
  canManage: false,
  uncategorized: [],
  loose: [],
  categories: [],
  empty: null,
}

// The list of a place whose channels are not here.
export const noChannels: Live<ChannelsState> = constant(WAITING)

// The channels a folded category still shows.
export const unfolded = (category: CategoryEntry) =>
  category.open ? category.channels : category.channels.filter(c => c.active || c.connected)

// The rows a folded category still shows: those channels, without separators.
export const unfoldedRows = (category: CategoryEntry) =>
  category.open
    ? category.rows
    : category.rows.filter(r => r.kind === 'channel' && (r.channel.active || r.channel.connected))

const hosted = (account: AccountSession, server: string): Channels => {
  const { store } = account
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [
          s.servers[server],
          s.view?.kind === 'channel' && s.view.server === server ? s.view.channelId : null,
          s.layout.collapsed[server],
          s.voice?.channelId ?? null,
          myPerms(s, server),
          s.me?.username ?? null,
          s.me?.servers,
        ] as const
      },
      ([detail, active, collapsed, voice, perms, me, mine]): ChannelsState => {
        if (!detail) return WAITING
        const canManage = hasPerm(perms, Perm.ManageChannels)
        const groups = channelGroups(detail, canManage)
        const shut = new Set(collapsed ?? [])
        const entry = (c: (typeof detail.channels)[number]): ChannelEntry => ({
          key: String(c.id),
          name: c.name,
          kind: c.kind === 'voice' ? 'voice' : 'text',
          private: !!c.restrict_view,
          active: c.id === active,
          connected: c.id === voice,
        })
        const rows = (items: typeof groups.loose): ListEntry[] =>
          items.map(i =>
            i.kind === 'channel'
              ? { kind: 'channel', channel: entry(i.channel) }
              : {
                  kind: 'separator',
                  separator: {
                    key: String(i.separator.id),
                    label: i.separator.label,
                    style: separatorStyleOf(i.separator.style),
                  },
                }
          )
        return {
          ready: true,
          ownPlace:
            me !== null && (mine?.find(x => x.name === server)?.creator ?? detail.creator) === me,
          canManage,
          uncategorized: groups.uncategorized.map(entry),
          loose: rows(groups.loose),
          categories: groups.categories.map(g => ({
            key: String(g.category.id),
            name: g.category.name,
            style: categoryStyleOf(g.category.style),
            open: !shut.has(g.category.id),
            channels: g.channels.map(entry),
            rows: rows(g.items),
          })),
          empty: null,
        }
      }
    )
  const ends = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [
          s.servers[server]?.channels,
          s.reads,
          s.notifyPrefs,
          badgePings(s),
          s.typingOn,
          s.typing,
          s.blocked,
          s.members[server],
          s.memberInfo[server],
        ] as const
      },
      ([listed, , , pings]): EndingsState => {
        const s = initial ? store.getInitialState() : store.getState()
        const of = new Map<string, ChannelEnding>()
        const ask = new Set<string>()
        for (const c of listed ?? []) {
          if (c.kind === 'voice') continue
          const scope: NotifyScope = { kind: 'channel', id: c.id, server }
          const typing = rowTypers(s, [`c${c.id}`], server)
          for (const a of typing.ask) ask.add(a)
          of.set(String(c.id), {
            scope,
            muted: scopeMuted(s, scope),
            bold: false,
            pings: scopePings(pings, `c${c.id}`),
            unread: scopeUnread(s, `c${c.id}`),
            typers: typing.names,
          })
        }
        return { of, ask: ask.size ? [...ask] : NO_NAMES, server }
      }
    )
  const detail = () => store.getState().servers[server]
  return {
    ends: {
      get: ends(false),
      initial: ends(true),
      subscribe: changed => store.subscribe(changed),
    },
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    open: key => void store.getState().openChannel(server, Number(key)),
    setOpen: (category, open) =>
      store.getState().setCategoriesCollapsed(server, [Number(category)], !open),
    channelMenu: (key, x, y) => {
      const channel = detail()?.channels.find(c => String(c.id) === key)
      if (channel) openActionMenu(x, y, { kind: 'channel', server, channel }, undefined, account)
    },
    categoryMenu: (key, x, y) => {
      const category = detail()?.categories?.find(c => String(c.id) === key)
      if (category) openActionMenu(x, y, { kind: 'category', server, category }, undefined, account)
    },
    separatorMenu: (key, x, y) => {
      const separator = detail()?.separators?.find(s => String(s.id) === key)
      if (separator)
        openActionMenu(x, y, { kind: 'separator', server, separator }, undefined, account)
    },
  }
}

const peer = (app: P2pApp, room: string): Channels => {
  const { useP2p, p2pServer } = app
  // The categories folded here; a room's list keeps them only while it is open.
  let shut: ReadonlySet<string> = new Set()
  const listeners = new Set<() => void>()
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [
          s.servers[room],
          s.server?.room === room ? (s.server.ch ?? null) : null,
          s.me,
          shut,
        ] as const
      },
      ([v, active, me, folded]): ChannelsState => {
        if (!v) return WAITING
        const canManage = viewCan(v, P.ManageChannels)
        const shown = v.channels.filter(c => c.kind === 'text' || c.kind === 'voice')
        const groups = roomGroups(
          { channels: shown, categories: v.categories, separators: v.separators },
          canManage
        )
        const entry = (c: (typeof shown)[number]): ChannelEntry => ({
          key: c.id,
          name: c.name,
          kind: c.kind === 'voice' ? 'voice' : 'text',
          private: !!c.restrict_view,
          active: c.id === active,
          connected: false,
        })
        const rows = (items: typeof groups.loose): ListEntry[] =>
          items.map(i =>
            i.kind === 'channel'
              ? { kind: 'channel', channel: entry(i.channel) }
              : {
                  kind: 'separator',
                  separator: {
                    key: i.separator.id,
                    label: i.separator.label,
                    style: separatorStyleOf(i.separator.style),
                  },
                }
          )
        return {
          ready: true,
          ownPlace: ownsP2pServer(v, me),
          canManage,
          uncategorized: groups.uncategorized.map(entry),
          loose: rows(groups.loose),
          categories: groups.categories.map(g => ({
            key: g.category.id,
            name: g.category.name,
            style: categoryStyleOf(g.category.style),
            open: !folded.has(g.category.id),
            channels: g.channels.map(entry),
            rows: rows(g.items),
          })),
          empty:
            shown.length > 0
              ? null
              : v.me === null
                ? 'Waiting for the server to arrive from a member…'
                : 'No channels yet.',
        }
      }
    )
  const ends = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        const site = initial ? app.owner.store.getInitialState() : app.owner.store.getState()
        return [
          s.servers[room]?.channels,
          s.servers[room]?.chans,
          s.serverTyping,
          s.contacts,
          site.notifyPrefs,
          site.typingOn,
        ] as const
      },
      ([listed, chans, typing, contacts, prefs, typingOn]): EndingsState => {
        const now = app.owner.time.now()
        const blocked = new Set(contacts.filter(c => c.state === 'blocked').map(c => c.ik))
        const whole = mutedOf(prefs, serverScope(room), now)
        const of = new Map<string, ChannelEnding>()
        for (const c of listed ?? []) {
          if (c.kind !== 'text') continue
          const counts = chans?.[c.id]
          const scope = channelScope(room, c.id)
          const muted = mutedOf(prefs, scope, now) || whole
          const unread = !!counts?.unread && !muted
          of.set(c.id, {
            scope,
            muted,
            bold: unread,
            pings: counts && levelOf(prefs, scope) !== 'nothing' ? counts.pings : 0,
            unread,
            typers: typingOn
              ? p2pRowTypers(typing[`${room}/${c.id}`] ?? NO_NAMES, blocked, ik =>
                  app.memberName(room, ik)
                )
              : NO_NAMES,
          })
        }
        return { of, ask: NO_NAMES, server: null }
      }
    )
  const view = () => useP2p.getState().servers[room]
  return {
    ends: {
      get: ends(false),
      initial: ends(true),
      subscribe: changed => {
        const stops = [useP2p.subscribe(changed), app.owner.store.subscribe(changed)]
        return () => stops.forEach(stop => stop())
      },
    },
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => {
        listeners.add(changed)
        const stop = useP2p.subscribe(changed)
        return () => {
          listeners.delete(changed)
          stop()
        }
      },
    },
    open: key => void p2pServer.openChannel(key),
    setOpen: (category, open) => {
      const next = new Set(shut)
      if (open) next.delete(category)
      else next.add(category)
      shut = next
      for (const changed of [...listeners]) changed()
    },
    channelMenu: (key, x, y) => {
      const v = view()
      const ch = v?.channels.find(c => c.id === key)
      if (v && ch) openActionMenu(x, y, { kind: 'p2p_channel', v, ch }, undefined, app.owner, app)
    },
    categoryMenu: (key, x, y) => {
      const v = view()
      const cat = v?.categories.find(c => c.id === key)
      if (v && cat)
        openActionMenu(x, y, { kind: 'p2p_category', v, cat }, undefined, app.owner, app)
    },
    separatorMenu: (key, x, y) => {
      const v = view()
      const sep = v?.separators.find(s => s.id === key)
      if (v && sep)
        openActionMenu(x, y, { kind: 'p2p_separator', v, sep }, undefined, app.owner, app)
    },
  }
}

// The channels of a server or a room, in their categories.
export const channels = defineFeature<Channels>('channels', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
