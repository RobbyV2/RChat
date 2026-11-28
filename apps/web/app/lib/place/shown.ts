import { p2pMembersHidden } from '../member_list'
import { loaded as rulesLoaded } from '../perms'
import { displayName } from '../p2p/contacts'
import { withMissed, type P2pMessage } from '../p2p/dm'
import { asMessage, numbering } from '../p2p/shown_message'
import { roomLooksKey } from '../server_profile'
import type { Message, UserRef } from '../types'
import { built, type Live } from './live'
import type { P2pDm, P2pRoom } from './place'

// Someone a message can mention: who they are, and the handle the composer writes.
export interface Mentionable {
  ik: string
  name: string
  handle: string
}

export interface ShownRow {
  p: P2pMessage
  m: Message
}

// One message list of a P2P place as the shared message components read it: its rows carry
// numbers where they expect message ids, and names where they expect usernames.
export interface Shown {
  me: string | null
  // The stored messages the rows show, in order.
  messages: P2pMessage[]
  rows: ShownRow[]
  num: Map<string, number>
  idOf: (num: number) => string | null
  message: (id: string) => P2pMessage | undefined
  user: (ik: string) => UserRef
  // The name a key goes by here, as threads are searched by it.
  name: (ik: string) => string
  // The names that mention someone here, lowercased, to their identity keys.
  names: ReadonlyMap<string, string>
  people: (query: string) => UserRef[]
}

const NO_MESSAGES: P2pMessage[] = []

type Naming = Pick<Shown, 'user' | 'name' | 'names' | 'people'>

const naming = (
  place: P2pRoom | P2pDm,
  name: Shown['name'],
  user: Shown['user'],
  mentionable: Mentionable[]
): Naming => {
  const names = new Map<string, string>()
  for (const p of mentionable)
    for (const n of [p.handle, p.name]) {
      const k = n.trim().toLowerCase()
      if (k && !names.has(k)) names.set(k, p.ik)
    }
  return {
    user,
    name,
    names,
    people: query => {
      const needle = query.toLowerCase()
      return mentionable
        .filter(
          p =>
            p.handle &&
            (p.handle.toLowerCase().startsWith(needle) || p.name.toLowerCase().startsWith(needle))
        )
        .slice(0, 20)
        .map(p => ({ ...place.app.p2pUser(p.ik, p.name), username: p.handle }))
    },
  }
}

type PeerState = ReturnType<P2pRoom['app']['useP2p']['getState']>

// Who is who in a room: the members' names and the looks they set for it. Built again only when
// a member's name or look changes.
const roomNaming = (place: P2pRoom, state: () => PeerState) => {
  const { app, room } = place
  const who = built(
    () => [roomLooksKey(state().servers[room]?.members)] as const,
    () => ({
      name: (ik: string) => app.memberName(room, ik),
      user: (ik: string) => app.memberUser(room, ik),
    })
  )
  // Without the member list only the authors in view are suggested.
  const authors = built(
    () => {
      const s = state()
      const v = s.servers[room]
      const here = s.chat?.room === room ? s.chat : null
      const hidden =
        !!v &&
        !!s.me &&
        rulesLoaded() &&
        p2pMembersHidden(
          v,
          s.me,
          s.server?.room === room ? (s.server.ch ?? null) : null,
          app.owner.store.getState().settings.member_lists !== false
        ) !== null
      return [hidden, hidden ? here?.messages : undefined] as const
    },
    ([hidden, messages]) => (hidden ? new Set((messages ?? []).map(m => m.sender)) : null)
  )
  return built(
    () => [who(), state().servers[room]?.members, authors()] as const,
    ([{ name, user }, members, seen]) =>
      naming(
        place,
        name,
        user,
        (members ?? [])
          .filter(m => m.m === 'join' && (seen === null || seen.has(m.ik)))
          .map(m => ({ ik: m.ik, name: m.name, handle: m.name }))
      )
  )
}

