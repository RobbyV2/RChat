'use client'
import { identityScopeKey } from '../../lib/p2p/app/host'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'
import { ChannelCanContext, useChannelCan } from '../../lib/place/use_rights'
import { CAN_ALL, type ChannelCan } from '../../lib/channel_perms'
import type { Look } from '../../lib/role_looks'

import { Fragment, useCallback, useEffect, useMemo, useRef, type ReactNode } from 'react'
import { roomLooksKey } from '../../lib/server_profile'
import { useMask, useStore } from '../../lib/store'
import { threadKey, threadScope, type P2pThread } from '../../lib/p2p/app'
import type { P2pMessage } from '../../lib/p2p/dm'
import type { ServerView } from '../../lib/p2p/server'
import { newSince } from '../../lib/lists'
import type { Message, UserRef } from '../../lib/types'
import { PlaceProvider, useP2pRoom } from '../../lib/place/react'
import { EmojiPicker } from '../emoji_picker'
import { ThreadPanelView } from '../thread_panel'
import { TypingIndicator } from '../typing_indicator'
import { PresentBar, useChatScroll } from '../viewport_height'
import { textBtn, useEscape } from '../ui'
import {
  P2pComposer,
  P2pHiddenRow,
  P2pRow,
  P2pSlowRow,
  pingsMe,
  rowLook,
  useP2pFlash,
  useP2pList,
  type Mentionable,
} from './p2p_chat'
import { memberLooks } from '../../lib/p2p/roles'
import { ownsP2pServer } from '../../lib/p2p/server/types'
import { sendBlockFor } from './p2p_server_view'
import { usePeerTimeoutEnds } from '../timeout_dialog'
import { useDmFacts } from './p2p_dm_pane'
import { groupPlaces, p2pCue, type GroupPlace } from '../../lib/message_groups'
import { dayStarts } from '../../lib/date_dividers'
import { DateDivider } from '../date_divider'
import { MessageListSkeleton } from '../skeletons'
import { LightboxList } from '../media_lightbox'
import { Surface } from '../layout'

// The thread of a P2P server channel or conversation beside it (full screen on phones): its root,
// the replies stored here and a composer, through the same panel as instance threads.

const EMPTY: P2pMessage[] = []
const NONE: string[] = []
const ALONE: GroupPlace = { first: true, last: true }

// What a thread's rows and composer need from where it is.
interface ThreadFacts {
  nameOf: (ik: string) => string
  userOf?: (ik: string) => UserRef
  ownName: (ik: string) => string
  people: Mentionable[]
  mayDelete: (p: P2pMessage) => boolean
  disabled: ReactNode
  typers: string[]
  unseen: boolean
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
  const { memberName, memberUser, profileName } = identity
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
  const looks = useMemo(() => roomLooksKey(members), [members])
  const userOf = useCallback((ik: string) => memberUser(room, ik), [room, looks])
  const roles = v.roles
  const mask = useMask(useP2p(s => ownsP2pServer(v, s.me)))
  const lookOf = useMemo(() => memberLooks({ members, roles }, mask), [members, roles, mask])
  const people = useMemo<Mentionable[]>(
    () =>
      members.filter(m => m.m === 'join').map(m => ({ ik: m.ik, name: m.name, handle: m.name })),
    [members]
  )
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
        nameOf,
        userOf,
        ownName,
        people,
        mayDelete,
        disabled,
        typers: names,
        unseen: (v.chans[t.ch ?? '']?.threads?.[t.root] ?? 0) > 0,
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
  const { nameOf, people, mayDelete, disabled, peerIk, peerRaw, peerName } = facts
  const typingIks = useP2p(s => s.typing[threadKey(t)] ?? NONE)
  const unseen = useP2p(s => (s.rooms[t.room]?.threads?.[t.root] ?? 0) > 0)
  const ownName = useCallback((ik: string) => profileName(ik), [])
  const typers = useMemo(
    () => typingIks.filter(ik => ik === peerIk).map(() => peerRaw),
    [typingIks, peerIk, peerRaw]
  )
  return (
    <ThreadBody
      t={t}
      f={{
        nameOf,
        ownName,
        people,
        mayDelete,
        disabled,
        typers,
        unseen,
        pendingTip: `Waiting for ${peerName} to come online`,
      }}
    />
  )
}

