import { replyAccess } from '../actions/message'
import { threadAct } from '../actions/p2p_chat'
import type { AccountSession } from '../client/session'
import { CAN_ALL, canOf, p2pMask } from '../channel_perms'
import { canForward } from '../forward'
import { outranksKnown } from '../hierarchy'
import { mentionsUser } from '../mentions'
import { displayName } from '../p2p/contacts'
import { messageActs } from '../p2p/dm'
import { canQuote, repliesToMe } from '../replies'
import { canEdit as ownEditable } from '../sed'
import { byUsername, channelCan, groupMentionsMe, myRank } from '../selectors'
import { maskOf } from '../store'
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
          const moderates = (m: Message) =>
            (thread || v?.kind === 'channel') &&
            can.manage &&
            outranksKnown(rank, memberFor(m.author.username), detail?.roles)
          return {
            until,
            acts,
            of: (m, at) => {
              const s = initial ? store.getInitialState() : store.getState()
              const acting = acts && (inDm || !at.timedOut)
              const canWrite = acting && can.send
              const access = replyAccess(s, server, channel, canWrite, inDm)
              const canDelete = me !== null && (m.author.username === me.username || moderates(m))
              return {
                server,
                mentioned: mentionsMe(m, me?.username) || (!thread && groupMentionsMe(s, m)),
                canEdit: canWrite && ownEditable(m, me?.username),
                canReply: thread ? access.quote && canQuote(m) : access.quote,
                canForward: signed && canForward(m),
                thread: !thread && access.thread ? 'Reply in thread' : null,
                chip: !thread,
                canDelete: canDelete && !(thread && m.id === rootId),
                canTrim: canDelete,
                canReact: acting && can.react,
                canUnreact: signed,
                canVote: canWrite,
              }
            },
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
          return {
            until,
            acts,
            of: (m, at) => {
              const id = rows.idOf(m.id)
              const p = id === null ? undefined : rows.message(id)
              if (!p)
                return {
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
                }
              const mine = p.sender === me
              // From the old copy: read-only here.
              const act = acts && !p.archived
              const write = act && !at.timedOut
              const can = messageActs(p, write, mine)
              const threads = list === 'main'
              return {
                event: p.id,
                server: null,
                local: true,
                mentioned:
                  !mine &&
                  ((me !== null && p.mentions.includes(me)) ||
                    p.reply?.sender === me ||
                    p.everyone === true),
                canEdit: can.edit,
                canReply: can.reply,
                canForward: can.forward,
                thread: threads ? threadAct(p, write && held.threads) : null,
                chip: threads && !p.archived,
                canDelete:
                  act &&
                  !at.root &&
                  (mine || (place.kind === 'p2pRoom' && held.manage && !at.timedOut)),
                canReact: write && held.react,
                canUnreact: write,
                sent: mine
                  ? p.failed
                    ? 'failed'
                    : p.pending
                      ? 'pending'
                      : 'delivered'
                  : undefined,
                sentTip,
                canRetry: acts && !at.timedOut,
                canDrop: acts,
                lateAt: p.late ? p.sentTs : undefined,
                hidden: p.removed ? 'removed' : p.slowHidden ? 'slow' : undefined,
                pinned: p.system?.target ?? null,
              }
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
