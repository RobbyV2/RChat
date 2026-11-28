import type { AccountSession } from '../client/session'
import { CAN_ALL, canOf, p2pMask, type ChannelCan } from '../channel_perms'
import { time } from '../platform/time'
import { canForward } from '../forward'
import { guestPostingStatus } from '../guest_chat'
import { outranksKnown } from '../hierarchy'
import { mentionsUser } from '../mentions'
import { displayName } from '../p2p/contacts'
import { messageActs, type P2pMessage } from '../p2p/dm'
import { canPin } from '../pins'
import { canQuote, repliesToMe } from '../replies'
import { canEdit as ownEditable } from '../sed'
import {
  byUsername,
  channelCan,
  groupMentionsMe,
  messageServer,
  myRank,
  myTimeoutEnds,
  outranksMember,
} from '../selectors'
import { maskOf } from '../store'
import type { RChatState } from '../store_types'
import type { Message } from '../types'
import { composer, type ComposerList, type GateState } from './composer'
import { defineFeature, featureAt, isUnsupported } from './feature'
import { built, type Live } from './live'
import { P2pDm, P2pRoom } from './place'
import { shownOf } from './shown'

// What the row of one message may do and how it stands, whichever place lists it.
export interface RowFlags {
  // The message's key in a place that keys its messages itself.
  event?: string
  // The server whose looks the row draws by; null where there is none.
  server: string | null
  // Kept on this device.
  local?: boolean
  mentioned: boolean
  canEdit: boolean
  canReply: boolean
  canForward: boolean
  // What the thread action is called; null without one.
  thread: string | null
  chip?: boolean
  canDelete: boolean
  canTrim?: boolean
  canReact: boolean
  canUnreact: boolean
  canVote?: boolean
  // Whether the reader may pin the message, or unpin it once pinned.
  canPin: boolean
  // Whether the files the place keeps with the message can be fetched.
  canFetch?: boolean
  sent?: 'failed' | 'pending' | 'delivered'
  sentTip?: string
  canRetry?: boolean
  canDrop?: boolean
  lateAt?: number
  // Hidden from the reader: removed, or held back by slow mode.
  hidden?: 'removed' | 'slow'
  // The pinned message's key, on a pin's line.
  pinned?: string | null
}

// Where a row stands when its flags are asked.
export interface RowAt {
  // A timeout of the reader runs now.
  timedOut: boolean
  // The row heads the open thread.
  root?: boolean
}

export interface RowsState {
  // When a timeout of the reader here ends (ms); null without one.
  until: number | null
  // Whether the reader may act on the rows at all, a timeout aside.
  acts: boolean
  // Whether the reader may change the pins of the list, a timeout aside.
  pins: boolean
  of: (m: Message, at: RowAt) => RowFlags
}

export interface Rows {
  at: (list: ComposerList) => Live<RowsState>
}

// Forwarded text is a copy of someone else's words: its mentions never highlight or ping.
export const mentionsMe = (m: Message, me: string | undefined) =>
  me !== undefined &&
  m.author.username !== me &&
  ((!m.forward && mentionsUser(m.content, me)) || repliesToMe(m, me))

