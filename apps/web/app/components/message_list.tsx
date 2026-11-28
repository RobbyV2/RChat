'use client'

import { Button } from './controls'
import type { ReactNode, RefObject } from 'react'
import { History } from 'lucide-react'
import type { Messages, MessagesState } from '../lib/place/messages'
import type { UnreadSummary } from '../lib/unread_banner'
import { Inset, Row, Surface } from './layout'
import { LightboxList, type LightboxScope } from './media_lightbox'
import { MessageListSkeleton } from './skeletons'
import { UnreadBanner } from './unread_banner'
import { EdgeSentinel, OlderLoading, PresentBar } from './viewport_height'

// The message list of a conversation, whichever place it is in: the scroller with its rows, the
// unread banner, the way to older and newer pages and back to the present, and the placeholders
// while the first page loads. The rows are the caller's.
export function MessageList({
  list,
  state,
  listRef,
  contentRef,
  onScroll,
  loading,
  positioned,
  ends,
  banner,
  fresh,
  toBottom,
  beforePage,
  intro,
  empty,
  lightbox,
  head,
  children,
}: {
  list: Messages
  state: MessagesState
  listRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  // The first page is on its way and nothing is placed yet.
  loading: boolean
  positioned: boolean
  // The first and last rows' keys; null for an empty list.
  ends: { first: string | number; last: string | number } | null
  // The unread messages, and the way to the first of them; null with none to show.
  banner: { unread: UnreadSummary; onJump: () => void } | null
  // Messages that came in below while the list was scrolled up.
  fresh: number
  toBottom: () => void
  // Runs before a page is asked for (to hold the scroll position).
  beforePage?: () => void
  intro?: ReactNode
  empty?: ReactNode
  lightbox: { rows: LightboxScope['rows']; forward: LightboxScope['forward'] }
  // Between the way to older pages and the rows.
  head?: ReactNode
  children: ReactNode
}) {
  const { older, newer, pagesOnSight, scope } = state
  const away = pagesOnSight && newer.more
  const onTop = () => {
    if (older.loading || !older.more || !ends) return
    beforePage?.()
    list.loadOlder()
  }
  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      {loading && scope && <MessageListSkeleton seed={scope} className="absolute inset-0" />}
      {older.loading && <OlderLoading lower={banner !== null} />}
      {banner && (
        <UnreadBanner
          unread={banner.unread}
          onJump={banner.onJump}
          onMarkRead={list.dismissUnread}
        />
      )}
      {pagesOnSight && newer.loading && <OlderLoading newer />}
      {away && !newer.loading && <PresentBar onJump={list.toPresent} />}
      {!away && positioned && fresh > 0 && <PresentBar count={fresh} onJump={toBottom} />}
      <Inset
        ref={listRef}
        onScroll={onScroll}
        pad="md"
        inset="ends"
        look={loading ? 'invisible overflow-y-auto' : 'overflow-y-auto'}
        place="flex-1"
      >
        {intro}
        {empty}
        <LightboxList rows={lightbox.rows} forward={lightbox.forward}>
          <div ref={contentRef}>
            {pagesOnSight
              ? positioned &&
                ends &&
                older.more && (
                  <EdgeSentinel key={ends.first} root={listRef} edge="top" onVisible={onTop} />
                )
              : older.more && (
                  <Surface pad="sm" tone="plain" radius="none" align="center">
                    <Button onClick={list.loadOlder}>Show older messages</Button>
                  </Surface>
                )}
            {head}
            {children}
            {!pagesOnSight && newer.more && (
              <Surface data-list-newer pad="lg" tone="plain" radius="none">
                <Row gap="sm" wrap justify="center">
                  <History size={14} className="text-on-surface-variant" />
                  <span className="text-xs text-on-surface-variant">
                    Newer messages aren&apos;t shown.
                  </span>
                  <Button onClick={list.loadNewer} disabled={newer.loading}>
                    Show newer
                  </Button>
                  <Button onClick={list.toPresent}>Jump to present</Button>
                </Row>
              </Surface>
            )}
          </div>
        </LightboxList>
      </Inset>
    </div>
  )
}

// Where the list asks for the page after its last row, as soon as that end shows.
export function NewerOnSight({
  list,
  state,
  listRef,
  positioned,
  last,
  beforePage,
}: {
  list: Messages
  state: MessagesState
  listRef: RefObject<HTMLDivElement | null>
  positioned: boolean
  last: string | number | undefined
  beforePage?: () => void
}) {
  const { newer, pagesOnSight } = state
  if (!pagesOnSight || !positioned || !newer.more || last === undefined) return null
  return (
    <EdgeSentinel
      key={`n${last}`}
      root={listRef}
      edge="bottom"
      onVisible={() => {
        if (newer.loading) return
        beforePage?.()
        list.loadNewer()
      }}
    />
  )
}
