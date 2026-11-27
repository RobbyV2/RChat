'use client'
import { PeerActorTag, ViewActorTag } from './view_actor'
import { useAccount } from '../lib/client/react'

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { MessageSquareText, Trash2 } from 'lucide-react'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { ReactionBar } from './reactions'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer } from '../lib/place/react'
import { messageRights, replyAccess } from '../lib/actions/message'
import { actionPress, openActionMenu } from '../lib/actions/menu'
import { myRank, roleColor, roleLook, threadKey, useStore } from '../lib/store'
import type { Look } from '../lib/role_looks'
import { outranksKnown } from '../lib/hierarchy'
import { useShallow } from 'zustand/react/shallow'
import type { Message } from '../lib/types'
import type { Outgoing } from '../lib/store_types'
import { findById } from '../lib/window'
import { newSince } from '../lib/lists'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import { TypingIndicator } from './typing_indicator'
import { ShownName } from './shown_user'
import {
  AuthorRow,
  GroupedRow,
  OutboxRows,
  groupPadCls,
  mentionRowCls,
  mentionsMe,
  reactHeader,
  replyAction,
  timeMeta,
  useAuthorMembers,
  useMemberLookup,
  usePeopleKey,
} from './message_pane'
import { longPress, useMedia } from './context_menu'
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
import { ReplyPreview } from './replies'
import { canQuote } from '../lib/replies'
import { canForward } from '../lib/forward'
import { ForwardCard, forwardAction } from './forwards'
import { PollCard } from './poll_card'
import { canEdit as ownEditable } from '../lib/sed'
import { MessageEditor, editAction } from './message_editor'
import { useMyTimeoutEnds } from './timeout_dialog'
import { BulkJobBar, Selectable, SelectionBar, openSelectionMenu } from './selection'
import { Row, Surface } from './layout'
import { messagePlaces, type GroupPlace } from '../lib/message_groups'

// The name color and role icon of an author, as `AuthorRow` props.
const authorOf = (look: Look) => ({ color: look.color, icon: look.icon })

const EMPTY: Message[] = []
const NO_SENDS: Outgoing[] = []
const ALONE: GroupPlace = { first: true, last: true }