const perList = (make: (list: ComposerList) => Live<RowsState>): Rows => {
  const made = new Map<ComposerList, Live<RowsState>>()
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

const signedIn = (s: RChatState) => s.me !== null && !s.guest

// Quoting, and opening threads: in a channel or a DM (`dm`), where threads need an account.
export function replyAccess(
  s: RChatState,
  server: string | null,
  channelId: number | null,
  canWrite: boolean,
  dm = false
) {
  const guestWrites = guestPostingStatus(s, server, channelId) === 'ready'
  return {
    quote: canWrite || guestWrites,
    thread: dm ? signedIn(s) : channelId !== null && (signedIn(s) || guestWrites),
  }
}

// Pinning and unpinning: either DM participant, or a member with Pin messages in the channel. A
// thread never pins.
const hostedPins = (
  signed: boolean,
  thread: boolean,
  inDm: boolean,
  member: boolean,
  can: ChannelCan
) => signed && !thread && (inDm || (member && can.pin && can.send))

// Where a hosted message is listed, and what the reader holds there.
interface HostedWhere {
  server: string | null
  channel: number | null
  inDm: boolean
  // The list is a thread; `rootId` heads it.
  thread: boolean
  rootId: number | null
  // The reader is a member of `server`, or the conversation takes their messages.
  acts: boolean
  // The reader may change the list's pins, a timeout aside.
  pins: boolean
  can: ChannelCan
  outranks: (username: string) => boolean
}

const hostedFlags = (s: RChatState, m: Message, w: HostedWhere, timedOut: boolean): RowFlags => {
  const me = s.me
  const signed = signedIn(s)
  const { server, channel, thread, can } = w
  const acting = w.acts && (w.inDm || !timedOut)
  const canWrite = acting && can.send
  const access = replyAccess(s, server, channel, canWrite, w.inDm)
  const canDelete =
    signed && me !== null && (m.author.username === me.username || w.outranks(m.author.username))
  const member = server !== null && w.acts
  return {
    server,
    mentioned: mentionsMe(m, me?.username) || (!thread && groupMentionsMe(s, m)),
    canEdit: canWrite && ownEditable(m, me?.username),
    canReply: access.quote && canQuote(m),
    canForward: signed && canForward(m),
    thread:
      !thread && canQuote(m) && access.thread && (m.reply_count > 0 || !member || can.threads)
        ? 'Reply in thread'
        : null,
    chip: !thread,
    canDelete: canDelete && !(thread && m.id === w.rootId),
    canTrim: canDelete,
    canReact: acting && can.react,
    canUnreact: signed,
    canVote: canWrite,
    canPin: w.pins && !timedOut && canPin(m),
  }
}

// What the reader may do to a hosted message of `list` (a list key), wherever it shows: the
// flags its row has.
export const messageFlags = (
  s: RChatState,
  m: Message,
  list: string,
  now = time().now()
): RowFlags => {
  const thread = list.startsWith('t')
  const inDm = list.startsWith('d') || m.dm_id !== null
  const server = inDm ? null : messageServer(s, m)
  const dm = thread && m.dm_id !== null ? s.dms.find(d => d.id === m.dm_id) : undefined
  const member = server !== null && !!s.me?.servers.some(x => x.name === server)
  const can = channelCan(s, server, m.channel_id)
  return hostedFlags(
    s,
    m,
    {
      server,
      channel: m.channel_id,
      inDm,
      thread,
      rootId: thread ? Number(list.slice(1)) : null,
      acts: signedIn(s) && (inDm ? !(dm && s.blocked[dm.other.username]) : member),
      pins: hostedPins(signedIn(s), thread, inDm, member, can),
      can,
      outranks: username => server !== null && can.manage && outranksMember(s, server, username),
    },
    myTimeoutEnds(s, server, now) !== null
  )
}

const hosted = (account: AccountSession): Rows =>
  perList(list => {
    const { store } = account
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? store.getInitialState() : store.getState()
          const v = s.view
          const server = v?.kind === 'channel' ? v.server : null
          const root = list === 'thread' && s.panel?.kind === 'thread' ? s.panel.root : null
          return [
            s.me,
            s.guest,
            v,
            root?.id ?? null,
            root?.channel_id ?? null,
            root?.dm_id ?? null,
            server === null ? undefined : s.servers[server],
            server === null ? undefined : s.members[server]?.list,
            server === null ? undefined : s.memberInfo[server],
            s.blocked,
            s.dms,
            s.settings,
          ] as const
        },
        ([
          me,
          guest,
          v,
          rootId,
          rootChannel,
          rootDm,
          detail,
          members,
          known,
          blocked,
          dms,
        ]): RowsState => {
          const server = v?.kind === 'channel' ? v.server : null
          const mine = server === null ? undefined : me?.servers.find(x => x.name === server)
          const until =
            mine?.timed_out_until === undefined || mine.timed_out_until === null
              ? null
              : mine.timed_out_until * 1000
          const signed = me !== null && !guest
          const thread = list === 'thread'
          const inDm = thread ? rootDm !== null : v?.kind === 'dm'
          const dm = thread && rootDm !== null ? dms.find(d => d.id === rootDm) : undefined
          const shutDm = !!dm && !!blocked[dm.other.username]
          const channel = thread ? rootChannel : v?.kind === 'channel' ? v.channelId : null
          const s = initial ? store.getInitialState() : store.getState()
          const can = channelCan(s, server, channel)
          const rank = server === null ? undefined : myRank(s, server)
          const listed = members ? byUsername(members) : undefined
          const memberFor = (username: string) =>
            listed?.get(username) ??
            (known && Object.hasOwn(known, username) ? (known[username] ?? undefined) : undefined)
          const here = thread ? rootId !== null : v !== null
          const acts =
            signed &&
            here &&
            (inDm ? !shutDm : server !== null && mine !== undefined) &&
            (thread || v?.kind === 'dm' || v?.kind === 'channel')
          const pins = hostedPins(signed, thread, inDm, mine !== undefined, can)
          const where: HostedWhere = {
            server,
            channel,
            inDm,
            thread,
            rootId,
            acts,
            pins,
            can,
            outranks: username =>
              (thread || v?.kind === 'channel') &&
              can.manage &&
              outranksKnown(rank, memberFor(username), detail?.roles),
          }
          return {
            until,
            acts,
            pins,
            of: (m, at) =>
              hostedFlags(
                initial ? store.getInitialState() : store.getState(),
                m,
                where,
                at.timedOut
              ),
          }
        }
      )
    return {
      get: state(false),
      initial: state(true),
      subscribe: changed => store.subscribe(changed),
    }
  })

