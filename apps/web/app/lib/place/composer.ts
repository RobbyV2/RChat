import type { AccountSession } from '../client/session'
import { limitsOf } from '../instance_limits'
import { chatKey, chatScope, threadKey, threadScope } from '../p2p/app/store'
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
import { textOnlyDestination } from '../channel_content'
import {
  fwdSource,
  instanceServer,
  p2pDestination,
  p2pForward,
  type ForwardDestination,
} from '../forward'
import { clipAllowed, clipSourceNames } from '../forward_viewing'
import { identityScopeKey } from '../p2p/app/host'
import { defineFeature } from './feature'
import { built, type Live } from './live'
import { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'
import { namePasted } from '../pasted_files'
import { altError } from '../alt_text'
import { previewFor } from '../apps/preview'
import { hasInviteCode, INVITE_POST_TEXT } from '../p2p/flows'
import type { RelayChoice } from '../relays'
import { charCount, messageFilterOn } from '../rules'
import { parseSed } from '../sed'
import { shownTypers } from '../server_profile'
import { ownsP2pServer } from '../p2p/server/types'
import type { OwnLoad } from '../own_loads'
import type { PollTarget } from '../polls_store'
import {
  laterBlocked,
  type ComposerDraft,
  type ScheduledItem,
  type ScheduledOps,
  type ScheduledSide,
} from '../scheduled'
import type { UploadMode } from '../attachments'

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
  // When slow mode lets the next message through (ms); 0 without a wait.
  slowUntil: number
  // Where a poll made here is posted; null where none can be.
  poll: PollTarget | null
  to: WriteTo
  // What the completions of the field draw their people and messages by.
  listKey: string | null
  // The instance's word filter checks what is written here.
  filtered: boolean
  // Written as a P2P identity, to its peers.
  peer: boolean
}

// What a field says it writes to.
export interface WriteTo {
  // The thread, a channel by its name, or a person by their handle; null while not known.
  what:
    | { kind: 'thread' }
    | { kind: 'channel'; name: string }
    | { kind: 'person'; handle: string }
    | null
  // Your own place: its names are yours to read unmasked.
  own: boolean
  // What stands there while names are hidden; null where the name stays.
  hidden: string | null
}

const sameTo = (a: WriteTo, b: WriteTo) =>
  a.own === b.own &&
  a.hidden === b.hidden &&
  a.what?.kind === b.what?.kind &&
  (a.what?.kind === 'channel' && b.what?.kind === 'channel' ? a.what.name === b.what.name : true) &&
  (a.what?.kind === 'person' && b.what?.kind === 'person' ? a.what.handle === b.what.handle : true)

// `read`, keeping the last value while it says the same.
const keptTo = (read: () => WriteTo) => {
  let held: WriteTo | null = null
  return () => {
    const next = read()
    if (held === null || !sameTo(held, next)) held = next
    return held
  }
}

// The messages scheduled for later, as the chip above a composer and Send later read them.
export interface LaterState {
  side: ScheduledSide
  items: ScheduledItem[]
  // What a row of the list can do; null where nothing can be scheduled.
  ops: ScheduledOps | null
  // Whether this list's scheduled messages are fetched from where they are kept.
  fetched: boolean
  // What a failed fetch is filed under; null where nothing is fetched.
  notice: OwnLoad | null
}

// Who is typing in a list, as the line above its composer names them.
export interface Typers {
  names: string[]
  // The accounts whose look in `server` is not loaded yet.
  ask: string[]
  server: string | null
}

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((x, i) => x === b[i])

// `read`, keeping the last value while it names the same people.
const keptTypers = (read: () => Typers) => {
  let held: Typers | null = null
  return () => {
    const next = read()
    if (
      held === null ||
      held.server !== next.server ||
      !sameList(held.names, next.names) ||
      !sameList(held.ask, next.ask)
    )
      held = next
    return held
  }
}

