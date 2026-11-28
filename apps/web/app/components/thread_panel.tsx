'use client'
import { Button } from './controls'
import { PeerActorTag, ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import type { OpenThread, ThreadState } from '../lib/place/thread'
import { useRows } from '../lib/place/use_rows'
import { useLoadedPeople } from '../lib/place/use_looks'
import { useRowFlags } from './row_flags'
import { useRowHandlers } from './row_handlers'
import { useThread } from '../lib/place/use_thread'
import { MessageSquareText } from 'lucide-react'
import { useLive, usePlace } from '../lib/place/react'
import { isHosted } from '../lib/place/place'
import { ListedRow } from './listed_row'
import { ListReactPicker } from './list_picker'
import { useStore } from '../lib/store'
import type { Message } from '../lib/types'
import { newSince } from '../lib/lists'
import { Composer } from './composer'
import { TypingLine } from './typing_indicator'
import { OutboxRows } from './message_pane'
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
import { BlockedList } from './blocking'
import { MessageListSkeleton } from './skeletons'
import { BulkJobBar, Selectable, SelectionBar } from './selection'
import { ChatWorkNotices } from './own_load'
import { Inset, Row, Surface } from './layout'
import { type GroupPlace } from '../lib/message_groups'
import { plays } from '../lib/motion/play'

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

// What a list with rows to pick shows above itself.
function PickBars({ scope, wide }: { scope: string; wide: boolean }) {
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  return (
    <>
      {wide && <SelectionBar scope={scope} sheet={false} compact />}
      <BulkJobBar scope={scope} />
      <ChatWorkNotices server={server} />
    </>
  )
}

// The thread open beside the conversation of the place around it: its first message, the
// replies and the composer.
export default function ThreadPanel() {
  const { store } = useAccount()
  const place = usePlace()
  const thread = useThread()
  const state = useLive(thread.state)
  const { root, replies, keys, places, outgoing, own, outCount, focus, picks } = useLive(
    thread.rows
  )
  const people = useMemo(() => (root ? [root, ...replies] : replies), [root, replies])
  useLoadedPeople(people)
  const wide = useMedia('(min-width: 768px)')
  const selecting = useStore(s => picks !== null && s.selection?.scope === picks)
  const at = useThreadScroll(thread, state, {
    replies,
    own,
    outCount,
    focus: focus !== undefined,
    escape: () => {
      if (!store.getState().selection) return false
      store.getState().exitSelection()
      return true
    },
  })
  const flash = useFocusMessage(at.listRef, state.scope, focus, replies, at.scroll.settle)
  useEffect(() => {
    if (focus) thread.focused()
  }, [thread, focus])
  const flags = useRowFlags(useRows('thread'))
  const { on, onRoot, forwardShown, editing } = useRowHandlers('thread')

  if (state.scope === null) return null

  const row = (m: Message, { first, last }: GroupPlace, head: boolean) => {
    const of = flags.of(m, head)
    return (
      <ListedRow
        key={m.id}
        m={m}
        first={first}
        last={last}
        {...of}
        divider={false}
        flash={flash === m.id}
        inThread
        editing={editing(m, of.event)}
        on={head ? onRoot : on}
      />
    )
  }

  return (
    <LightboxList rows={() => ({ ids: keys, places })} forward={forwardShown}>
      <ThreadPanelView
        thread={thread}
        state={state}
        at={at}
        peer={place !== null && !isHosted(place)}
        bars={picks !== null && <PickBars scope={picks} wide={wide} />}
        root={root && row(root, ALONE, true)}
        composer={
          picks !== null && selecting && !wide ? <SelectionBar scope={picks} sheet /> : undefined
        }
      >
        <BlockedList
          messages={replies}
          focusId={focus?.id ?? null}
          dayAbove={root?.created_at ?? null}
          row={(m, i) => (
            <Selectable key={m.id} m={m} scope={picks}>
              {row(m, places[i] ?? ALONE, false)}
            </Selectable>
          )}
          tail={lastShownAt => (
            <>
              <ThreadTail thread={thread} state={state} at={at} />
              {picks !== null && (
                <OutboxRows
                  msgKey={picks}
                  outgoing={outgoing}
                  places={places.slice(replies.length)}
                  dayAbove={lastShownAt}
                  size={30}
                />
              )}
            </>
          )}
        />
      </ThreadPanelView>
      <ListReactPicker />
    </LightboxList>
  )
}