// Who is who in a conversation: you under your own name, the contact under the name you gave
// them.
const dmNaming = (place: P2pDm, state: () => PeerState) => {
  const { app, room } = place
  return built(
    () => {
      const s = state()
      const peerIk = (s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer) ?? ''
      return [s.contacts.find(c => c.ik === peerIk), s.me, s.name] as const
    },
    ([peer, me, myName]) => {
      const peerName = peer ? displayName(peer) : 'Contact'
      const name = (ik: string) => (ik === me ? myName || 'You' : peerName)
      const mentionable: Mentionable[] = []
      if (peer) {
        mentionable.push({ ik: peer.ik, name: peerName, handle: peer.name || peer.petname || '' })
        if (peer.petname && peer.name)
          mentionable.push({ ik: peer.ik, name: peer.petname, handle: peer.petname })
      }
      if (me && myName) mentionable.push({ ik: me, name: myName, handle: myName })
      return naming(place, name, ik => app.p2pUser(ik, name(ik)), mentionable)
    }
  )
}

// The messages a list of the place holds while it is open: the conversation with the calls
// missed in it, or the thread with its first message.
const loaded = (place: P2pRoom | P2pDm, state: () => PeerState) => {
  const here = (at: { room: string; ch?: string | null }) =>
    at.room === place.room && (place.kind === 'p2pRoom') === !!at.ch
  if (place.list === 'thread')
    return built(
      () => {
        const t = state().thread
        return t && here(t)
          ? ([t.head, t.messages ?? NO_MESSAGES] as const)
          : ([null, NO_MESSAGES] as const)
      },
      ([head, messages]) => (head ? [head, ...messages] : messages)
    )
  return built(
    () => {
      const c = state().chat
      return c && here(c)
        ? ([c.messages ?? NO_MESSAGES, c.missed, c.more] as const)
        : ([NO_MESSAGES, undefined, false] as const)
    },
    ([messages, missed, more]) =>
      place.kind === 'p2pDm' && missed ? withMissed(messages, missed, more) : messages
  )
}

const model = (place: P2pRoom | P2pDm, state: () => PeerState) => {
  const who = place.kind === 'p2pRoom' ? roomNaming(place, state) : dmNaming(place, state)
  const messages = loaded(place, state)
  return built(
    () => [messages(), who(), state().me] as const,
    ([list, named, me]): Shown => {
      const num = numbering(list)
      // Quoted messages outside the list take numbers below zero.
      const quoted = new Map<string, number>()
      const quotes = new Map<number, string>()
      for (const m of list)
        if (m.reply && !num.has(m.reply.id) && !quoted.has(m.reply.id)) {
          const n = -1 - quoted.size
          quoted.set(m.reply.id, n)
          quotes.set(n, m.reply.id)
        }
      const byNum = new Map<number, string>()
      const byId = new Map<string, P2pMessage>()
      const rows = list.map(p => {
        const n = num.get(p.id) as number
        byNum.set(n, p.id)
        byId.set(p.id, p)
        const reply = p.reply ? (num.get(p.reply.id) ?? quoted.get(p.reply.id) ?? 0) : 0
        return { p, m: asMessage(p, n, reply, named.user, me ?? '') }
      })
      return {
        me,
        messages: list,
        rows,
        num,
        idOf: n => byNum.get(n) ?? quotes.get(n) ?? null,
        message: id => byId.get(id),
        ...named,
      }
    }
  )
}

const models = new WeakMap<P2pRoom | P2pDm, Live<Shown>>()

// The list `place` names (its conversation, or the thread open in it), live.
export const shownOf = (place: P2pRoom | P2pDm): Live<Shown> => {
  let known = models.get(place)
  if (!known) {
    const { useP2p } = place.app
    known = {
      get: model(place, useP2p.getState),
      initial: model(place, useP2p.getInitialState),
      subscribe: changed => useP2p.subscribe(changed),
    }
    models.set(place, known)
  }
  return known
}

export interface ReactPick {
  m: Message
  anchor: HTMLElement | null
}

interface Picker extends Live<ReactPick | null> {
  set: (pick: ReactPick | null) => void
}

const pickers = new WeakMap<P2pRoom | P2pDm, Picker>()

// The message the list's reaction picker is open for.
export const reactPickOf = (place: P2pRoom | P2pDm): Picker => {
  let known = pickers.get(place)
  if (!known) {
    let pick: ReactPick | null = null
    const heard = new Set<() => void>()
    known = {
      get: () => pick,
      initial: () => null,
      subscribe: changed => {
        heard.add(changed)
        return () => void heard.delete(changed)
      },
      set: next => {
        pick = next
        for (const changed of heard) changed()
      },
    }
    pickers.set(place, known)
  }
  return known
}