// What a gate leaves the reader to do with rows: everything, a timeout and an unstarted thread
// aside.
const actsUnder = ({ first, then }: GateState) =>
  first === null && (then === null || then.kind === 'noThreads')

// Where a P2P message is listed, and what the reader holds there.
export interface PeerWhere {
  me: string | null
  // Whether the reader may act on the list's rows at all, a timeout aside.
  acts: boolean
  held: ChannelCan
  // A room's list (its moderators delete, its channel says who pins); else a conversation's.
  room: boolean
  thread: boolean
  sentTip?: string
}

const NOT_STORED: RowFlags = {
  server: null,
  local: true,
  mentioned: false,
  canEdit: false,
  canReply: false,
  canForward: false,
  thread: null,
  canDelete: false,
  canReact: false,
  canUnreact: false,
  canPin: false,
}

// What the reader may do to a stored P2P message: the flags its row has.
export const peerFlags = (p: P2pMessage, w: PeerWhere, at: RowAt): RowFlags => {
  const { me, held } = w
  const mine = p.sender === me
  // From the old copy: read-only here.
  const act = w.acts && !p.archived
  const write = act && !at.timedOut
  const can = messageActs(p, write, mine)
  return {
    event: p.id,
    server: null,
    local: true,
    mentioned:
      !mine &&
      ((me !== null && p.mentions.includes(me)) || p.reply?.sender === me || p.everyone === true),
    canEdit: can.edit,
    canReply: can.reply,
    canForward: can.forward,
    thread: w.thread ? null : threadAct(p, write && held.threads),
    chip: !w.thread && !p.archived,
    canDelete: act && !at.root && (mine || (w.room && held.manage && !at.timedOut)),
    canReact: write && held.react,
    canUnreact: write,
    canPin: write && !w.thread && !p.thread && (!w.room || held.pin),
    canFetch: w.acts && (w.thread || !p.archived),
    sent: mine ? (p.failed ? 'failed' : p.pending ? 'pending' : 'delivered') : undefined,
    sentTip: w.sentTip,
    canRetry: w.acts && !at.timedOut,
    canDrop: w.acts,
    lateAt: p.late ? p.sentTs : undefined,
    hidden: p.removed ? 'removed' : p.slowHidden ? 'slow' : undefined,
    pinned: p.system?.target ?? null,
  }
}

