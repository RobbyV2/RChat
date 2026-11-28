'use client'
import { Button } from './controls'
import { PeerActorTag, ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import type { OpenThread, ThreadState } from '../lib/place/thread'
import { useRows } from '../lib/place/use_rows'
import { useLoadedPeople } from '../lib/place/use_looks'
import { useRowFlags } from './listed_row'
import { useThread } from '../lib/place/use_thread'
import { MessageSquareText } from 'lucide-react'
import { useLive } from '../lib/place/react'
import { messageRights } from '../lib/actions/message'
import { actionPress, openActionMenu } from '../lib/actions/menu'
import { threadKey, useStore } from '../lib/store'
import type { Message } from '../lib/types'
import type { Outgoing } from '../lib/store_types'
import { findById } from '../lib/window'
import { newSince } from '../lib/lists'
import { Composer } from './composer'
import { TypingLine } from './typing_indicator'
import { OutboxRows, reactHeader } from './message_pane'
import { MessageRow, type RowHandlers } from './message_row'
import { useMedia } from './context_menu'
import {
  EdgeSentinel,
  OlderLoading,
  PresentBar,
  useChatScroll,
  useFocusMessage,
  useScrollAnchor,
} from './viewport_height'
import { PanelHeader, useEscape } from './ui'
import { LightboxList } from './media_lightbox'
import { BlockedComposer, BlockedList } from './blocking'
import { MessageListSkeleton } from './skeletons'
import { BulkJobBar, Selectable, SelectionBar, openSelectionMenu } from './selection'
import { ChatWorkNotices } from './own_load'
import { Inset, Row, Surface } from './layout'
import { messagePlaces, type GroupPlace } from '../lib/message_groups'
import { plays } from '../lib/motion/play'

const EMPTY: Message[] = []
const NO_SENDS: Outgoing[] = []
const ALONE: GroupPlace = { first: true, last: true }

// What the thread panel's list holds while it scrolls: its scroller, where it stands, and the
// replies that came in below.
export interface ThreadScroll {
  listRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  scroll: ReturnType<typeof useChatScroll>
  beforePage: () => void
  fresh: number
  first: number | undefined
  last: number | undefined
}

const onScreen = () => typeof document === 'undefined' || document.visibilityState === 'visible'

// Follows the open thread's list: keeps its place while pages load, marks the thread read at
// the bottom, and closes it on Escape unless `escape` took the key.
export function useThreadScroll(
  thread: OpenThread,
  state: ThreadState,
  {
    replies,
    own,
    outCount,
    focus,
    escape,
  }: {
    replies: Message[]
    // The author name the list's own messages carry.
    own: string | undefined
    outCount: number
    focus: boolean
    escape?: () => boolean
  }
): ThreadScroll {
  const { scope, older, newer, pagesOnSight, stale, unseen } = state
  const away = pagesOnSight && newer.more
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const following = useStore(s => scope !== null && s.atBottom[scope] === true)
  const first = replies[0]?.id
  const last = replies[replies.length - 1]?.id
  const beforePage = useScrollAnchor(listRef, first, older.loading || newer.loading)
  useEscape(e => {
    if (escape?.()) return
    if (!e.defaultPrevented) thread.close()
  }, 'panel')
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: replies.length,
    lastId: last,
    stale,
    focus,
    detached: away,
    outCount,
    onBottom: () => {
      if (onScreen()) thread.markRead()
    },
  })
  useEffect(() => {
    if (scope !== null && unseen && following && !away && onScreen()) thread.markRead()
  }, [thread, scope, unseen, following, away])
  return {
    listRef,
    contentRef,
    scroll,
    beforePage,
    fresh: newSince(replies, scroll.leftAt, own),
    first,
    last,
  }
}

