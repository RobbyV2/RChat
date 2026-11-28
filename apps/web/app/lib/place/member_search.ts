import type { ReactNode } from 'react'
import { openActionMenu } from '../actions/menu'
import { ask, sendTo } from '../asks'
import type { AccountSession } from '../client/session'
import { fromPages, type PagesSource } from '../load'
import {
  allowedFilters,
  filterMembers,
  hostedQuery,
  NO_FILTERS,
  p2pMemberRow,
  type MemberFilters,
} from '../member_filters'
import { p2pName, personCalled, type P2pName, type PersonName } from '../names'
import { EQUAL_ROLES_TEXT, HIGHER_ROLES_TEXT, OFFLINE_TEXT, VOUCH_INVITER_TEXT } from '../p2p/flows'
import type { P2pApp } from '../p2p/app/runtime'
import { nameColor, viewCan } from '../p2p/roles'
import type { MemberView } from '../p2p/server/types'
import { ownsP2pServer } from '../p2p/server/types'
import { P } from '../p2p/state'
import { PAGE } from '../paging'
import { shownUser, type Person } from '../people'
import { time } from '../platform/time'
import { memberState, roleColor, serverAdminPerms } from '../selectors'
import { lookIn, shownParts } from '../server_profile'
import { maskOf } from '../store'
import { Perm, hasPerm, type MemberHit } from '../types'
import { defineFeature, notInDms } from './feature'
import { built, type Live } from './live'

// Someone the members section of a server's settings lists.
export interface SearchRow {
  // As the place keys its members: a username, or an identity key.
  who: string
  face: { kind: 'account'; user: Person } | { kind: 'key'; ik: string; of: readonly MemberView[] }
  name: PersonName | P2pName
  color: string | null
  owner: boolean
  creator: boolean
  admin: boolean
  // An invited member's state ("Invited", or that the join waits); null for a member.
  invited: string | null
  // Their roles, and the invite they joined with, in one line; null with neither.
  facts: string | null
  // Unix seconds.
  joinedAt: number | null
  createdAt: number | null
}

export interface SearchChoices {
  // Whether the filters show: the search is open to the reader here.
  filters: boolean
  roles: { id: string; name: string }[]
  // The invites people joined with; null where the reader may not see them.
  via: { id: string; label: string }[] | null
  // Whether accounts have a creation date to filter and sort by.
  created: boolean
  // The dates of a member's joining show.
  joined: boolean
  // What the section says under the list.
  notes: string[]
  // Rows open a member card above their menu.
  cards: boolean
}

export interface MemberSearch {
  choices: Live<SearchChoices | null>
  // The members `filters` find, 50 at a time.
  search: (filters: MemberFilters) => PagesSource<SearchRow>
  // The row's menu, with `card` above it where the place draws member cards.
  menu: (who: string, x: number, y: number, card: ReactNode) => void
  // Keeps what the choices need while the section shows.
  watch: () => () => void
}

const DEBOUNCE = 250
const UNTITLED = 'Untitled password'

const hosted = (account: AccountSession, server: string): MemberSearch => {
  const { store } = account
  let via: { id: string; label: string }[] = []
  const heard = new Set<() => void>()
  const choices = (initial: boolean) =>
    built(
      () => {
        const s = initial ? store.getInitialState() : store.getState()
        return [
          s.servers[server]?.roles,
          !!s.me?.servers.some(x => x.name === server),
          via,
        ] as const
      },
      ([roles, member, kept]): SearchChoices | null =>
        roles === undefined || !member
          ? null
          : {
              filters: true,
              roles: roles.map(r => ({ id: String(r.id), name: r.name })),
              via: invites() ? kept : null,
              created: true,
              joined: true,
              notes: [],
              cards: false,
            }
    )
  const invites = () => hasPerm(serverAdminPerms(store.getState(), server), Perm.ManageInvites)
  const rowOf = (hit: MemberHit): SearchRow => {
    const s = store.getState()
    const roles = s.servers[server]?.roles ?? []
    const live = memberState(s, server, hit.username)
    const m = { ...hit, ...(live ?? {}) }
    const look = m.profile ? lookIn(m.profile, shownParts(s, server)) : null
    const user = shownUser(m, look)
    const names = roles.filter(r => m.role_ids.includes(r.id)).map(r => r.name)
    const facts = [
      names.join(', '),
      m.joined_via ? `Joined with: ${m.joined_via.label ?? UNTITLED}` : '',
    ]
      .filter(Boolean)
      .join(' · ')
    return {
      who: m.username,
      face: { kind: 'account', user },
      name: personCalled(user.display_name, user.username),
      color: roleColor(roles, m.role_ids) ?? null,
      owner: false,
      creator: m.is_creator,
      admin: m.is_admin,
      invited: null,
      facts: facts || null,
      joinedAt: hit.joined_at ?? null,
      createdAt: hit.created_at ?? null,
    }
  }
  return {
    choices: {
      get: choices(false),
      initial: choices(true),
      subscribe: changed => {
        heard.add(changed)
        const stop = store.subscribe(changed)
        return () => {
          heard.delete(changed)
          stop()
        }
      },
    },
    search: filters => {
      const query = hostedQuery(allowedFilters(filters, { created: true, via: invites() }))
      return fromPages(
        time(),
        async (cursor, signal) => {
          const page = await sendTo(account, ask.searchMembers(server, query, cursor, signal))
          const s = store.getState()
          for (const m of page.items) s.rememberMember(server, m.username, m)
          store.menu.noteMemberTimeouts(server, page.items)
          return { items: page.items.map(rowOf), next: page.next }
        },
        row => row.who,
        { delayMs: DEBOUNCE }
      )
    },
    menu: (who, x, y) => {
      const s = store.getState()
      const user = memberState(s, server, who)
      if (user)
        openActionMenu(x, y, { kind: 'member', user, server, where: 'list' }, undefined, account)
    },
    watch: () => {
      let live = true
      if (invites())
        void sendTo(account, ask.listPasswords(server)).then(
          found => {
            if (!live) return
            via = found.passwords.map(p => ({ id: String(p.id), label: p.label ?? UNTITLED }))
            for (const changed of heard) changed()
          },
          () => {}
        )
      return () => {
        live = false
      }
    },
  }
}

