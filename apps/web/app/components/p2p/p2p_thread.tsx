'use client'
import { identityScopeKey } from '../../lib/p2p/app/host'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'
import { ChannelCanContext, useChannelCan } from '../../lib/place/use_rights'
import { CAN_ALL, type ChannelCan } from '../../lib/channel_perms'
import type { Look } from '../../lib/role_looks'

import { Fragment, useCallback, useMemo, type ReactNode } from 'react'
import { useMask } from '../../lib/store'
import { threadKey, threadScope, type P2pThread } from '../../lib/p2p/app'
import type { P2pMessage } from '../../lib/p2p/dm'
import type { ServerView } from '../../lib/p2p/server'
import type { Message } from '../../lib/types'
import { PlaceProvider, useLive, useP2pRoom } from '../../lib/place/react'
import { EmojiPicker } from '../emoji_picker'
import { authorLook, MessageRow, RemovedRow, SlowHiddenRow } from '../message_row'
import { ThreadPanelView, ThreadTail, useThreadScroll } from '../thread_panel'
import { openThreadAt } from '../../lib/place/use_thread'
import { TypingIndicator } from '../typing_indicator'
import {
  P2pComposer,
  CanFetchContext,
  rowOf,
  type RowRules,
  useP2pFlash,
  useP2pList,
} from './p2p_chat'
import { memberLooks } from '../../lib/p2p/roles'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { sendBlockFor } from './p2p_server_view'
import { usePeerTimeoutEnds } from '../timeout_dialog'
import { useDmFacts } from './p2p_dm_pane'
import { groupPlaces, p2pCue, type GroupPlace } from '../../lib/message_groups'
import { dayStarts } from '../../lib/date_dividers'
import { DateDivider } from '../date_divider'
import { LightboxList } from '../media_lightbox'

// The thread of a P2P server channel or conversation beside it (full screen on phones): its root,
// the replies stored here and a composer, through the same panel as instance threads.

const EMPTY: P2pMessage[] = []
const NONE: string[] = []
const ALONE: GroupPlace = { first: true, last: true }

// What a thread's rows and composer need from where it is.
interface ThreadFacts {
  ownName: (ik: string) => string
  mayDelete: (p: P2pMessage) => boolean
  disabled: ReactNode
  typers: string[]
  textOnly?: boolean
  pendingTip: string
  // A server thread's rules for acting, a timeout among them; a conversation follows `disabled`.
  canAct?: boolean
  timedOut?: boolean
  // What we hold in a server thread's channel; a conversation holds nothing back.
  can?: ChannelCan
  // How a server member's name shows (role color and icon); a conversation shows names plainly.
  lookOf?: (ik: string) => Look
}

function P2pThreadPanelBody() {
  const t = useP2p(s => s.thread)
  const v = useP2p(s => (s.thread?.ch ? s.servers[s.thread.room] : undefined))
  if (!t) return null
  if (!t.ch) return <ConversationThread key={`${t.room}/${t.root}`} t={t} />
  return v ? <ServerThread key={`${t.room}/${t.root}`} t={t} v={v} /> : null
}

function ServerThread({ t, v }: { t: P2pThread; v: ServerView }) {
  const identity = useP2pApp()!
  const { memberName, profileName } = identity
  const acct = useAccount()
  const me = useP2p(s => s.me)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const movedAt = useP2p(s => s.movedAt)
  const movingAt = useP2p(s => s.movingAt)
  const typers = useP2p(s => s.serverTyping[threadKey(t)] ?? NONE)
  const room = v.id
  const nameOf = useCallback((ik: string) => memberName(room, ik), [room])
  const members = v.members
  const roles = v.roles
  const mask = useMask(useP2p(s => ownsP2pServer(v, s.me)))
  const lookOf = useMemo(() => memberLooks({ members, roles }, mask), [members, roles, mask])
  const timedOut = usePeerTimeoutEnds(v.timedOutUntil)
  const held = useChannelCan(useP2pRoom(v.id), t.ch)
  const moderator = held.manage && timedOut === null
  const mayDelete = useCallback((p: P2pMessage) => p.sender === me || moderator, [me, moderator])
  const ownName = useCallback((ik: string) => profileName(ik, room), [room])
  const channel = v.channels.find(c => c.id === t.ch)
  const { bar: disabled, canAct } = sendBlockFor(identity)(
    v,
    { reader, elsewhere, status, movedAt, movingAt, timedOut },
    channel,
    acct
  )
  const names = useMemo(() => typers.map(nameOf), [typers, nameOf])
  return (
    <ThreadBody
      t={t}
      f={{
        ownName,
        mayDelete,
        disabled,
        typers: names,
        textOnly: channel?.text_only,
        pendingTip: 'Waiting for a member to come online',
        canAct,
        timedOut: timedOut !== null,
        can: held,
        lookOf,
      }}
    />
  )
}

function ConversationThread({ t }: { t: P2pThread }) {
  const identity = useP2pApp()!
  const { profileName } = identity
  const facts = useDmFacts()
  const { mayDelete, disabled, peerIk, peerRaw, peerName } = facts
  const typingIks = useP2p(s => s.typing[threadKey(t)] ?? NONE)
  const ownName = useCallback((ik: string) => profileName(ik), [])
  const typers = useMemo(
    () => typingIks.filter(ik => ik === peerIk).map(() => peerRaw),
    [typingIks, peerIk, peerRaw]
  )
  return (
    <ThreadBody
      t={t}
      f={{
        ownName,
        mayDelete,
        disabled,
        typers,
        pendingTip: `Waiting for ${peerName} to come online`,
      }}
    />
  )
}

