import { openActionMenu } from '../actions/menu'
import { channelGroups, roomGroups } from '../categories'
import type { AccountSession } from '../client/session'
import type { P2pApp } from '../p2p/app/runtime'
import { ownsP2pServer } from '../p2p/server/types'
import { P } from '../p2p/state'
import { myPerms } from '../selectors'
import { Perm, hasPerm } from '../types'
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

export interface CategoryEntry {
  key: string
  name: string
  open: boolean
  channels: ChannelEntry[]
}

export interface ChannelsState {
  // False while the place's channels are not here yet.
  ready: boolean
  // The names are your own text.
  ownPlace: boolean
  // Whether you may add, move and rename channels.
  canManage: boolean
  uncategorized: ChannelEntry[]
  categories: CategoryEntry[]
  // What the list says with no channel to show.
  empty: string | null
}

export interface Channels {
  state: Live<ChannelsState>
  // Shows a text channel.
  open: (key: string) => void
  setOpen: (category: string, open: boolean) => void
  channelMenu: (key: string, x: number, y: number) => void
  categoryMenu: (key: string, x: number, y: number) => void
}

const WAITING: ChannelsState = {
  ready: false,
  ownPlace: false,
  canManage: false,
  uncategorized: [],
  categories: [],
  empty: null,
}

// The list of a place whose channels are not here.
export const noChannels: Live<ChannelsState> = constant(WAITING)

// The channels a folded category still shows.
export const unfolded = (category: CategoryEntry) =>
  category.open ? category.channels : category.channels.filter(c => c.active || c.connected)

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
        return {
          ready: true,
          ownPlace:
            me !== null && (mine?.find(x => x.name === server)?.creator ?? detail.creator) === me,
          canManage,
          uncategorized: groups.uncategorized.map(entry),
          categories: groups.categories.map(g => ({
            key: String(g.category.id),
            name: g.category.name,
            open: !shut.has(g.category.id),
            channels: g.channels.map(entry),
          })),
          empty: null,
        }
      }
    )
  const detail = () => store.getState().servers[server]
  return {
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
        const canManage = v.me === 'join' && (v.perms & P.ManageChannels) !== 0
        const shown = v.channels.filter(c => c.kind === 'text' || c.kind === 'voice')
        const groups = roomGroups({ channels: shown, categories: v.categories }, canManage)
        const entry = (c: (typeof shown)[number]): ChannelEntry => ({
          key: c.id,
          name: c.name,
          kind: c.kind === 'voice' ? 'voice' : 'text',
          private: !!c.restrict_view,
          active: c.id === active,
          connected: false,
        })
        return {
          ready: true,
          ownPlace: ownsP2pServer(v, me),
          canManage,
          uncategorized: groups.uncategorized.map(entry),
          categories: groups.categories.map(g => ({
            key: g.category.id,
            name: g.category.name,
            open: !folded.has(g.category.id),
            channels: g.channels.map(entry),
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
  const view = () => useP2p.getState().servers[room]
  return {
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
  }
}

// The channels of a server or a room, in their categories.
export const channels = defineFeature<Channels>('channels', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
