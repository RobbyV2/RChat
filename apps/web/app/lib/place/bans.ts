import type { AccountSession } from '../client/session'
import { p2pName, personCalled, type P2pName, type PersonName } from '../names'
import { UNBAN_TEXT } from '../p2p/flows'
import type { P2pApp } from '../p2p/app/runtime'
import { nameColor } from '../p2p/roles'
import type { MemberView } from '../p2p/server/types'
import { viewCan } from '../p2p/roles'
import { P } from '../p2p/state'
import { PAGE } from '../paging'
import { asAccount, type Person } from '../people'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// Someone banned from a place, as its ban list shows them.
export interface BanEntry {
  // As the place keys its members: a username, or an identity key.
  who: string
  face: { kind: 'account'; user: Person } | { kind: 'key'; ik: string; of: readonly MemberView[] }
  name: PersonName | P2pName
  color: string | null
  owner: boolean
  // When the ban was set (ms), where the place keeps it.
  since: number | null
  // When it ends (ms); null for a ban without an end.
  ends: number | null
  // A timed ban that ended waits for a moderator's device to lift it.
  lapses: boolean
  reason: string | null
  // Whether the reader may lift it.
  unban: boolean
}

export interface BansState {
  // False until the first page is here.
  ready: boolean
  entries: BanEntry[]
  more: boolean
  // What the list says under the bans, for the reader; null with nothing to say.
  note: string | null
  // A ban with an end is shown with a clock that runs.
  timed: boolean
}

export interface Bans {
  state: Live<BansState>
  // The next page, once the end of the list shows.
  more: () => void
  unban: (who: string) => void
  // Loads the list while it is on screen.
  watch: () => () => void
}

const WAITING: BansState = { ready: false, entries: [], more: false, note: null, timed: false }

const hosted = (account: AccountSession, server: string): Bans => {
  const { store } = account
  const state = (initial: boolean) =>
    built(
      () => [(initial ? store.getInitialState() : store.getState()).bans[server]] as const,
      ([cache]): BansState =>
        cache === undefined
          ? WAITING
          : {
              ready: !cache.loading || cache.list.length > 0,
              entries: cache.list.map(b => ({
                who: b.username,
                face: { kind: 'account', user: asAccount(b, 'unknown') },
                name: personCalled(b.display_name, b.username),
                color: null,
                owner: false,
                since: b.banned_at * 1000,
                ends: b.expires_at ? b.expires_at * 1000 : null,
                lapses: false,
                reason: b.reason ?? null,
                unban: true,
              })),
              more: cache.hasMore ?? false,
              note: null,
              timed: cache.list.some(b => !!b.expires_at),
            }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    },
    more: () => void store.getState().loadBans(server),
    unban: who => void store.getState().unbanMember(server, who),
    watch: () => {
      void store.getState().loadBans(server, true)
      return () => {}
    },
  }
}

const peer = (app: P2pApp, room: string): Bans => {
  const { useP2p, p2pServer } = app
  let shown = PAGE
  const heard = new Set<() => void>()
  const state = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [s.servers[room], s.me, shown] as const
      },
      ([v, me, n]): BansState => {
        if (!v) return WAITING
        const lift = viewCan(v, P.Ban)
        const list = v.members
          .filter(m => m.m === 'ban')
          .sort((a, b) => a.name.localeCompare(b.name))
        return {
          ready: true,
          entries: list.slice(0, n).map(m => ({
            who: m.ik,
            face: { kind: 'key', ik: m.ik, of: v.members },
            name: p2pName(m.name, m.ik === me),
            color: nameColor(m, v.roles) ?? null,
            owner: m.owner,
            since: null,
            ends: m.banUntil ?? null,
            lapses: m.banUntil !== undefined,
            reason: lift ? (m.banReason ?? null) : null,
            unban: m.unban,
          })),
          more: list.length > n,
          note: lift && list.length > 0 ? UNBAN_TEXT : null,
          timed: list.some(m => m.banUntil !== undefined),
        }
      }
    )
  return {
    state: {
      get: state(false),
      initial: state(true),
      subscribe: changed => {
        heard.add(changed)
        const stop = useP2p.subscribe(changed)
        return () => {
          heard.delete(changed)
          stop()
        }
      },
    },
    more: () => {
      shown += PAGE
      for (const changed of heard) changed()
    },
    unban: who => void p2pServer.unban(room, who),
    watch: () => () => {
      shown = PAGE
    },
  }
}

// Who is banned from a server or a room, 50 at a time, and lifting a ban.
export const bans = defineFeature<Bans>('bans', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