function ThreadBody({ t, f }: { t: P2pThread; f: ThreadFacts }) {
  const identity = useP2pApp()!
  const { ownName, mayDelete, disabled } = f

  const me = useP2p(s => s.me)
  const key = threadKey(t)
  const scope = identityScopeKey(identity.localId, threadScope(t))
  const focus = useP2p(s => (s.focus?.room === key ? s.focus : null))
  const canAct = f.canAct ?? !disabled
  const timedOut = f.timedOut ?? false
  const held = f.can ?? CAN_ALL
  const replies = t.messages ?? EMPTY
  const {
    name,
    rows,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowOn,
    forwardRow,
    picker,
    setPicker,
  } = useP2pList({
    ownName,
    room: t.room,
    ch: t.ch,
    list: 'thread',
    draftKey: key,
    scope,
    canAct,
    timedOut,
    mayPin: false,
    mayDelete,
    forwardSkip: null,
    threads: false,
    can: held,
  })
  const thread = openThreadAt(place)
  const state = useLive(thread.state)
  const head = t.head ? rows[0] : null
  const list = useMemo(() => (t.head ? rows.slice(1) : rows), [rows, t.head])
  const shared = useMemo(() => list.map(r => r.m), [list])
  const places = useMemo(() => groupPlaces(list.map(r => p2pCue(r.p))), [list])
  const headAt = head?.m.created_at ?? null
  const days = useMemo(
    () =>
      dayStarts(
        list.map(r => r.m.created_at),
        headAt
      ),
    [list, headAt]
  )
  const ownCount = useMemo(() => replies.filter(m => m.sender === me).length, [replies, me])
  const at = useThreadScroll(thread, state, {
    replies: shared,
    own: me ?? undefined,
    outCount: ownCount,
    focus: focus !== null,
  })
  const flash = useP2pFlash(at.listRef, scope, focus, num, shared, at.scroll.settle)

  // A quote in the root jumps in the channel; one in a reply, in the thread.
  const jumpMain = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (!id) return
      if (!window.matchMedia('(min-width: 768px)').matches) thread.close()
      thread.jumpMain(id)
    },
    [idOf, thread]
  )
  const jumpHere = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) thread.jump(id)
    },
    [idOf, thread]
  )

  const onRoot = useMemo(() => rowOn(jumpMain), [rowOn, jumpMain])
  const onReply = useMemo(() => rowOn(jumpHere), [rowOn, jumpHere])
  const { pendingTip } = f
  const rules = useMemo<RowRules>(
    () => ({ me, canAct, timedOut, held, threads: false, pendingTip, mayDelete }),
    [me, canAct, timedOut, held, pendingTip, mayDelete]
  )
  const rootRules = useMemo<RowRules>(() => ({ ...rules, mayDelete: () => false }), [rules])

  const row = (r: { p: P2pMessage; m: Message }, root: boolean, place: GroupPlace) => {
    const { p, m } = r
    if (p.removed) return <RemovedRow key={p.id} m={m} divider={false} />
    if (p.slowHidden) return <SlowHiddenRow key={p.id} m={m} divider={false} />
    return (
      <MessageRow
        key={p.id}
        m={m}
        first={place.first}
        last={place.last}
        divider={false}
        flash={flash === m.id}
        inThread
        editing={editing && editingState?.id === p.id ? editing : false}
        {...rowOf(p, root ? rootRules : rules, identity)}
        {...authorLook(f.lookOf?.(p.sender))}
        on={root ? onRoot : onReply}
      />
    )
  }

  return (
    <ChannelCanContext.Provider value={held}>
      <PlaceProvider place={place}>
        <CanFetchContext.Provider value={canAct}>
          <div data-p2p-thread className="contents">
            <LightboxList
              rows={() => ({ ids: list.map(r => r.p.id), places })}
              forward={forwardRow}
            >
              <ThreadPanelView
                thread={thread}
                state={state}
                at={at}
                peer
                root={head && row(head, true, ALONE)}
                footer={
                  <>
                    <TypingIndicator scope={null} bg="bg-surface-container-low" names={f.typers} />
                    <P2pComposer
                      draftKey={key}
                      list="thread"
                      channelTextOnly={f.textOnly}
                      unstarted={!t.loading && !t.head?.replies && replies.length === 0}
                      scope={scope}
                      title="the thread"
                      placeholder="Message thread"
                      nameOf={name}
                      disabled={disabled}
                    />
                  </>
                }
              >
                {list.map((r, i) => (
                  <Fragment key={r.p.id}>
                    {days.has(i) && <DateDivider at={r.m.created_at} />}
                    {row(r, false, places[i] ?? ALONE)}
                  </Fragment>
                ))}
                <ThreadTail thread={thread} state={state} at={at} />
              </ThreadPanelView>
            </LightboxList>
            {picker && (
              <EmojiPicker
                anchor={picker.anchor?.isConnected ? picker.anchor : null}
                side="top"
                align="end"
                label="Add reaction"
                onPick={e => react(picker.m, e, false)}
                onClose={() => setPicker(null)}
              />
            )}
          </div>
        </CanFetchContext.Provider>
      </PlaceProvider>
    </ChannelCanContext.Provider>
  )
}

export const P2pThreadPanel = withP2pIdentity(P2pThreadPanelBody)