// What the screen around a composer gives Send later.
export interface LaterUi {
  // Opens the date and time picker.
  pick: () => void
  // Something is being added to the draft that Send later cannot take.
  busy: boolean
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

// Where a forwarded copy goes when it is sent from a list.
export interface ForwardTo {
  // What the choice to name the source and the send under way go by.
  key: string
  destination: ForwardDestination
  // Only text can be written there.
  textOnly: boolean
}

// A file held with a draft until it is sent.
export interface DraftFile {
  id: string
  file: File
  spoiler: boolean
  // "Describe this image", as typed.
  alt: string
  // Which way it goes where there are two; `switchable` while the other way is open to it.
  mode: { now: UploadMode; switchable: boolean } | null
  // What stands under its name: nothing, its size once ready, how far it is prepared (0..1), or
  // why it cannot be sent.
  status:
    | { kind: 'ready'; bytes: number }
    | { kind: 'preparing'; done: number }
    | { kind: 'failed'; why: string }
    | null
}

export interface FilesState {
  // How many files a draft takes at a time; null where none can be added.
  add: 'one' | 'many' | null
  held: DraftFile[]
  // Held files cannot be sent here.
  stuck: boolean
  // Every file goes peer-to-peer.
  peer: boolean
}

const NO_FILES: DraftFile[] = []

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
  // Sends the draft as written. When a held file needs its storage time chosen first, nothing is
  // sent and `askKeep` is called: `sendKept` then sends it.
  send: (askKeep: () => void) => void
  sendKept: (seconds: number | null, relay: RelayChoice) => void
  later: Live<LaterState>
  fetchLater: () => void
  // Schedules the draft as written for `at`; null, or why it was refused.
  scheduleAt: (at: number) => Promise<string | null>
  // The draft as Send later reads it when one of its rows runs.
  laterDraft: (ui: LaterUi) => ComposerDraft | null
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
  typers: Live<Typers>
  files: Live<FilesState>
  // Adds files to the draft, as many as it takes.
  attach: (files: File[]) => void
  // Takes the files of a paste; false when none of them were taken.
  paste: (files: File[]) => boolean
  detach: (id: string) => void
  describe: (id: string, alt: string) => void
  toggleSpoiler: (id: string) => void
  toggleMode: (id: string) => void
  // A small picture of a held file, where the place made one.
  thumbOf: (id: string) => Promise<string | null>
  // Where a forward sent from this list goes; null with nothing to write to.
  forwardTo: Live<ForwardTo | null>
  // Says that a forward went out to what the screen calls `title`.
  forwarded: (title: string) => void
  // Sends the message on the forward clipboard here. `showSource`: whether the copy names where
  // it is from (null: the place decides). True once the copy went out.
  forward: (showSource: boolean | null) => Promise<boolean>
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
    // The channel the list writes to; null in a DM.
    const channelOf = (s: ReturnType<typeof store.getState>) =>
      list === 'thread'
        ? s.panel?.kind === 'thread'
          ? s.panel.root.channel_id
          : null
        : s.view?.kind === 'channel'
          ? s.view.channelId
          : null
    const toOf = (initial: boolean) =>
      keptTo((): WriteTo => {
        const s = initial ? store.getInitialState() : store.getState()
        const v = s.view
        if (list === 'thread') return { what: { kind: 'thread' }, own: false, hidden: null }
        if (v?.kind === 'channel') {
          const creator =
            s.me?.servers.find(x => x.name === v.server)?.creator ?? s.servers[v.server]?.creator
          const name = s.servers[v.server]?.channels.find(c => c.id === v.channelId)?.name ?? ''
          return {
            what: { kind: 'channel', name },
            own: !!s.me && creator === s.me.username,
            hidden: null,
          }
        }
        const dm = v?.kind === 'dm' ? s.dms.find(d => d.id === v.dmId) : undefined
        return {
          what: dm ? { kind: 'person', handle: `@${dm.other.username}` } : null,
          own: dm?.is_self === true,
          hidden: 'Send a direct message',
        }
      })
    const state = (initial: boolean) => {
      const to = toOf(initial)
      return built(
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
            channelOf(s) === null ? 0 : (s.slowUntil[channelOf(s) as number] ?? 0),
            textOnlyDestination(s, key) ||
            !(s.view?.kind !== 'channel' || channelCan(s, s.view.server, channelOf(s)).polls)
              ? null
              : list === 'thread'
                ? s.panel?.kind === 'thread'
                  ? s.panel.root.id
                  : null
                : s.view?.kind === 'channel'
                  ? s.view.channelId
                  : s.view?.kind === 'dm'
                    ? s.view.dmId
                    : null,
            list === 'thread' ? 'thread' : s.view?.kind === 'dm' ? 'dm' : 'channel',
            to(),
            list === 'main' && s.view?.kind === 'channel' && messageFilterOn(s.settings),
          ] as const
        },
        ([
          key,
          text,
          max,
          reply,
          server,
          me,
          focus,
          slowUntil,
          poll,
          pollKind,
          to,
          filtered,
        ]): ComposeState => ({
          poll: poll === null ? null : { kind: pollKind, id: poll },
          to,
          listKey: key,
          filtered,
          peer: false,
          key,
          text,
          max,
          focus,
          slowUntil,
          replying: reply
            ? {
                to: { kind: 'account', user: reply.message.author, server },
                mention: reply.message.author.username === me ? null : reply.mention,
              }
            : null,
        })
      )
    }
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
    const files = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const key = keyOf(initial)
          const v = s.view
          const server = v?.kind === 'channel' ? v.server : null
          const channel =
            list === 'thread'
              ? s.panel?.kind === 'thread'
                ? s.panel.root.channel_id
                : null
              : v?.kind === 'channel'
                ? v.channelId
                : null
          return [
            key === null ? undefined : s.pending[key],
            textOnlyDestination(s, key),
            s.settings.asset_uploads,
            s.settings.p2p_attachments,
            limitsOf(s.instance).upload_bytes,
            server === null || channelCan(s, server, channel).attach,
          ] as const
        },
        ([pending, textOnly, uploads, p2p, max, may]): FilesState => ({
          add: !textOnly && (uploads || p2p) && may ? 'one' : null,
          held:
            pending && !textOnly
              ? [
                  {
                    id: 'file',
                    file: pending.file,
                    spoiler: pending.spoiler,
                    alt: pending.alt ?? '',
                    mode: {
                      now: pending.mode,
                      switchable: uploads && p2p && pending.file.size <= max,
                    },
                    status: null,
                  },
                ]
              : NO_FILES,
          stuck: false,
          peer: false,
        })
      )
    const getFiles = files(false)
    const onKey = (run: (key: string) => void) => {
      const { key } = get()
      if (key !== null) run(key)
    }
    const post = (keep?: number | null, relay?: RelayChoice) => {
      const s = store.getState()
      const { key, text } = get()
      if (key === null) return
      const sent = outgoing(s.linkPrefs, text)
      if (list === 'thread') s.sendThreadMessage(sent, keep, relay)
      else s.sendMessage(sent, keep, relay)
      store.getState().setDraft(key, '')
    }
    const later = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const key = keyOf(initial)
          return [
            s.scheduled.items,
            limitsOf(s.instance).message_chars,
            s.settings.scheduled_messages ||
              !!(s.scheduled.counts?.waiting || s.scheduled.counts?.failed),
            key,
          ] as const
        },
        ([items, max, fetched, key]): LaterState => ({
          side: 'hosted',
          items: Object.values(items),
          ops: {
            side: 'hosted',
            max,
            edit: (k, body) => store.getState().editScheduled(k, body),
            removeReply: k => store.getState().removeScheduledReply(k),
            reschedule: (k, at) => store.getState().rescheduleScheduled(k, at),
            sendNow: k => store.getState().sendScheduledNow(k),
            resume: k => store.getState().resumeScheduled(k),
            remove: k => store.getState().deleteScheduled(k),
          },
          fetched,
          notice: key === null ? null : (`scheduled:${key}` as const),
        })
      )
    const scheduleAt = async (at: number): Promise<string | null> => {
      const st = store.getState()
      const { key, text } = get()
      if (key === null) return null
      const links = (t: string) => outgoing(store.getState().linkPrefs, t)
      const go = () =>
        void st.scheduleDraft(key, at, links).then(e => {
          if (e) store.getState().showToast(e)
        })
      if (hasInviteCode(text)) {
        st.askConfirm({
          title: 'Post Invite Code',
          body: INVITE_POST_TEXT,
          confirm: 'Schedule',
          action: account.lifetime.inSession(go),
        })
        return null
      }
      return st.scheduleDraft(key, at, links)
    }
    const forwardTo = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const key = keyOf(initial)
          return [
            key,
            key === null ? null : instanceServer(s, key),
            textOnlyDestination(s, key),
          ] as const
        },
        ([key, server, textOnly]): ForwardTo | null =>
          key === null ? null : { key, destination: { kind: 'instance', server }, textOnly }
      )
    const typers = (initial: boolean) =>
      keptTypers(() => {
        const s = initial ? store.getInitialState() : store.getState()
        const key = keyOf(initial)
        const server = s.view?.kind === 'channel' ? s.view.server : null
        const found =
          key === null || !s.typingOn ? null : shownTypers(s, server, s.typing[key], s.blocked)
        return { names: found?.names ?? [], ask: found?.ask ?? [], server }
      })
    return {
      typers: {
        get: typers(false),
        initial: typers(true),
        subscribe: changed => store.subscribe(changed),
      },
      files: {
        get: getFiles,
        initial: files(true),
        subscribe: changed => store.subscribe(changed),
      },
      attach: added => {
        const file = added[0]
        if (file) onKey(key => store.getState().uploadFile(key, file))
      },
      paste: pasted => {
        const image = pasted.find(f => f.type.startsWith('image/'))
        if (!image || getFiles().add === null) return false
        onKey(key => store.getState().uploadFile(key, namePasted(image)))
        return true
      },
      detach: () => onKey(key => store.getState().uploadFile(key, null)),
      describe: (_, alt) => onKey(key => store.getState().setUploadAlt(key, alt)),
      toggleSpoiler: () => onKey(key => store.getState().toggleSpoiler(key)),
      toggleMode: () => onKey(key => store.getState().toggleUploadMode(key)),
      thumbOf: async () => null,
      forwardTo: {
        get: forwardTo(false),
        initial: forwardTo(true),
        subscribe: changed => store.subscribe(changed),
      },
      forwarded: () => {},
      forward: async showSource => {
        const { key } = get()
        if (key !== null) store.getState().sendForward(key, showSource ?? undefined)
        return false
      },
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
      send: askKeep => {
        const s = store.getState()
        const { key, text, max, replying, slowUntil } = get()
        const pending = getFiles().held.length && key !== null ? s.pending[key] : undefined
        if (key === null || (!text.trim() && !pending)) return
        if (charCount(text) > max || altError(pending?.alt ?? '')) return
        const sed = pending ? null : parseSed(text)
        if (sed) {
          void s.sedEdit(key, sed).then(
            account.lifetime.inSession(ok => {
              if (ok && get().text === text) store.getState().setDraft(key, '')
            })
          )
          return
        }
        const forwarding = s.forwardClip !== null && clipAllowed(s, s.forwardClip, account)
        if (
          list === 'main' &&
          !pending &&
          !replying &&
          !forwarding &&
          s.view?.kind === 'channel' &&
          previewFor(account).dispatchPreviewText(text)
        ) {
          s.setDraft(key, '')
          return
        }
        if (slowUntil > account.time.now()) return
        const go = () => (pending?.mode === 'p2p' ? askKeep() : post())
        // A P2P server invite code posted here can be read by the instance.
        if (hasInviteCode(text))
          return s.askConfirm({
            title: 'Post Invite Code',
            body: INVITE_POST_TEXT,
            confirm: 'Post',
            action: account.lifetime.inSession(go),
          })
        go()
      },
      sendKept: (seconds, relay) => post(seconds, relay),
      later: {
        get: later(false),
        initial: later(true),
        subscribe: changed => store.subscribe(changed),
      },
      fetchLater: () => {
        const { key } = get()
        if (key !== null) void store.getState().loadScheduled(key)
      },
      scheduleAt,
      laterDraft: ui => {
        const st = store.getState()
        const { key, text, max } = get()
        if (key === null) return null
        const reply = st.replying[key]
        return {
          side: 'hosted',
          place: key,
          text,
          reply: reply ? { id: String(reply.message.id), mention: reply.mention } : null,
          blocked: laterBlocked({
            text,
            rich: !!st.pending[key] || st.forwardClip !== null || ui.busy,
            tooLong: charCount(text) > max,
            on: st.settings.scheduled_messages,
            cap: limitsOf(st.instance).scheduled_per_account,
            waiting: st.scheduled.counts?.waiting ?? 0,
          }),
          schedule: async at => {
            await scheduleAt(at)
          },
          pick: ui.pick,
        }
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
        const s = store.getState()
        const server = s.view?.kind === 'channel' ? s.view.server : null
        if (server !== null && !channelCan(s, server, channelOf(s)).send) return false
        return key !== null && s.editLast(key)
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
    const toOf = (initial: boolean) =>
      keptTo((): WriteTo => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        const hidden = 'Send a P2P message'
        if (list === 'thread') return { what: { kind: 'thread' }, own: false, hidden }
        if (place.kind === 'p2pRoom') {
          const v = s.servers[room]
          const ch = s.chat?.room === room ? s.chat.ch : null
          const name = v?.channels.find(c => c.id === ch)?.name ?? ''
          return {
            what: { kind: 'channel', name },
            own: ownsP2pServer(v, s.me),
            hidden,
          }
        }
        const peerIk = s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer
        const contact = s.contacts.find(c => c.ik === peerIk)
        return {
          what: { kind: 'person', handle: contact ? displayName(contact) : 'Contact' },
          own: false,
          hidden,
        }
      })
    const scopeOf = (initial: boolean) => {
      const s = initial ? useP2p.getInitialState() : useP2p.getState()
      if (list === 'thread')
        return s.thread?.room === room ? identityScopeKey(app.localId, threadScope(s.thread)) : null
      return s.chat?.room === room
        ? identityScopeKey(app.localId, chatScope(room, s.chat.ch ?? null))
        : null
    }
    const state = (initial: boolean) => {
      const to = toOf(initial)
      return built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const key = keyOf(initial)
          return [
            key,
            key === null ? '' : (s.drafts[key] ?? ''),
            key !== null && s.replying?.room === key ? s.replying.id : null,
            initial && shown.initial ? shown.initial() : shown.get(),
            key !== null && s.composerFocus?.key === key ? s.composerFocus.n : 0,
            // A thread's replies count in its channel's slow mode.
            key === null ? 0 : (s.slowUntil[key.split('#')[0]] ?? 0),
            to(),
            scopeOf(initial),
          ] as const
        },
        ([key, text, id, rows, focus, slowUntil, to, listKey]): ComposeState => {
          const answered = id === null ? undefined : rows.message(id)
          return {
            key,
            text,
            focus,
            slowUntil,
            poll: null,
            to,
            listKey,
            filtered: false,
            peer: true,
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
    }
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
    const files = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const { store } = place.account
          const site = (initial ? store.getInitialState() : store.getState()).settings
          const key = keyOf(initial)
          const ch = (list === 'thread' ? s.thread?.ch : s.chat?.ch) ?? null
          const v = place.kind === 'p2pRoom' ? s.servers[room] : undefined
          const mask = v && ch !== null ? p2pMask(v, ch) : null
          return [
            key === null ? undefined : s.attaching[key],
            (v && ch !== null && v.channels.find(c => c.id === ch)?.text_only === true) ||
              !(mask === null || canOf(mask).attach),
            !site.asset_uploads && !site.p2p_attachments,
          ] as const
        },
        ([attaching, noFiles, siteTextOnly]): FilesState => ({
          add: noFiles || siteTextOnly ? null : 'many',
          held: attaching?.length
            ? attaching.map(p => ({
                id: String(p.id),
                file: p.file,
                spoiler: p.spoiler,
                alt: p.alt ?? '',
                mode: null,
                status: p.error
                  ? { kind: 'failed', why: p.error }
                  : p.hashed !== null && p.preview !== null
                    ? { kind: 'ready', bytes: p.file.size }
                    : { kind: 'preparing', done: p.progress },
              }))
            : NO_FILES,
          stuck: noFiles && !!attaching?.length,
          peer: true,
        })
      )
    const getFiles = files(false)
    const onFile = (id: string, run: (key: string, id: number) => void) => {
      const { key } = get()
      if (key !== null) run(key, Number(id))
    }
    const forwardTo = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const key = keyOf(initial)
          const at = list === 'thread' ? s.thread : s.chat
          const ch = at?.ch ?? null
          return [
            key,
            key === null || !at
              ? null
              : identityScopeKey(
                  app.localId,
                  list === 'thread' && s.thread ? threadScope(s.thread) : chatScope(room, ch)
                ),
            ch !== null && s.servers[room]?.channels.find(c => c.id === ch)?.text_only === true,
          ] as const
        },
        ([key, scope, textOnly]): ForwardTo | null =>
          key === null || scope === null
            ? null
            : { key: scope, destination: p2pDestination(key), textOnly }
      )
    const deviceOps: ScheduledOps = {
      side: 'device',
      max: P2P_LIMITS.body,
      edit: (k, body) => app.p2pScheduled.edit(k, body),
      removeReply: k => app.p2pScheduled.removeReply(k),
      reschedule: (k, at) => app.p2pScheduled.reschedule(k, at),
      sendNow: k => app.p2pScheduled.sendNow(k),
      resume: () => app.p2pScheduled.resume(),
      remove: k => app.p2pScheduled.remove(k),
    }
    const later = (initial: boolean) =>
      built(
        () => [(initial ? useP2p.getInitialState() : useP2p.getState()).scheduled] as const,
        ([items]): LaterState => ({
          side: 'device',
          items,
          ops: deviceOps,
          fetched: false,
          notice: null,
        })
      )
    const scheduleAt = async (at: number) => {
      const st = useP2p.getState()
      const { key, text } = get()
      if (key === null) return null
      const reply = st.replying?.room === key ? st.replying.id : undefined
      const body = outgoing(place.account.store.getState().linkPrefs, text)
      return app.p2pScheduled.add(key, { body, reply, at, draft: text })
    }
    // When each key last said it is typing; the place wants to hear it again only so often.
    const said = new Map<string, number>()
    const typers = (initial: boolean) =>
      keptTypers(() => {
        const s = initial ? useP2p.getInitialState() : useP2p.getState()
        const key = keyOf(initial)
        if (key === null) return { names: [], ask: [], server: null }
        if (place.kind === 'p2pRoom')
          return {
            names: (s.serverTyping[key] ?? []).map(ik => app.memberName(room, ik)),
            ask: [],
            server: null,
          }
        const peerIk = s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer
        const contact = s.contacts.find(c => c.ik === peerIk)
        return {
          names: (s.typing[key] ?? [])
            .filter(ik => ik === peerIk)
            .map(() => (contact ? displayName(contact) : 'Contact')),
          ask: [],
          server: null,
        }
      })
    return {
      typers: {
        get: typers(false),
        initial: typers(true),
        subscribe: changed => useP2p.subscribe(changed),
      },
      files: {
        get: getFiles,
        initial: files(true),
        subscribe: changed => {
          const stops = [useP2p.subscribe(changed), place.account.store.subscribe(changed)]
          return () => stops.forEach(stop => stop())
        },
      },
      attach: added => {
        const { key } = get()
        if (key !== null && added.length) app.p2pFiles.add(key, added)
      },
      paste: pasted => {
        const { key } = get()
        if (key === null || !pasted.length || getFiles().add === null) return false
        app.p2pFiles.add(
          key,
          pasted.map(f => (f.name && f.name !== 'image.png' ? f : namePasted(f)))
        )
        return true
      },
      detach: id => onFile(id, (key, n) => app.p2pFiles.remove(key, n)),
      describe: (id, alt) => onFile(id, (key, n) => app.p2pFiles.setAlt(key, n, alt)),
      toggleSpoiler: id => onFile(id, (key, n) => app.p2pFiles.toggleSpoiler(key, n)),
      toggleMode: () => {},
      thumbOf: async id => {
        const { key } = get()
        const s = useP2p.getState()
        const held = key === null ? undefined : s.attaching[key]?.find(p => String(p.id) === id)
        return held?.preview?.thumb ? app.p2pFiles.thumb(held.preview.thumb) : null
      },
      forwardTo: {
        get: forwardTo(false),
        initial: forwardTo(true),
        subscribe: changed => useP2p.subscribe(changed),
      },
      forwarded: title => app.p2pHost.toast('Forwarded to', title),
      forward: async showSource => {
        const { key } = get()
        const { store } = place.account
        const s = store.getState()
        const clip = s.forwardClip
        if (key === null || !clip || !clipAllowed(s, clip, place.account)) return false
        const names = clipSourceNames(place.account, clip)
        const sent = await p2pDm.forward(
          key,
          p2pForward(clip, fwdSource(clip.source, names, showSource ?? false))
        )
        if (sent && store.getState().forwardClip === clip) store.getState().clearForward()
        return !!sent
      },
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
      send: () => {
        const { key, text, max, slowUntil } = get()
        const { held, stuck } = getFiles()
        if (key === null || stuck || (!text.trim() && !held.length)) return
        if (charCount(text) > max || bodyTooLong(text)) return
        if (slowUntil > app.owner.time.now()) return
        void p2pDm.send(key, outgoing(place.account.store.getState().linkPrefs, text)).then(ok => {
          if (ok && get().text === text) p2pDm.setDraft(key, '')
        })
        if (said.delete(key)) p2pDm.typing(key, false)
      },
      sendKept: () => {},
      later: {
        get: later(false),
        initial: later(true),
        subscribe: changed => useP2p.subscribe(changed),
      },
      fetchLater: () => {},
      scheduleAt,
      laterDraft: ui => {
        const st = useP2p.getState()
        const { key, text, max } = get()
        if (key === null) return null
        const reply = st.replying?.room === key ? st.replying.id : null
        return {
          side: 'device',
          place: key,
          text,
          reply: reply ? { id: reply, mention: true } : null,
          blocked: laterBlocked({
            text,
            rich:
              (st.attaching[key]?.length ?? 0) > 0 ||
              place.account.store.getState().forwardClip !== null ||
              ui.busy,
            tooLong: charCount(text) > max || bodyTooLong(text),
            on: app.p2pScheduled.here(),
            cap: 0,
            waiting: 0,
          }),
          schedule: async at => {
            const e = await scheduleAt(at)
            if (e) app.p2pHost.toast(e)
          },
          pick: ui.pick,
        }
      },
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