// The thread panel, whichever source fills it (instance messages, or a P2P server's): the header,
// bars above the list, the list (`head`, the root, its reply count, the replies, `tail`) and the
// composer below.
export function ThreadPanelView({
  onClose,
  peer = false,
  bars,
  overlays,
  listRef,
  contentRef,
  onScroll,
  head,
  root,
  count,
  replies,
  tail,
  footer,
}: {
  peer?: boolean
  onClose: () => void
  bars?: ReactNode
  overlays?: ReactNode
  listRef: RefObject<HTMLDivElement | null>
  contentRef: RefObject<HTMLDivElement | null>
  onScroll: () => void
  head?: ReactNode
  root: ReactNode
  count: number
  replies: ReactNode
  tail?: ReactNode
  footer: ReactNode
}) {
  return (
    <div data-thread-panel className="flex h-full w-full flex-col bg-surface-container-low">
      <PanelHeader
        actor={peer ? <PeerActorTag header /> : <ViewActorTag header />}
        icon={MessageSquareText}
        title="Thread"
        closeTitle="Close thread"
        onClose={onClose}
      />
      {bars}
      <div className="relative flex min-h-0 flex-1 flex-col">
        {overlays}
        <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-3">
          <div ref={contentRef}>
            {head}
            {root}
            <Surface pad="lg" inset="bar" tone="plain" radius="none">
              <Row gap="sm">
                <span className="h-px flex-1 bg-outline-variant" />
                <span className="text-xs text-on-surface-variant">
                  {count} {count === 1 ? 'reply' : 'replies'}
                </span>
                <span className="h-px flex-1 bg-outline-variant" />
              </Row>
            </Surface>
            {replies}
            {tail}
          </div>
        </div>
      </div>
      <div className="relative shrink-0">{footer}</div>
    </div>
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
  const guest = useStore(s => s.guest)
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : undefined))
  const roles = detail?.roles
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const timedOutEnds = useMyTimeoutEnds(server)
  const dmOther = useStore(s => {
    const id = s.panel?.kind === 'thread' ? s.panel.root.dm_id : null
    const dm = id !== null ? s.dms.find(d => d.id === id) : undefined
    return dm && s.blocked[dm.other.username] ? dm.other : null
  })
  const memberFor = useMemberLookup(server)
  const rank = useStore(useShallow(s => (server ? myRank(s, server) : undefined)))
  const people = useMemo(() => (root ? [root, ...replies] : replies), [root, replies])
  useAuthorMembers(server, usePeopleKey(people))
  const key = useStore(s => (s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : null))
  const older = useStore(s => (key ? s.older[key] : undefined))
  const newer = useStore(s => (key ? s.newer[key] : undefined))
  const stale = useStore(s => (key ? s.stale[key] === true : false))
  const focus = useStore(s => (key ? s.focus[key] : undefined))
  const outgoing = useStore(s => (key ? s.outbox[key] : undefined)) ?? NO_SENDS
  const outCount = outgoing.length
  const following = useStore(s => (key ? s.atBottom[key] === true : false))
  const unseen = useStore(s => (key ? s.pings[key] !== undefined : false))
  const seeThread = useStore(s => s.seeThread)
  const closePanel = useStore(s => s.closePanel)
  const loadOlderThread = useStore(s => s.loadOlderThread)
  const loadNewerThread = useStore(s => s.loadNewerThread)
  const jumpToPresent = useStore(s => s.jumpToPresent)
  const startReply = useStore(s => s.startReply)
  const startEdit = useStore(s => s.startEdit)
  const copyForward = useStore(s => s.copyForward)
  const editingId = useStore(s =>
    s.editing && s.panel?.kind === 'thread' && s.editing.key === threadKey(s.panel.root.id)
      ? s.editing.id
      : null
  )
  const jumpTo = useStore(s => s.jumpTo)
  const wide = useMedia('(min-width: 768px)')
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const detached = newer?.more === true
  const snapEdge = useScrollAnchor(
    listRef,
    replies[0]?.id,
    older?.loading === true || newer?.loading === true
  )
  const selecting = useStore(s => key !== null && s.selection?.scope === key)
  useEscape(e => {
    if (store.getState().selection) store.getState().exitSelection()
    else if (!e.defaultPrevented) closePanel()
  }, 'panel')

  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope: key,
    count: replies.length,
    lastId: replies[replies.length - 1]?.id,
    stale,
    focus: focus !== undefined,
    detached,
    outCount,
    onBottom: () => {
      if (root && !detached && document.visibilityState === 'visible') seeThread(root.id)
    },
  })
  const rootId = root?.id ?? null
  useEffect(() => {
    if (
      rootId !== null &&
      unseen &&
      following &&
      !detached &&
      document.visibilityState === 'visible'
    )
      seeThread(rootId)
  }, [rootId, unseen, following, detached, seeThread])
  const fresh = newSince(replies, scroll.leftAt, me?.username)

  const flash = useFocusMessage(listRef, key, focus, replies, scroll.settle)
  const places = useMemo(
    () => messagePlaces(replies, detached ? new Set([replies.length]) : undefined, outgoing),
    [replies, detached, outgoing]
  )
  const rootAt = root?.created_at ?? null

  const canUnreact = me !== null && !guest
  const inDm = root !== null && root.dm_id !== null
  const can = useChannelCan(useHostedServer(server), root?.channel_id ?? null)
  const acting =
    canUnreact &&
    root !== null &&
    (inDm
      ? !dmOther
      : server !== null && me.servers.some(x => x.name === server) && timedOutEnds === null)
  const canWrite = acting && can.send
  const canReact = acting && can.react
  const canQuoteHere = useStore(
    s => replyAccess(s, server, root?.channel_id ?? null, canWrite, inDm).quote
  )

  if (!root || !key) return null
  const positioned = scroll.positioned
  const canDelete = (m: Message) =>
    me !== null &&
    (m.author.username === me.username ||
      (can.manage && outranksKnown(rank, memberFor(m.author.username), roles)))

  const onScroll = () => {
    scroll.onScroll()
    if (older?.loading || newer?.loading) snapEdge()
  }

  const onTop = () => {
    if (older?.loading || older?.more === false || !replies.length) return
    snapEdge()
    void loadOlderThread()
  }

  const canReply = (m: Message) => canQuoteHere && canQuote(m)
  const forwardable = (m: Message) => canUnreact && canForward(m)
  const replyTo = (m: Message) => startReply(key, m)
  const canEdit = (m: Message) => canWrite && ownEditable(m, me?.username)
  const editMsg = (m: Message) => startEdit(key, m)
  const jump = (id: number) => void jumpTo(key, id)
  const jumpMain = (id: number) => {
    const main =
      root.channel_id !== null
        ? `c${root.channel_id}`
        : root.dm_id !== null
          ? `d${root.dm_id}`
          : null
    if (!main) return
    if (!wide) closePanel()
    void jumpTo(main, id)
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

  const row = (m: Message, { first, last }: GroupPlace) => {
    const mentioned = mentionsMe(m, me?.username)
    const editing = editingId === m.id
    const actions: ToolbarAction[] = []
    if (canEdit(m) && !editing) actions.push(editAction(() => editMsg(m)))
    if (canReply(m)) actions.push(replyAction(() => replyTo(m)))
    if (forwardable(m)) actions.push(forwardAction(() => copyForward(m)))
    if (m.id !== root.id && canDelete(m))
      actions.push({
        key: 'delete',
        label: 'Delete reply (hold Shift to skip confirmation)',
        icon: Trash2,
        danger: true,
        onClick: e => store.menu.confirmDeleteMessage(m.id, e.shiftKey),
      })
    const quote = m.reply_to
    const body = (
      <>
        {m.forward ? (
          <ForwardCard m={m} canDelete={canDelete(m)} />
        ) : m.kind === 'poll' ? (
          <PollCard m={m} canVote={canWrite} />
        ) : (
          <MarkdownMessage
            message={m}
            canDelete={canDelete(m)}
            editor={editing ? <MessageEditor /> : undefined}
          />
        )}
        <ReactionBar m={m} canReact={canReact} canRemove={canUnreact} />
      </>
    )
    return (
      <div
        key={m.id}
        data-row
        data-mid={m.id}
        data-flash={flash === m.id ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        {...longPress(rowMenu(m))}
        className={`group relative px-4 ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : 'hover:bg-surface-container'}`}
      >
        {quote && (
          <ReplyPreview
            quote={quote}
            avatar={30}
            color={
              quote.author
                ? roleColor(roles, memberFor(quote.author.username)?.role_ids ?? [])
                : undefined
            }
            onJump={m.id === root.id ? jumpMain : jump}
          />
        )}
        {first ? (
          <AuthorRow
            author={m.author}
            server={server}
            size={30}
            {...authorOf(roleLook(roles, memberFor(m.author.username)?.role_ids ?? []))}
            meta={timeMeta(m.created_at)}
          >
            {body}
          </AuthorRow>
        ) : (
          <GroupedRow
            name={<ShownName user={m.author} server={server} />}
            ts={m.created_at}
            size={30}
          >
            {body}
          </GroupedRow>
        )}
        <MessageToolbar
          m={m}
          react={canReact}
          actions={actions}
          onMore={(x, y) => rowMenu(m)(x, y)}
        />
      </div>
    )
  }

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
        onClose={closePanel}
        bars={
          <>
            {wide && <SelectionBar scope={key} sheet={false} compact />}
            <BulkJobBar scope={key} />
          </>
        }
        overlays={
          <>
            {older?.loading && <OlderLoading />}
            {newer?.loading && <OlderLoading newer />}
            {detached && !newer?.loading && <PresentBar onJump={() => void jumpToPresent(key)} />}
            {!detached && positioned && fresh > 0 && (
              <PresentBar count={fresh} onJump={scroll.toBottom} />
            )}
          </>
        }
        listRef={listRef}
        contentRef={contentRef}
        onScroll={onScroll}
        head={
          positioned &&
          replies.length > 0 &&
          older?.more !== false && (
            <EdgeSentinel key={replies[0].id} root={listRef} edge="top" onVisible={onTop} />
          )
        }
        root={row(root, ALONE)}
        count={root.reply_count}
        replies={
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
                {stale && replies.length === 0 && root.reply_count > 0 && (
                  <MessageListSkeleton seed={key} variant="panel" label="Loading replies" />
                )}
                {positioned && detached && replies.length > 0 && (
                  <EdgeSentinel
                    key={`n${replies[replies.length - 1].id}`}
                    root={listRef}
                    edge="bottom"
                    onVisible={() => {
                      if (newer?.loading) return
                      snapEdge()
                      void loadNewerThread()
                    }}
                  />
                )}
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
        }
        footer={
          <>
            <TypingIndicator scope={key} server={server} bg="bg-surface-container-low" />
            {selecting && !wide ? (
              <SelectionBar scope={key} sheet />
            ) : dmOther ? (
              <BlockedComposer user={dmOther} />
            ) : (
              <MessageComposer thread />
            )}
          </>
        }
      />
    </LightboxList>
  )
}