function ThreadBody({ t, f }: { t: P2pThread; f: ThreadFacts }) {
  const identity = useP2pApp()!
  const { p2pThread, p2pDm } = identity
  const { nameOf, userOf, ownName, people, mayDelete, disabled, unseen } = f

  const me = useP2p(s => s.me)
  const key = threadKey(t)
  const scope = identityScopeKey(identity.localId, threadScope(t))
  const focus = useP2p(s => (s.focus?.room === key ? s.focus : null))
  const following = useStore(s => s.atBottom[scope] === true)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const canAct = f.canAct ?? !disabled
  const timedOut = f.timedOut ?? false
  const held = f.can ?? CAN_ALL
  const replies = t.messages ?? EMPTY
  const all = useMemo(() => (t.head ? [t.head, ...replies] : replies), [t.head, replies])
  const {
    rows,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowMenu,
    forwardRow,
    copyRow,
    picker,
    setPicker,
  } = useP2pList({
    messages: all,
    nameOf,
    userOf,
    ownName,
    people,
    room: t.room,
    ch: t.ch,
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
  useEscape(e => {
    if (!e.defaultPrevented) p2pThread.close()
  }, 'panel')
  const visible = () => typeof document === 'undefined' || document.visibilityState === 'visible'
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: shared.length,
    lastId: shared[shared.length - 1]?.id,
    stale: t.loading && replies.length === 0,
    focus: focus !== null,
    detached: false,
    outCount: ownCount,
    onBottom: () => {
      if (visible()) void p2pThread.markRead()
    },
  })
  useEffect(() => {
    if (unseen && following && visible()) void p2pThread.markRead()
  }, [unseen, following])
  const fresh = newSince(shared, scroll.leftAt, me ?? undefined)
  const flash = useP2pFlash(listRef, scope, focus, num, shared, scroll.settle)

  // A quote in the root jumps in the channel; one in a reply, in the thread.
  const jumpMain = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (!id) return
      if (!window.matchMedia('(min-width: 768px)').matches) p2pThread.close()
      void p2pDm.jumpTo(id)
    },
    [idOf]
  )
  const jumpHere = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) void p2pThread.jumpTo(id)
    },
    [idOf]
  )

  const row = (r: { p: P2pMessage; m: Message }, root: boolean, place: GroupPlace) => {
    const { p, m } = r
    if (p.removed) return <P2pHiddenRow key={p.id} m={m} divider={false} />
    if (p.slowHidden) return <P2pSlowRow key={p.id} m={m} divider={false} />
    return (
      <P2pRow
        key={p.id}
        p={p}
        m={m}
        first={place.first}
        last={place.last}
        mine={p.sender === me}
        pendingTip={f.pendingTip}
        mentioned={pingsMe(p, me)}
        divider={false}
        flash={flash === m.id}
        canAct={canAct}
        timedOut={timedOut}
        canDelete={!root && mayDelete(p)}
        editing={editing && editingState?.id === p.id ? editing : null}
        draftKey={key}
        threads={false}
        onMenu={rowMenu}
        onCopy={copyRow}
        onJump={root ? jumpMain : jumpHere}
        {...rowLook(f.lookOf?.(p.sender))}
      />
    )
  }

  return (
    <ChannelCanContext.Provider value={held}>
      <PlaceProvider place={place}>
        <div data-p2p-thread className="contents">
          <LightboxList rows={() => ({ ids: list.map(r => r.p.id), places })} forward={forwardRow}>
            <ThreadPanelView
              peer
              onClose={p2pThread.close}
              overlays={
                scroll.positioned &&
                fresh > 0 && <PresentBar count={fresh} onJump={scroll.toBottom} />
              }
              listRef={listRef}
              contentRef={contentRef}
              onScroll={scroll.onScroll}
              head={
                t.more && (
                  <Surface pad="sm" tone="plain" radius="none" align="center">
                    <button onClick={() => void p2pThread.loadOlder()} className={textBtn}>
                      Show older replies
                    </button>
                  </Surface>
                )
              }
              root={
                head ? (
                  row(head, true, ALONE)
                ) : (
                  <Surface pad="lg" tone="plain" radius="none">
                    <p className="text-sm text-on-surface-variant italic">
                      {t.loading ? 'Loading…' : 'Message unavailable'}
                    </p>
                  </Surface>
                )
              }
              count={t.head?.replies ?? replies.length}
              replies={list.map((r, i) => (
                <Fragment key={r.p.id}>
                  {days.has(i) && <DateDivider at={r.m.created_at} />}
                  {row(r, false, places[i] ?? ALONE)}
                </Fragment>
              ))}
              tail={
                t.loading &&
                replies.length === 0 &&
                (t.head?.replies ?? 1) > 0 && (
                  <MessageListSkeleton seed={scope} variant="panel" label="Loading replies" />
                )
              }
              footer={
                <>
                  <TypingIndicator scope={null} bg="bg-surface-container-low" names={f.typers} />
                  <P2pComposer
                    draftKey={key}
                    channelTextOnly={f.textOnly}
                    unstarted={!t.loading && !t.head?.replies && replies.length === 0}
                    scope={scope}
                    title="the thread"
                    placeholder="Message thread"
                    nameOf={nameOf}
                    disabled={disabled}
                  />
                </>
              }
            />
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
      </PlaceProvider>
    </ChannelCanContext.Provider>
  )
}

export const P2pThreadPanel = withP2pIdentity(P2pThreadPanelBody)