const byLocale = (a: string, b: string) => a.localeCompare(b)

const peer = (app: P2pApp, room: string): MemberSearch => {
  const { useP2p } = app
  const site = app.owner.store
  const view = () => useP2p.getState().servers[room]
  const choices = (initial: boolean) =>
    built(
      () => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        return [
          s.servers[room],
          maskOf(site.getState(), ownsP2pServer(s.servers[room], s.me)),
        ] as const
      },
      ([v, mask]): SearchChoices | null => {
        if (!v) return null
        const invites = viewCan(v, P.Invite)
        const via = new Map<string, string>()
        for (const m of v.members)
          if ((m.m === 'join' || m.m === 'invite') && m.via)
            via.set(m.via.id, mask(m.via.label) || 'Invite')
        const moderates =
          viewCan(v, P.Kick) ||
          viewCan(v, P.Ban) ||
          (v.timeouts === true && viewCan(v, P.TimeoutMembers))
        const search = v.memberSearch === true
        return {
          filters: search,
          roles: v.roles.map(r => ({ id: r.id, name: mask(r.name) })),
          via: invites ? [...via].map(([id, label]) => ({ id, label })) : null,
          created: false,
          joined: search,
          notes: moderates ? [EQUAL_ROLES_TEXT, HIGHER_ROLES_TEXT, OFFLINE_TEXT] : [],
          cards: true,
        }
      }
    )
  const rowOf = (
    v: NonNullable<ReturnType<typeof view>>,
    me: string | null,
    m: MemberView
  ): SearchRow => {
    const mask = maskOf(site.getState(), ownsP2pServer(v, me))
    const roles = m.roles
      .map(id => v.roles.find(r => r.id === id)?.name)
      .filter((n): n is string => !!n)
      .map(mask)
    const facts = [roles.join(', '), m.via ? `Joined with: ${mask(m.via.label) || 'Invite'}` : '']
      .filter(Boolean)
      .join(' · ')
    return {
      who: m.ik,
      face: { kind: 'key', ik: m.ik, of: v.members },
      name: p2pName(m.name, m.ik === me),
      color: nameColor(m, v.roles) ?? null,
      owner: m.owner,
      creator: false,
      admin: false,
      invited: m.m === 'invite' ? (m.waits ? VOUCH_INVITER_TEXT : 'Invited') : null,
      facts: facts || null,
      joinedAt: m.joinedAt === undefined ? null : Math.floor(m.joinedAt / 1000),
      createdAt: null,
    }
  }
  return {
    choices: {
      get: choices(false),
      initial: choices(true),
      subscribe: changed => {
        const stops = [useP2p.subscribe(changed), site.subscribe(changed)]
        return () => stops.forEach(stop => stop())
      },
    },
    search: filters => {
      const source = fromPages(
        time(),
        async cursor => {
          const v = view()
          if (!v) return { items: [], next: null }
          const shown = allowedFilters(filters, { created: false, via: viewCan(v, P.Invite) })
          const all = v.members.filter(m => m.m === 'join' || m.m === 'invite')
          const list = filterMembers(
            v.memberSearch === true ? shown : NO_FILTERS,
            all,
            p2pMemberRow,
            byLocale
          )
          const at = cursor === null ? 0 : Number(cursor)
          const me = useP2p.getState().me
          return {
            items: list.slice(at, at + PAGE).map(m => rowOf(v, me, m)),
            next: at + PAGE < list.length ? String(at + PAGE) : null,
          }
        },
        row => row.who
      )
      // The room's members change while the list shows: it is read again.
      let members = view()?.members
      const stop = useP2p.subscribe(s => {
        const now = s.servers[room]?.members
        if (now === members) return
        members = now
        source.refresh()
      })
      return {
        ...source,
        subscribe: changed => {
          const off = source.subscribe(changed)
          return () => {
            off()
            stop()
          }
        },
      }
    },
    menu: (who, x, y, card) => {
      const v = view()
      const m = v?.members.find(x => x.ik === who)
      if (v && m)
        openActionMenu(x, y, { kind: 'p2p_member', v, m }, { header: card }, app.owner, app)
    },
    watch: () => () => {},
  }
}

// Who a server or a room has, searched with the same filters on both sides, for its settings.
export const memberSearch = defineFeature<MemberSearch>('memberSearch', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: () => notInDms(),
  p2pDm: () => notInDms(),
})
