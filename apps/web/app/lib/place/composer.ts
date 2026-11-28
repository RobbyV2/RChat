import type { AccountSession } from '../client/session'
import { limitsOf } from '../instance_limits'
import { chatKey, threadKey } from '../p2p/app/store'
import { LIMITS as P2P_LIMITS } from '../p2p/content'
import { bodyTooLong, fullNote } from '../p2p/dm'
import { peerServer } from '../actions/p2p_server'
import { canOf, p2pMask } from '../channel_perms'
import { guestPostingStatus, postGuestFrom } from '../guest_chat'
import { outgoing } from '../link_safety'
import { p2pName, personCalled, type P2pName, type PersonName } from '../names'
import { displayName } from '../p2p/contacts'
import { TRANSFERRED_TEXT } from '../p2p/flows'
import { channelCan } from '../selectors'
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
  // Rises each time the field is asked to take the focus; 0 while it never was.
  focus: number
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

// Why nothing can be written to a list, as the bar in the composer's place says it.
export type Gate =
  // Not a member of the server yet; `name` is what the server is called.
  | { kind: 'join'; server: string; name: string }
  // A guest who may write here, in the guest's own field.
  | { kind: 'guestWrite' }
  | { kind: 'guest'; posting: 'off' | 'checking' | 'paused' | 'unavailable' }
  | { kind: 'noSend' }
  | { kind: 'noThreads' }
  // The identity is in use on another device, or this one only reads.
  | { kind: 'elsewhere' }
  | { kind: 'moved'; at: number | null }
  | { kind: 'moving' }
  // No longer (or not yet) a member of the room. `next`: the copy that took the room's place;
  // `forget`: whether the room can be removed from this device.
  | { kind: 'out'; line: string; waiting: boolean; next: string | null; forget: boolean }
  | { kind: 'full'; line: string }
  | { kind: 'noContact' }
  | { kind: 'blocked'; name: P2pName }
  | { kind: 'notMutual'; name: P2pName }

export interface GateState {
  // What stands in the composer's place whatever else holds; null with nothing.
  first: Gate | null
  // When a timeout of the reader here ends (ms); null without one.
  until: number | null
  // What stands there once no timeout runs.
  then: Gate | null
}

const OPEN: GateState = { first: null, until: null, then: null }

