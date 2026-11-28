import { refusalOf, type Refusal } from '../api_errors'
import type { AccountSession } from '../client/session'
import {
  dmPeople,
  groupSuggestions,
  recentAuthors,
  SUGGEST_DEBOUNCE,
  suggestKey,
  suggestPeople,
  withYouLast,
  type GroupSuggestion,
} from '../mention_suggest'
import { time } from '../platform/time'
import { lookIn, shownParts, shownUser } from '../server_profile'
import { channelCan } from '../selectors'
import { threadKey } from '../store'
import type { MemberLook, Message, Role, UserRef } from '../types'
import { viewKey } from '../view'
import { built, type Live } from './live'
import type { ListKind } from './place'

// Who a mention can name while it is typed in one message list of a place.
export interface MentionPeople {
  // The people a query finds now; a new function whenever what it finds changes.
  find: Live<(query: string) => UserRef[]>
  // The groups (everyone, roles) a query finds beside them.
  groups: Live<(query: string) => GroupSuggestion[]>
  // Says what is being typed (null: nothing), so a place that looks people up outside what it
  // holds can.
  ask: (query: string | null) => void
  // Why the last lookup outside what the place holds did not come; null when it did, or there is
  // none. What `find` gives then comes only from what is held here.
  trouble: Live<Refusal | null>
}

const NO_MESSAGES: Message[] = []
const NO_PEOPLE: UserRef[] = []
const NO_ROLES: Role[] = []
const CACHE_MAX = 200
const nobody = () => NO_PEOPLE
const NO_GROUPS: GroupSuggestion[] = []
const noGroups = () => NO_GROUPS
const never = () => () => {}
const noTrouble: Live<Refusal | null> = { get: () => null, subscribe: never }

// A place that holds everyone a mention can name: `people` finds them, and there are no groups.
export const heldPeople = (
  people: () => (query: string) => UserRef[],
  subscribe: (changed: () => void) => () => void
): MentionPeople => ({
  find: { get: people, subscribe },
  groups: { get: () => noGroups, subscribe: never },
  ask: () => {},
  trouble: noTrouble,
})

// The mentions of a hosted list: recent authors in view, then the server's members that match
// the query (asked of the instance after a pause, and kept), then the members held here. A DM
// suggests the other person and you. `where` names the server or the DM; null outside both.
export const hostedPeople = (
  account: AccountSession,
  where: { server: string } | { dmId: number } | null,
  list: ListKind
): MentionPeople => {
  const { store, api } = account
  const server = where !== null && 'server' in where ? where.server : null
  const dmId = where !== null && 'dmId' in where ? where.dmId : null
  const cache = new Map<string, UserRef[]>()
  const heard = new Set<() => void>()
  let tick = 0
  let pending: (() => void) | undefined
  let refused: Refusal | null = null
  const troubled = new Set<() => void>()
  const say = (next: Refusal | null) => {
    if (refused === next) return
    refused = next
    for (const changed of [...troubled]) changed()
  }
  const find = built(
    () => {
      const s = store.getState()
      const main = s.view ? viewKey(s.view) : null
      const thread = s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : null
      const key = list === 'thread' ? thread : main
      return [
        dmId === null ? null : (s.dms.find(d => d.id === dmId)?.other ?? null),
        s.me?.username ?? null,
        s.me?.display_name ?? '',
        s.me?.avatar_kind ?? 'identicon',
        s.me?.avatar_color ?? null,
        (key ? s.messages[key] : undefined) ?? NO_MESSAGES,
        (list === 'thread' && s.view?.kind === 'channel' && main ? s.messages[main] : undefined) ??
          NO_MESSAGES,
        (server ? s.members[server]?.list : undefined) ?? NO_PEOPLE,
        server ? s.memberInfo[server] : undefined,
        server === null ? null : shownParts(s, server).names,
        server === null ? null : shownParts(s, server).rest,
        tick,
      ] as const
    },
    ([dmOther, meName, meShown, meKind, meColor, own, parent, members, info, names, rest]) => {
      const me: UserRef | null =
        meName === null
          ? null
          : {
              username: meName,
              display_name: meShown,
              avatar_kind: meKind,
              avatar_color: meColor,
            }
      if (dmOther) return (q: string) => suggestPeople(q, [dmPeople(dmOther, me)], () => false)
      if (server === null) return nobody
      const parts = names === null || rest === null ? null : { names, rest }
      const shownOf = <T extends UserRef & { profile?: MemberLook }>(m: T) =>
        shownUser(m, parts && m.profile ? lookIn(m.profile, parts) : null)
      return (q: string) => {
        let remote: UserRef[] = NO_PEOPLE
        for (let n = q.length; n > 0; n -= 1) {
          const hit = cache.get(suggestKey(server, q.slice(0, n)))
          if (hit) {
            remote = hit
            break
          }
        }
        // People match and show under the names the server shows; `remote` carries them already.
        const looks = new Map(
          [...members, ...Object.values(info ?? {})].flatMap(m =>
            m ? [[m.username, shownOf(m)] as const] : []
          )
        )
        const shownAs = (group: readonly UserRef[]) => group.map(u => looks.get(u.username) ?? u)
        return suggestPeople(
          q,
          withYouLast(
            [shownAs(recentAuthors(own)), shownAs(recentAuthors(parent)), remote, shownAs(members)],
            me && shownAs([me])[0]
          ),
          name => info?.[name] === null
        )
      }
    }
  )
  // `@everyone`, `@here` and the roles you may mention, in a channel's own list only.
  const groups = built(
    () => {
      const s = store.getState()
      const channelId = s.view?.kind === 'channel' ? s.view.channelId : null
      const open =
        server !== null &&
        list === 'main' &&
        s.view?.kind === 'channel' &&
        !!s.me?.servers.some(x => x.name === server)
      return [
        open,
        open && server !== null ? channelCan(s, server, channelId).mention : false,
        (server ? s.servers[server]?.roles : undefined) ?? NO_ROLES,
      ] as const
    },
    ([open, allowed, roles]) =>
      open ? (q: string) => groupSuggestions(q, allowed, roles) : noGroups
  )
  const subscribe = (changed: () => void) => {
    const off = store.subscribe(changed)
    heard.add(changed)
    return () => {
      off()
      heard.delete(changed)
    }
  }
  return {
    find: { get: find, subscribe },
    groups: { get: groups, subscribe: changed => store.subscribe(changed) },
    ask: query => {
      pending?.()
      pending = undefined
      if (server === null || !query) return say(null)
      const key = suggestKey(server, query)
      if (cache.has(key)) return say(null)
      let live = true
      const stop = time().after(SUGGEST_DEBOUNCE, () => {
        const view = store.getState().view
        const channelId = view?.kind === 'channel' && view.server === server ? view.channelId : null
        api.suggestMembers(server, query, channelId).then(
          found => {
            if (cache.size >= CACHE_MAX) cache.clear()
            cache.set(key, found)
            tick += 1
            for (const changed of heard) changed()
            if (live) say(null)
          },
          (error: unknown) => {
            if (live) say(refusalOf(error))
          }
        )
      })
      pending = () => {
        live = false
        stop()
      }
    },
    trouble: {
      get: () => refused,
      subscribe: changed => {
        troubled.add(changed)
        return () => troubled.delete(changed)
      },
    },
  }
}