// The thread panel of a conversation, whichever place it is in: the header, bars above the list,
// the list (the way to older replies, the root, the reply count, the replies), who is typing and
// the composer (or what a caller puts in its place). The rows are the caller's.
export function ThreadPanelView({
  thread,
  state,
  at,
  peer = false,
  bars,
  root,
  children,
  composer,
}: {
  thread: OpenThread
  state: ThreadState
  at: ThreadScroll
  peer?: boolean
  bars?: ReactNode
  root: ReactNode
  children: ReactNode
  composer?: ReactNode
}) {
  const { older, newer, pagesOnSight, count } = state
  const { listRef, contentRef, scroll, beforePage, fresh, first } = at
  const away = pagesOnSight && newer.more
  const onScroll = () => {
    scroll.onScroll()
    if (older.loading || newer.loading) beforePage()
  }
  const onTop = () => {
    if (older.loading || !older.more || first === undefined) return
    beforePage()
    thread.loadOlder()
  }
  return (
    <div
      ref={plays('thread')}
      data-thread-panel
      className="flex h-full w-full flex-col bg-surface-container-low"
    >
      <PanelHeader
        actor={peer ? <PeerActorTag header /> : <ViewActorTag header />}
        icon={MessageSquareText}
        title="Thread"
        closeTitle="Close thread"
        onClose={thread.close}
      />
      {bars}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {older.loading && <OlderLoading />}
        {pagesOnSight && newer.loading && <OlderLoading newer />}
        {away && !newer.loading && <PresentBar onJump={thread.toPresent} />}
        {!away && scroll.positioned && fresh > 0 && (
          <PresentBar count={fresh} onJump={scroll.toBottom} />
        )}
        <Inset
          ref={listRef}
          onScroll={onScroll}
          pad="md"
          inset="ends"
          look="overflow-y-auto"
          place="flex-1"
        >
          <div ref={contentRef}>
            {pagesOnSight
              ? scroll.positioned &&
                first !== undefined &&
                older.more && (
                  <EdgeSentinel key={first} root={listRef} edge="top" onVisible={onTop} />
                )
              : older.more && (
                  <Surface pad="sm" tone="plain" radius="none" align="center">
                    <Button onClick={thread.loadOlder}>Show older replies</Button>
                  </Surface>
                )}
            {state.root === 'shown' ? (
              root
            ) : (
              <Surface pad="lg" tone="plain" radius="none">
                <p className="text-sm text-on-surface-variant italic">
                  {state.root === 'loading' ? 'Loading…' : 'Message unavailable'}
                </p>
              </Surface>
            )}
            <Surface pad="lg" inset="bar" tone="plain" radius="none">
              <Row gap="sm">
                <span className="h-px flex-1 bg-outline-variant" />
                <span className="text-xs text-on-surface-variant">
                  {count} {count === 1 ? 'reply' : 'replies'}
                </span>
                <span className="h-px flex-1 bg-outline-variant" />
              </Row>
            </Surface>
            {children}
          </div>
        </Inset>
      </div>
      <div className="relative shrink-0">
        <TypingLine list="thread" bg="bg-surface-container-low" />
        {composer ?? <Composer list="thread" />}
      </div>
    </div>
  )
}

// What ends the replies: their placeholder while none is placed, and where the list asks for the
// page after its last row as soon as that end shows.
export function ThreadTail({
  thread,
  state,
  at,
}: {
  thread: OpenThread
  state: ThreadState
  at: ThreadScroll
}) {
  const { scope, newer, pagesOnSight, waiting } = state
  const { listRef, scroll, beforePage, last } = at
  return (
    <>
      {waiting && scope !== null && (
        <MessageListSkeleton seed={scope} variant="panel" label="Loading replies" />
      )}
      {pagesOnSight && scroll.positioned && newer.more && last !== undefined && (
        <EdgeSentinel
          key={`n${last}`}
          root={listRef}
          edge="bottom"
          onVisible={() => {
            if (newer.loading) return
            beforePage()
            thread.loadNewer()
          }}
        />
      )}
    </>
  )
}