// The text being written to one list of a place.
export interface Compose {
  state: Live<ComposeState>
  gate: Live<GateState>
  // Opens the copy that took a room's place, and removes a room you are out of from this device.
  openNext: () => void
  forget: () => void
  // Joins the server whose `join` gate stands, with its password when it asks for one.
  join: (password?: string) => Promise<void>
  // Sends `content` as the guest whose `guestWrite` gate stands.
  sendAsGuest: (content: string) => Promise<void>
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
            key !== null && s.composerFocus?.key === key ? s.composerFocus.n : 0,
          ] as const
        },
        ([key, text, max, reply, server, me, focus]): ComposeState => ({
          key,
          text,
          max,
          focus,
          replying: reply
            ? {
                to: { kind: 'account', user: reply.message.author, server },
                mention: reply.message.author.username === me ? null : reply.mention,
              }
            : null,
        })
      )
    const get = state(false)
    const gate = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const v = s.view
          const server = v?.kind === 'channel' ? v.server : null
          const root = s.panel?.kind === 'thread' ? s.panel.root : null
          const channel =
            list === 'thread'
              ? (root?.channel_id ?? null)
              : v?.kind === 'channel'
                ? v.channelId
                : null
          const mine = server === null ? undefined : s.me?.servers.find(x => x.name === server)
          const can = server === null ? null : channelCan(s, server, channel)
          return [
            server,
            server === null ? null : (s.servers[server]?.display_name ?? server),
            s.guest,
            !s.me || server === null || mine !== undefined,
            server === null ? null : guestPostingStatus(s, server, channel),
            channel !== null && keyOf(initial) !== null,
            mine?.timed_out_until,
            can === null || can.send,
            can === null || can.threads,
            list === 'thread' &&
              root !== null &&
              root.reply_count === 0 &&
              !s.messages[`t${root.id}`]?.length,
          ] as const
        },
        ([
          server,
          name,
          guest,
          member,
          posting,
          writable,
          until,
          send,
          threads,
          unstarted,
        ]): GateState => {
          if (server !== null && name !== null && !guest && !member)
            return { ...OPEN, first: { kind: 'join', server, name } }
          if (guest) {
            const kind = posting ?? 'unavailable'
            const first: Gate =
              kind === 'ready'
                ? writable
                  ? { kind: 'guestWrite' }
                  : { kind: 'guest', posting: 'unavailable' }
                : { kind: 'guest', posting: kind }
            return { ...OPEN, first }
          }
          if (server === null) return OPEN
          return {
            first: null,
            until: until === undefined || until === null ? null : until * 1000,
            then: !send ? { kind: 'noSend' } : unstarted && !threads ? { kind: 'noThreads' } : null,
          }
        }
      )
    const getGate = gate(false)
    return {
      state: { get, initial: state(true), subscribe: changed => store.subscribe(changed) },
      gate: {
        get: getGate,
        initial: gate(true),
        subscribe: changed => store.subscribe(changed),
      },
      openNext: () => {},
      forget: () => {},
      join: async password => {
        const { first } = getGate()
        if (first?.kind === 'join') await store.getState().joinServer(first.server, password)
      },
      sendAsGuest: async content => {
        const s = store.getState()
        const { key } = get()
        const v = s.view
        const root = list === 'thread' && s.panel?.kind === 'thread' ? s.panel.root : null
        const channel =
          list === 'thread' ? root?.channel_id : v?.kind === 'channel' ? v.channelId : null
        if (getGate().first?.kind !== 'guestWrite' || key === null || v?.kind !== 'channel') return
        if (channel === null || channel === undefined) return
        const message = await account.lifetime.live(
          postGuestFrom(account, v.server, `/channels/${channel}/guest-messages`, {
            content: outgoing(s.linkPrefs, content),
            reply_to: s.replying[key]?.message.id,
            thread_root_id: root?.id,
          })
        )
        store.getState().applyWsEvent({
          type: 'message',
          server: v.server,
          channel_id: channel,
          dm_id: null,
          dm_users: null,
          message,
        })
        store.getState().cancelReply(key)
      },
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
            key !== null && s.composerFocus?.key === key ? s.composerFocus.n : 0,
          ] as const
        },
        ([key, text, id, rows, focus]): ComposeState => {
          const answered = id === null ? undefined : rows.message(id)
          return {
            key,
            text,
            focus,
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
    const gate = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const ch = list === 'thread' ? s.thread?.ch : s.chat?.ch
          const v = place.kind === 'p2pRoom' ? s.servers[room] : undefined
          const t = list === 'thread' && s.thread?.room === room ? s.thread : null
          const mask = v && ch ? p2pMask(v, ch) : null
          const peerIk = s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer
          return [
            s.reader || s.elsewhere,
            s.status === 'moved',
            s.movedAt,
            s.movingAt !== null,
            v,
            v && ch ? v.channels.find(c => c.id === ch)?.send : undefined,
            t !== null && !t.loading && !t.head?.replies && !t.messages?.length,
            mask === null || canOf(mask).threads,
            place.kind === 'p2pDm' ? s.rooms[room] : undefined,
            place.kind === 'p2pDm' ? s.contacts.find(c => c.ik === peerIk) : undefined,
          ] as const
        },
        ([
          elsewhere,
          moved,
          movedAt,
          moving,
          v,
          send,
          unstarted,
          threads,
          conversation,
          contact,
        ]): GateState => {
          const away: Gate | null = elsewhere
            ? { kind: 'elsewhere' }
            : moved
              ? { kind: 'moved', at: movedAt }
              : moving
                ? { kind: 'moving' }
                : null
          if (away) return { ...OPEN, first: away }
          if (place.kind === 'p2pDm') {
            const first: Gate | null = conversation?.full
              ? { kind: 'full', line: fullNote(conversation, app.p2p.limits().dag) }
              : !contact
                ? { kind: 'noContact' }
                : contact.state === 'blocked'
                  ? { kind: 'blocked', name: p2pName(displayName(contact)) }
                  : contact.state !== 'mutual'
                    ? { kind: 'notMutual', name: p2pName(displayName(contact)) }
                    : null
            return { ...OPEN, first }
          }
          if (!v) return OPEN
          const line = v.readOnly
            ? v.readOnly
            : v.upgraded
              ? TRANSFERRED_TEXT
              : v.me === 'ban'
                ? 'You are banned from this server.'
                : v.me === 'leave'
                  ? 'You are no longer a member of this server.'
                  : v.me !== 'join'
                    ? (v.joinWait ?? 'Joining. You can write once a member has let you in.')
                    : null
          if (line !== null)
            return {
              ...OPEN,
              first: {
                kind: 'out',
                line,
                waiting: !!v.joinWait && v.me !== 'join',
                next: v.upgraded ? v.next : null,
                forget: v.me !== 'join' && v.me !== 'invite' && v.me !== null,
              },
            }
          return {
            first: null,
            until: v.timedOutUntil ?? null,
            then:
              send === false
                ? { kind: 'noSend' }
                : v.full
                  ? { kind: 'full', line: 'This server reached its storage limit on this device.' }
                  : unstarted && !threads
                    ? { kind: 'noThreads' }
                    : null,
          }
        }
      )
    const getGate = gate(false)
    // When each key last said it is typing; the place wants to hear it again only so often.
    const said = new Map<string, number>()
    return {
      state: { get, initial: state(true), subscribe: changed => useP2p.subscribe(changed) },
      gate: { get: getGate, initial: gate(true), subscribe: changed => useP2p.subscribe(changed) },
      openNext: () => {
        const { first } = getGate()
        if (first?.kind === 'out' && first.next !== null) app.p2pServer.open(first.next)
      },
      forget: () => {
        const v = useP2p.getState().servers[room]
        if (v) peerServer.forIdentity(app).confirmForget(v, place.account)
      },
      join: async () => {},
      sendAsGuest: async () => {},
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
