import type { AccountSession } from '../client/session'
import { personCalled, personName, type PersonName } from '../names'
import { memberLooks } from '../p2p/roles'
import { ownsP2pServer } from '../p2p/server/types'
import { shownUser, type ShownPerson } from '../people'
import type { Look } from '../role_looks'
import { byUsername, roleLook } from '../selectors'
import { lookOf } from '../server_profile'
import { maskOf } from '../store'
import type { MemberLook, Message, UserRef } from '../types'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import type { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'

// Someone as a place draws them beside what they wrote: their picture and name, and the color
// and icon their roles give the name.
export interface Face {
  // An account, whose picture and name open its profile in `server` (null: no server's own),
  // or an identity key, which opens nothing.
  who:
    | { kind: 'account'; person: UserRef & ShownPerson; server: string | null }
    | { kind: 'key'; person: UserRef & ShownPerson }
  name: PersonName
  color: string | undefined
  icon: Look['icon']
}

export interface Looks {
  // The author of a message of the place. `event`: the place's own key for the message, where it
  // has one beside the number.
  author: (m: Message, event?: string) => Live<Face>
  // Someone who is not read from a message (your own name on a message being sent).
  of: (user: UserRef) => Live<Face>
  // The look someone set for the place (a hosted server's profile), as the place shows it now;
  // null where there is none or until their member row is here.
  look: (username: string) => Live<MemberLook | null>
  // The color the roles of `user` give their name here.
  color: (user: UserRef) => Live<string | undefined>
  // Loads what the place needs to draw the people called `names`, and again when what it keeps
  // of them was dropped, until the returned function is called.
  load: (names: readonly string[]) => () => void
}

const idle = () => {}

const NO_ROLES: number[] = []

const hosted = (account: AccountSession, server: string | null): Looks => {
  const { store } = account
  type State = ReturnType<typeof store.getState>
  const now = (initial: boolean): State => (initial ? store.getInitialState() : store.getState())
  const member = (s: State, username: string) => {
    if (server === null) return undefined
    const list = s.members[server]?.list
    const known = s.memberInfo[server]
    return (
      (list ? byUsername(list).get(username) : undefined) ??
      (known && Object.hasOwn(known, username) ? (known[username] ?? undefined) : undefined)
    )
  }
  const roles = (s: State, username: string) =>
    [
      server === null ? undefined : s.servers[server]?.roles,
      member(s, username)?.role_ids ?? NO_ROLES,
    ] as const
  // The look `username` has here, in parts that compare by value.
  const lookParts = (s: State, username: string) => {
    const look = server === null ? null : lookOf(s, { server }, username)
    return [
      look === null,
      look?.name ?? null,
      look?.avatar_kind ?? null,
      look?.avatar_color ?? null,
      look?.avatar_image ?? null,
      look?.avatar_pic,
    ] as const
  }
  const asLook = ([none, name, kind, color, image, pic]: ReturnType<
    typeof lookParts
  >): MemberLook | null =>
    none
      ? null
      : {
          name,
          avatar_kind: kind,
          avatar_color: color,
          avatar_image: image,
          ...(pic === undefined ? {} : { avatar_pic: pic }),
        }
  const look = (username: string): Live<MemberLook | null> => {
    const at = (initial: boolean) =>
      built(
        () => lookParts(now(initial), username),
        parts => asLook(parts)
      )
    return { get: at(false), initial: at(true), subscribe: changed => store.subscribe(changed) }
  }
  const of = (user: UserRef): Live<Face> => {
    const at = (initial: boolean) =>
      built(
        () => {
          const s = now(initial)
          return [...lookParts(s, user.username), ...roles(s, user.username)] as const
        },
        ([none, name, kind, color, image, pic, serverRoles, held]): Face => {
          const person = shownUser(user, asLook([none, name, kind, color, image, pic]))
          const look = roleLook(serverRoles, [...held])
          return {
            who: { kind: 'account', person, server },
            name: personName(person),
            color: look.color,
            icon: look.icon,
          }
        }
      )
    return { get: at(false), initial: at(true), subscribe: changed => store.subscribe(changed) }
  }
  const load = (names: readonly string[]) => {
    if (server === null || !names.length) return idle
    const kept = () => {
      const s = store.getState()
      return `${s.memberInfo[server] !== undefined} ${s.memberInfoTrim[server] ?? 0}`
    }
    const ask = () => void store.getState().ensureMembers(server, [...names])
    let seen = kept()
    ask()
    return store.subscribe(() => {
      const now = kept()
      if (now === seen) return
      seen = now
      ask()
    })
  }
  return {
    load,
    author: m => of(m.author),
    of,
    look,
    color: user => ({
      get: () => {
        const [serverRoles, held] = roles(now(false), user.username)
        return roleLook(serverRoles, [...held]).color
      },
      initial: () => {
        const [serverRoles, held] = roles(now(true), user.username)
        return roleLook(serverRoles, [...held]).color
      },
      subscribe: changed => store.subscribe(changed),
    }),
  }
}

const NO_COLOR: Live<string | undefined> = { get: () => undefined, subscribe: () => () => {} }
const NO_LOOK: Live<MemberLook | null> = { get: () => null, subscribe: () => () => {} }

const peer = (place: P2pRoom | P2pDm): Looks => {
  const { app, account, room } = place
  const { useP2p } = app
  const shown = shownOf(place)
  const subscribe = (changed: () => void) => {
    const offs = [
      useP2p.subscribe(changed),
      account.store.subscribe(changed),
      shown.subscribe(changed),
    ]
    return () => offs.forEach(off => off())
  }
  // What the roles of a room give each member's name, by identity key; a conversation gives
  // none.
  const roleLooks = built(
    () => {
      const s = useP2p.getState()
      const v = place.kind === 'p2pRoom' ? s.servers[room] : undefined
      return [
        v?.members,
        v?.roles,
        maskOf(account.store.getState(), ownsP2pServer(v, s.me)),
      ] as const
    },
    ([members, roles, mask]) => (members && roles ? memberLooks({ members, roles }, mask) : null)
  )
  // `user` as the rows of the place carry it (its name where a username goes), under `ik` when
  // the message that names them is stored here.
  const face = (user: UserRef, sender: () => string | undefined): Live<Face> => {
    const get = built(
      () => [sender(), roleLooks()] as const,
      ([ik, looks]): Face => {
        const look = ik === undefined ? undefined : looks?.(ik)
        return {
          who: { kind: 'key', person: shownUser({ ...user, username: ik ?? user.username }, null) },
          name: personCalled(user.display_name, user.username),
          color: look?.color,
          icon: look?.icon,
        }
      }
    )
    return { get, subscribe }
  }
  return {
    author: (m, event) =>
      face(m.author, () => (event === undefined ? undefined : shown.get().message(event)?.sender)),
    of: user => face(user, () => undefined),
    look: () => NO_LOOK,
    color: () => NO_COLOR,
    load: () => idle,
  }
}

// How a place draws the people in it.
export const looks = defineFeature<Looks>('looks', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account, null),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, Looks>()

// The account's own looks, for what shows outside any place.
export const accountLooks = (account: AccountSession): Looks => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account, null)
    own.set(account, known)
  }
  return known
}
