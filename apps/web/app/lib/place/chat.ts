import type { AccountSession } from '../client/session'
import { mentionHandle } from '../display_name'
import { emojiBase } from '../reactions'
import { knownMentions, userRefFor } from '../selectors'
import type { Message, UserRef } from '../types'
import { defineFeature, unsupported } from './feature'
import { constant, fromStore, type Live } from './live'
import type { P2pDm, P2pRoom } from './place'

// Someone a message mentions, as its pill shows them.
export interface Mentioned {
  user: UserRef
  mine: boolean
  label: string
  // The server whose member card and look the pill opens (null: none of a server's own); a
  // place whose pills open nothing has no card.
  card: { server: string | null } | null
}

// What the shared message components (reactions, toolbar, mentions, editor) ask of the place
// their messages are in.
export interface Chat {
  toggleReaction: (m: Message, emoji: string, note?: boolean) => void
  loadReactors: (messageId: number, emoji: string) => Promise<UserRef[]>
  openReactPicker: (m: Message, anchor: HTMLElement | null) => void
  // Your own identity here, as authors carry it in `username`.
  self: Live<string | null>
  // The candidates that are people here, newline-joined.
  known: (m: Message, candidates: string[]) => Live<string>
  mention: (username: string) => Live<Mentioned>
  // The people to suggest for a mention, where the place lists them itself; null where the
  // composer searches the instance's members.
  people: ((query: string) => UserRef[]) | null
  // Whether messages here load what they show (images, grammars) from the instance by
  // themselves.
  fetches: boolean
}

const sameMention = (a: Mentioned, b: Mentioned) => a.user === b.user && a.mine === b.mine

const hosted = (account: AccountSession, server: string | null): Chat => {
  const { store } = account
  const card = { server }
  return {
    toggleReaction: (m, emoji, note) => store.getState().toggleReaction(m, emoji, note),
    loadReactors: (id, emoji) => store.getState().loadReactors(id, emoji),
    openReactPicker: (m, anchor) => store.getState().openReactPicker(m, anchor),
    self: fromStore(store, s => s.me?.username ?? null),
    known: (m, candidates) => fromStore(store, s => knownMentions(s, m, candidates)),
    mention: username =>
      fromStore(
        store,
        s => {
          const user = userRefFor(s, username)
          return { user, mine: s.me?.username === username, label: mentionHandle(user), card }
        },
        sameMention
      ),
    people: null,
    fetches: true,
  }
}

const peer = (place: P2pRoom | P2pDm) => {
  const { list, app, account } = place
  if (!list) return unsupported('Open the conversation first')
  const { me } = list
  const chat: Chat = {
    toggleReaction: (m, emoji, note = true) => {
      const id = list.idOf(m.id)
      if (!id) return
      const adding = !m.reactions?.some(r => r.emoji === emoji && r.me)
      if (adding && note) {
        const s = account.store.getState()
        s.noteEmoji(emojiBase(s.emoji, emoji), emoji)
      }
      void app.p2pDm.react(id, emoji, adding)
    },
    loadReactors: async (num, emoji) => {
      const id = list.idOf(num)
      const stored = id === null ? undefined : list.message(id)
      return (stored?.reactions.find(r => r.key === emoji)?.by ?? []).map(list.user)
    },
    openReactPicker: list.openPicker,
    self: constant(me),
    known: (_m, candidates) => constant(candidates.filter(c => list.names.has(c)).join('\n')),
    // A P2P identity carries its key where an account carries its username: its name is its
    // handle.
    mention: name => {
      const ik = list.names.get(name)
      const user = list.user(ik ?? '')
      return constant({
        user,
        mine: ik !== undefined && ik === me,
        label: user.display_name,
        card: null,
      })
    },
    people: list.people,
    fetches: false,
  }
  return chat
}

export const chat = defineFeature<Chat>('chat', {
  hostedServer: place => hosted(place.account, place.server),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account, null),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, Chat>()

// The account's own hosted chat, for what shows outside any place.
export const accountChat = (account: AccountSession): Chat => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account, null)
    own.set(account, known)
  }
  return known
}