// What starting or opening the thread of a stored message is called; null when it offers none.
export const threadAct = (p: P2pMessage, canAct: boolean) =>
  p.system || p.call || p.thread || p.noThread || p.archived
    ? null
    : p.replies
      ? 'View thread'
      : canAct && !p.unavailable
        ? 'Create thread'
        : null

const peer = (place: P2pRoom | P2pDm): Rows =>
  perList(list => {
    const { app, room, account } = place
    const { useP2p } = app
    const here =
      place.kind === 'p2pRoom' ? P2pRoom.open(app, room, list) : P2pDm.open(app, room, list)
    const shown = shownOf(here)
    const composing = featureAt(composer, place)
    const gate = isUnsupported(composing) ? null : composing.at(list).gate
    const state = (initial: boolean) =>
      built(
        () => {
          const s = initial ? useP2p.getInitialState() : useP2p.getState()
          const site = initial ? account.store.getInitialState() : account.store.getState()
          const v = place.kind === 'p2pRoom' ? s.servers[room] : undefined
          const ch = (list === 'thread' ? s.thread?.ch : s.chat?.ch) ?? null
          const peerIk = s.chat?.room === room ? s.chat.peer : s.rooms[room]?.peer
          return [
            s.me,
            gate === null ? null : initial && gate.initial ? gate.initial() : gate.get(),
            v && ch !== null ? p2pMask(v, ch) : null,
            v?.timedOutUntil ?? null,
            s.reader || s.elsewhere || s.status === 'moved',
            place.kind === 'p2pDm' ? s.contacts.find(c => c.ik === peerIk) : undefined,
            place.kind === 'p2pDm' && list === 'main' && s.rooms[room]?.peerFull === true,
            maskOf(site),
            initial && shown.initial ? shown.initial() : shown.get(),
          ] as const
        },
        ([me, gated, mask, until, away, contact, peerFull, masked, rows]): RowsState => {
          const held = mask === null ? CAN_ALL : canOf(mask)
          const acts =
            place.kind === 'p2pRoom'
              ? gated !== null && actsUnder(gated)
              : list === 'main'
                ? !away && contact?.state === 'mutual'
                : gated !== null && gated.first === null && gated.then === null
          const sentTip =
            place.kind === 'p2pRoom'
              ? 'Waiting for a member to come online'
              : peerFull
                ? 'Their storage is full'
                : `Waiting for ${masked(contact ? displayName(contact) : 'Contact')} to come online`
          const facts: PeerWhere = {
            me,
            acts,
            held,
            room: place.kind === 'p2pRoom',
            thread: list === 'thread',
            sentTip,
          }
          return {
            until,
            acts,
            pins: acts && list === 'main' && (place.kind === 'p2pDm' || held.pin),
            of: (m, at) => {
              const id = rows.idOf(m.id)
              const p = id === null ? undefined : rows.message(id)
              return p ? peerFlags(p, facts, at) : NOT_STORED
            },
          }
        }
      )
    return {
      get: state(false),
      initial: state(true),
      subscribe: changed => {
        const stops = [useP2p.subscribe(changed), account.store.subscribe(changed)]
        return () => stops.forEach(stop => stop())
      },
    }
  })

// What the rows of a place's lists may do, the same computation for the conversation and its
// open thread.
export const rows = defineFeature<Rows>('rows', {
  hostedServer: place => hosted(place.account),
  p2pRoom: peer,
  hostedDm: place => hosted(place.account),
  p2pDm: peer,
})

const own = new WeakMap<AccountSession, Rows>()

// The account's own rows, for a list shown with no place around it.
export const accountRows = (account: AccountSession): Rows => {
  let known = own.get(account)
  if (!known) {
    known = hosted(account)
    own.set(account, known)
  }
  return known
}