export default function ThreadPanel() {
  const acct = useAccount()
  const { store } = acct

  const root = useStore(s => {
    if (s.panel?.kind !== 'thread') return null
    const r = s.panel.root
    const list =
      r.channel_id !== null
        ? s.messages[`c${r.channel_id}`]
        : r.dm_id !== null
          ? s.messages[`d${r.dm_id}`]
          : undefined
    return findById(list, r.id) ?? r
  })
  const replies =
    useStore(s => (s.panel?.kind === 'thread' ? s.messages[`t${s.panel.root.id}`] : undefined)) ??
    EMPTY
  const me = useStore(s => s.me)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const dmOther = useStore(s => {
    const id = s.panel?.kind === 'thread' ? s.panel.root.dm_id : null
    const dm = id !== null ? s.dms.find(d => d.id === id) : undefined
    return dm && s.blocked[dm.other.username] ? dm.other : null
  })
  const people = useMemo(() => (root ? [root, ...replies] : replies), [root, replies])
  useLoadedPeople(people)
  const key = useStore(s => (s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : null))
  const thread = useThread()
  const state = useLive(thread.state)
  const focus = useStore(s => (key ? s.focus[key] : undefined))
  const outgoing = useStore(s => (key ? s.outbox[key] : undefined)) ?? NO_SENDS
  const startReply = useStore(s => s.startReply)
  const startEdit = useStore(s => s.startEdit)
  const copyForward = useStore(s => s.copyForward)
  const editingId = useStore(s =>
    s.editing && s.panel?.kind === 'thread' && s.editing.key === threadKey(s.panel.root.id)
      ? s.editing.id
      : null
  )
  const wide = useMedia('(min-width: 768px)')
  const detached = state.newer.more
  const selecting = useStore(s => key !== null && s.selection?.scope === key)
  const at = useThreadScroll(thread, state, {
    replies,
    own: me?.username,
    outCount: outgoing.length,
    focus: focus !== undefined,
    escape: () => {
      if (!store.getState().selection) return false
      store.getState().exitSelection()
      return true
    },
  })

  const flash = useFocusMessage(at.listRef, key, focus, replies, at.scroll.settle)
  const places = useMemo(
    () => messagePlaces(replies, detached ? new Set([replies.length]) : undefined, outgoing),
    [replies, detached, outgoing]
  )
  const rootAt = root?.created_at ?? null

  const flags = useRowFlags(useRows('thread'))

  if (!root || !key) return null

  const replyTo = (m: Message) => startReply(key, m)
  const editMsg = (m: Message) => startEdit(key, m)
  const jump = (id: number) => thread.jump(String(id))
  const jumpMain = (id: number) => {
    if (!wide) thread.close()
    thread.jumpMain(String(id))
  }

  const rowMenu = (m: Message) => (x: number, y: number) => {
    if (m.id !== root.id && openSelectionMenu(key, m, x, y, acct)) return
    const react = messageRights(store.getState(), m, key).react
    openActionMenu(
      x,
      y,
      { kind: 'message', message: m, list: key },
      react ? reactHeader(m, x, y) : undefined,
      acct
    )
  }

  const handlers = (root: boolean): RowHandlers => ({
    menu: (m, x, y) => rowMenu(m)(x, y),
    jump: root ? jumpMain : jump,
    edit: editMsg,
    reply: replyTo,
    forward: copyForward,
    thread: () => {},
    remove: (m, skipConfirm) => store.menu.confirmDeleteMessage(m.id, skipConfirm),
  })
  const onRoot = handlers(true)
  const onReply = handlers(false)

  const row = (m: Message, { first, last }: GroupPlace) => (
    <MessageRow
      key={m.id}
      m={m}
      first={first}
      last={last}
      {...flags.of(m, m.id === root.id)}
      divider={false}
      flash={flash === m.id}
      inThread
      editing={editingId === m.id}
      on={m.id === root.id ? onRoot : onReply}
    />
  )

  return (
    <LightboxList
      rows={() => ({ ids: replies.map(m => m.id), places })}
      forward={id => {
        const m = id === root.id ? root : replies.find(x => x.id === id)
        return m
          ? actionPress('message_forward', { kind: 'message', message: m, list: key }, acct)
          : null
      }}
    >
      <ThreadPanelView
        thread={thread}
        state={state}
        at={at}
        bars={
          <>
            {wide && <SelectionBar scope={key} sheet={false} compact />}
            <BulkJobBar scope={key} />
            <ChatWorkNotices server={server} />
          </>
        }
        root={row(root, ALONE)}
        composer={
          selecting && !wide ? (
            <SelectionBar scope={key} sheet />
          ) : dmOther ? (
            <BlockedComposer user={dmOther} />
          ) : undefined
        }
      >
        <BlockedList
          messages={replies}
          focusId={focus?.id ?? null}
          dayAbove={rootAt}
          row={(m, i) => (
            <Selectable key={m.id} m={m} scope={key}>
              {row(m, places[i] ?? ALONE)}
            </Selectable>
          )}
          tail={lastShownAt => (
            <>
              <ThreadTail thread={thread} state={state} at={at} />
              <OutboxRows
                msgKey={key}
                outgoing={outgoing}
                places={places.slice(replies.length)}
                dayAbove={lastShownAt}
                size={30}
              />
            </>
          )}
        />
      </ThreadPanelView>
    </LightboxList>
  )
}
