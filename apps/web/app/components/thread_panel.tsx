'use client'

import { useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { MessageSquareText, Trash2 } from 'lucide-react'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { ReactionBar } from './reactions'
import { readOnly } from '../lib/reactions'
import { messageRights } from '../lib/actions/message'
import { openActionMenu } from '../lib/actions/menu'
import { confirmDeleteMessage, myPerms, roleColor, threadKey, useStore } from '../lib/store'
import { Perm, hasPerm, type Message } from '../lib/types'
import { findById } from '../lib/window'
import { newSince } from '../lib/lists'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import { TypingIndicator } from './typing_indicator'
import {
  AuthorRow,
  OutboxRows,
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
import { BlockedList } from './blocking'
import { ReplyPreview } from './replies'
import { canQuote } from '../lib/replies'
import { canForward } from '../lib/forward'
import { ForwardCard, forwardAction } from './forwards'
import { PollCard } from './poll_card'
import { canEdit as ownEditable } from '../lib/sed'
import { MessageEditor, editAction } from './message_editor'
import { useMyTimeoutEnds } from './timeout_dialog'
import { BulkJobBar, Selectable, SelectionBar, openSelectionMenu } from './selection'

const EMPTY: Message[] = []

// The thread panel, whichever source fills it (instance messages, or a P2P server's): the header,
// bars above the list, the list (`head`, the root, its reply count, the replies, `tail`) and the
// composer below.
export function ThreadPanelView({
  onClose,
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
            <div className="my-2 flex items-center gap-2 px-4 text-xs text-on-surface-variant">
              <span className="h-px flex-1 bg-outline-variant" />
              {count} {count === 1 ? 'reply' : 'replies'}
              <span className="h-px flex-1 bg-outline-variant" />
            </div>
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
  const root = useStore(s => {
    if (s.panel?.kind !== 'thread') return null
    const r = s.panel.root
    const list = r.channel_id !== null ? s.messages[`c${r.channel_id}`] : undefined
    return findById(list, r.id) ?? r
  })
  const replies =
    useStore(s => (s.panel?.kind === 'thread' ? s.messages[`t${s.panel.root.id}`] : undefined)) ??
    EMPTY
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : undefined))
  const roles = detail?.roles
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const timedOutEnds = useMyTimeoutEnds(server)
  const memberFor = useMemberLookup(server)
  const people = useMemo(() => (root ? [root, ...replies] : replies), [root, replies])
  useAuthorMembers(server, usePeopleKey(people))
  const key = useStore(s => (s.panel?.kind === 'thread' ? threadKey(s.panel.root.id) : null))
  const older = useStore(s => (key ? s.older[key] : undefined))
  const newer = useStore(s => (key ? s.newer[key] : undefined))
  const stale = useStore(s => (key ? s.stale[key] === true : false))
  const focus = useStore(s => (key ? s.focus[key] : undefined))
  const outCount = useStore(s => (key ? (s.outbox[key]?.length ?? 0) : 0))
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
    if (useStore.getState().selection) useStore.getState().exitSelection()
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

  if (!root || !key) return null

  const positioned = scroll.positioned

  const canDelete = (m: Message) =>
    me !== null && (m.author.username === me.username || hasPerm(perms, Perm.DeleteMessages))

  const canUnreact = me !== null && !guest
  const canReact =
    canUnreact &&
    server !== null &&
    me.servers.some(x => x.name === server) &&
    !readOnly(detail, root.channel_id) &&
    timedOutEnds === null

  const onScroll = () => {
    scroll.onScroll()
    if (older?.loading || newer?.loading) snapEdge()
  }

  const onTop = () => {
    if (older?.loading || older?.more === false || !replies.length) return
    snapEdge()
    void loadOlderThread()
  }

  const canReply = (m: Message) => canReact && canQuote(m)
  const forwardable = (m: Message) => canUnreact && canForward(m)
  const replyTo = (m: Message) => startReply(key, m)
  const canEdit = (m: Message) => canReact && ownEditable(m, me?.username)
  const editMsg = (m: Message) => startEdit(key, m)
  const jump = (id: number) => void jumpTo(key, id)
  const jumpMain = (id: number) => {
    if (root.channel_id === null) return
    if (!wide) closePanel()
    void jumpTo(`c${root.channel_id}`, id)
  }

  const rowMenu = (m: Message) => (x: number, y: number) => {
    if (m.id !== root.id && openSelectionMenu(key, m, x, y)) return
    const react = messageRights(useStore.getState(), m, key).react
    openActionMenu(
      x,
      y,
      { kind: 'message', message: m, list: key },
      react ? reactHeader(m, x, y) : undefined
    )
  }

  const row = (m: Message) => {
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
        onClick: e => confirmDeleteMessage(m.id, e.shiftKey),
      })
    const quote = m.reply_to
    return (
      <div
        key={m.id}
        data-row
        data-mid={m.id}
        data-flash={flash === m.id ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        {...longPress(rowMenu(m))}
        className={`group relative px-4 py-1.5 ${mentioned ? mentionRowCls : 'hover:bg-surface-container'}`}
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
        <AuthorRow
          author={m.author}
          server={server}
          size={30}
          color={roleColor(roles, memberFor(m.author.username)?.role_ids ?? [])}
          meta={timeMeta(m.created_at)}
        >
          {m.forward ? (
            <ForwardCard m={m} canDelete={canDelete(m)} />
          ) : m.kind === 'poll' ? (
            <PollCard m={m} canVote={canReact} />
          ) : (
            <MarkdownMessage
              message={m}
              canDelete={canDelete(m)}
              editor={editing ? <MessageEditor /> : undefined}
            />
          )}
          <ReactionBar m={m} canReact={canReact} canRemove={canUnreact} />
        </AuthorRow>
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
      root={row(root)}
      count={root.reply_count}
      replies={
        <BlockedList
          messages={replies}
          focusId={focus?.id ?? null}
          row={m => (
            <Selectable key={m.id} m={m} scope={key}>
              {row(m)}
            </Selectable>
          )}
        />
      }
      tail={
        <>
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
          <OutboxRows msgKey={key} size={30} />
        </>
      }
      footer={
        <>
          <TypingIndicator scope={key} bg="bg-surface-container-low" />
          {selecting && !wide ? <SelectionBar scope={key} sheet /> : <MessageComposer thread />}
        </>
      }
    />
  )
}
