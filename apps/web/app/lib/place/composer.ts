import type { AccountSession } from '../client/session'
import { limitsOf } from '../instance_limits'
import type { P2pApp } from '../p2p/app/runtime'
import { chatKey, threadKey } from '../p2p/app/store'
import { LIMITS as P2P_LIMITS } from '../p2p/content'
import { bodyTooLong } from '../p2p/dm'
import { viewKey } from '../view'
import { defineFeature } from './feature'
import { built, type Live } from './live'

// Which of a place's lists a composer writes to: the conversation on screen or its open thread.
export type ComposerList = 'main' | 'thread'

export interface ComposeState {
  // What the draft, the reply and the sends go by; null with nothing to write to.
  key: string | null
  text: string
  // The most characters a message holds.
  max: number
  replying: boolean
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
            key !== null && s.replying[key] !== undefined,
          ] as const
        },
        ([key, text, max, replying]): ComposeState => ({ key, text, max, replying })
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
    }
  })

const peer = (app: P2pApp, room: string): Composer =>
  perList(list => {
    const { useP2p, p2pDm } = app
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
            key !== null && s.replying?.room === key,
          ] as const
        },
        ([key, text, replying]): ComposeState => ({ key, text, max: P2P_LIMITS.body, replying })
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
    }
  })

// The composers of a place: one for the conversation on screen, one for its open thread.
export const composer = defineFeature<Composer>('composer', {
  hostedServer: place => hosted(place.account),
  p2pRoom: place => peer(place.app, place.room),
  hostedDm: place => hosted(place.account),
  p2pDm: place => peer(place.app, place.room),
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
