import type { AccountSession } from '../client/session'
import { limitsOf } from '../instance_limits'
import { chatKey, threadKey } from '../p2p/app/store'
import { LIMITS as P2P_LIMITS } from '../p2p/content'
import { bodyTooLong } from '../p2p/dm'
import { personCalled, type PersonName } from '../names'
import type { UserRef } from '../types'
import { viewKey } from '../view'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'

// Which of a place's lists a composer writes to: the conversation on screen or its open thread.
export type ComposerList = 'main' | 'thread'

export interface ComposeState {
  // What the draft, the reply and the sends go by; null with nothing to write to.
  key: string | null
  text: string
  // The most characters a message holds.
  max: number
  // The message being answered; null while none is.
  replying: Replying | null
}

// The message a draft answers, as its bar above the composer says it.
export interface Replying {
  // Its author: an account as `server` shows it (null: no server's look), or a name the place
  // gives.
  to:
    { kind: 'account'; user: UserRef; server: string | null } | { kind: 'named'; name: PersonName }
  // Whether the answer pings the author; null where there is nothing to choose (your own
  // message, or a place that has no such switch).
  mention: boolean | null
}

// The text being written to one list of a place.
export interface Compose {
  state: Live<ComposeState>
  getText: () => string
  setText: (text: string) => void
  // Whether the text is too big to send although its character count fits.
  oversize: (text: string) => boolean
  // Says whether you are typing in `key` (a key of `state`), as often as the place wants it.
  typing: (key: string, active: boolean) => void
  // Starts editing your last message; false when there is none to edit.
  editLast: () => boolean
  cancelReply: () => void
  toggleReplyMention: () => void
}

export interface Composer {
  at: (list: ComposerList) => Compose
}

const perList = (make: (list: ComposerList) => Compose): Composer => {
  const made = new Map<ComposerList, Compose>()
  return {
    at: list => {
      let known = made.get(list)
      if (!known) {
        known = make(list)
        made.set(list, known)
      }
      return known
    },
  }
}

const never = () => false

const hosted = (account: AccountSession): Composer =>
  perList(list => {
    const { store } = account
    const keyOf = (initial: boolean) => {
      const s = initial ? store.getInitialState() : store.getState()
      if (list === 'thread') return s.panel?.kind === 'thread' ? `t${s.panel.root.id}` : null
      return s.view ? viewKey(s.view) : null
    }
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const key = keyOf(initial)
          return [
            key,
            key === null ? '' : (s.drafts[key] ?? ''),
            limitsOf(s.instance).message_chars,
            key === null ? undefined : s.replying[key],
            s.view?.kind === 'channel' ? s.view.server : null,
            s.me?.username,
          ] as const
        },
        ([key, text, max, reply, server, me]): ComposeState => ({
          key,
          text,
          max,
          replying: reply
            ? {
                to: { kind: 'account', user: reply.message.author, server },
                mention: reply.message.author.username === me ? null : reply.mention,
              }
            : null,
        })
      )
    const get = state(false)
    return {
      state: { get, initial: state(true), subscribe: changed => store.subscribe(changed) },
      getText: () => get().text,
      setText: text => {
        const { key } = get()
        if (key !== null) store.getState().setDraft(key, text)
      },
      oversize: never,
      typing: (key, active) => store.getState().noteTyping(key, active),
      editLast: () => {
        const { key } = get()
        return key !== null && store.getState().editLast(key)
      },
      cancelReply: () => {
        const { key } = get()
        if (key !== null) store.getState().cancelReply(key)
      },
      toggleReplyMention: () => {
        const { key } = get()
        if (key !== null) store.getState().toggleReplyMention(key)
      },
    }
  })

const peer = (place: P2pRoom | P2pDm): Composer =>
  perList(list => {
    const { app, room } = place
    const { useP2p, p2pDm } = app
    // The rows of the list the composer writes to, where the answered message is looked up.
    const shown = shownOf(
      place.kind === 'p2pRoom' ? P2pRoom.open(app, room, list) : P2pDm.open(app, room, list)
    )
    const keyOf = (initial: boolean) => {
      const s = initial ? useP2p.getInitialState() : useP2p.getState()
      if (list === 'thread') return s.thread?.room === room ? threadKey(s.thread) : null
      return s.chat?.room === room ? chatKey(s.chat) : null
    }
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const key = keyOf(initial)
          return [
            key,
            key === null ? '' : (s.drafts[key] ?? ''),
            key !== null && s.replying?.room === key ? s.replying.id : null,
            initial && shown.initial ? shown.initial() : shown.get(),
          ] as const
        },
        ([key, text, id, rows]): ComposeState => {
          const answered = id === null ? undefined : rows.message(id)
          return {
            key,
            text,
            max: P2P_LIMITS.body,
            replying: answered
              ? {
                  to: {
                    kind: 'named',
                    name: personCalled(rows.name(answered.sender), answered.sender),
                  },
                  mention: null,
                }
              : null,
          }
        }
      )
    const get = state(false)
    // When each key last said it is typing; the place wants to hear it again only so often.
    const said = new Map<string, number>()
    return {
      state: { get, initial: state(true), subscribe: changed => useP2p.subscribe(changed) },
      getText: () => get().text,
      setText: text => {
        const { key } = get()
        if (key !== null) p2pDm.setDraft(key, text)
      },
      oversize: bodyTooLong,
      typing: (key, active) => {
        if (!active) {
          if (said.delete(key)) p2pDm.typing(key, false)
          return
        }
        const now = app.owner.time.now()
        const last = said.get(key)
        if (last !== undefined && now - last < p2pDm.typingEvery(key)) return
        said.set(key, now)
        p2pDm.typing(key, true)
      },
      editLast: () => {
        const { key } = get()
        return key !== null && p2pDm.editLast(key)
      },
      cancelReply: () => p2pDm.cancelReply(),
      toggleReplyMention: () => {},
    }
  })

// The composers of a place: one for the conversation on screen, one for its open thread.
export const composer = defineFeature<Composer>('composer', {
  hostedServer: place => hosted(place.account),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, Composer>()

// The account's own composers, for one shown with no place around it.
export const accountComposer = (account: AccountSession): Composer => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account)
    own.set(account, known)
  }
  return known
}
