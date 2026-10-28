'use client'

import { useEffect, useMemo, useRef } from 'react'
import { MessageSquareText, Trash2, X } from 'lucide-react'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { ReactionBar } from './reactions'
import { readOnly } from '../lib/reactions'
import {
  confirmDeleteMessage,
  myPerms,
  roleColor,
  threadKey,
  useStore,
  type ContextMenuItem,
} from '../lib/store'
import { Perm, hasPerm, type Message } from '../lib/types'
import { findById } from '../lib/window'
import { newSince } from '../lib/lists'
import { UserAvatar } from './user_avatar'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import {
  OutboxRows,
  avatarTriggerCls,
  fmtTime,
  mentionRowCls,
  mentionsMe,
  messageCopyItems,
  nameTriggerCls,
  reactHeader,
  replyAction,
  replyMenuItem,
  useAuthorMembers,
  useMemberLookup,
  usePeopleKey,
} from './message_pane'
import { longPress, useMedia } from './context_menu'
import { profileTrigger } from './profile_card'
import {
  EdgeSentinel,
  OlderLoading,
  PresentBar,
  useChatScroll,
  useFocusMessage,
  useScrollAnchor,
} from './viewport_height'
import { useEscape } from './server_settings'
import { ReplyPreview } from './replies'
import { canQuote } from '../lib/replies'
import { canForward } from '../lib/forward'
import { ForwardCard, forwardAction, forwardMenuItem } from './forwards'
import { canEdit as ownEditable } from '../lib/sed'
import { MessageEditor, editAction, editMenuItem } from './message_editor'

const EMPTY: Message[] = []

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
  const openContextMenu = useStore(s => s.openContextMenu)
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
  useEscape(e => {
    if (!e.defaultPrevented) closePanel()
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
    !readOnly(detail, root.channel_id)

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
    const items: ContextMenuItem[] = []
    if (canEdit(m)) items.push(editMenuItem(() => editMsg(m)))
    if (canReply(m)) items.push(replyMenuItem(() => replyTo(m)))
    if (forwardable(m)) items.push(forwardMenuItem(() => copyForward(m)))
    if (m.id !== root.id && canDelete(m))
      items.push({
        label: 'Delete Message',
        danger: true,
        icon: Trash2,
        action: () => confirmDeleteMessage(m.id),
      })
    items.push(...messageCopyItems(m))
    openContextMenu(x, y, items, canReact ? reactHeader(m, x, y) : undefined)
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
        <div className="flex gap-3">
          <div className="shrink-0 pt-0.5">
            <span
              {...profileTrigger(m.author, server, false)}
              title="View profile"
              className={avatarTriggerCls}
            >
              <UserAvatar
                username={m.author.username}
                avatarKind={m.author.avatar_kind}
                avatarColor={m.author.avatar_color}
                size={30}
              />
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 items-baseline gap-2">
              <span
                {...profileTrigger(m.author, server)}
                style={{
                  color: roleColor(roles, memberFor(m.author.username)?.role_ids ?? []),
                }}
                className={`streamer min-w-0 truncate text-sm font-medium ${nameTriggerCls}`}
              >
                {m.author.display_name}
              </span>
              <span className="shrink-0 text-xs text-on-surface-variant">
                {fmtTime(m.created_at)}
              </span>
            </div>
            {m.forward ? (
              <ForwardCard m={m} canDelete={canDelete(m)} />
            ) : (
              <MarkdownMessage
                message={m}
                canDelete={canDelete(m)}
                editor={editing ? <MessageEditor /> : undefined}
              />
            )}
            <ReactionBar m={m} canReact={canReact} canRemove={canUnreact} />
          </div>
        </div>
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
    <div className="flex h-full w-full flex-col bg-surface-container-low">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
        <MessageSquareText size={18} className="text-on-surface-variant" />
        <span className="font-medium">Thread</span>
        <button
          title="Close thread"
          onClick={closePanel}
          className="ml-auto rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
        >
          <X size={18} />
        </button>
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        {older?.loading && <OlderLoading />}
        {newer?.loading && <OlderLoading newer />}
        {detached && !newer?.loading && <PresentBar onJump={() => void jumpToPresent(key)} />}
        {!detached && positioned && fresh > 0 && (
          <PresentBar count={fresh} onJump={scroll.toBottom} />
        )}
        <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-3">
          <div ref={contentRef}>
            {positioned && replies.length > 0 && older?.more !== false && (
              <EdgeSentinel key={replies[0].id} root={listRef} edge="top" onVisible={onTop} />
            )}
            {row(root)}
            <div className="my-2 flex items-center gap-2 px-4 text-xs text-on-surface-variant">
              <span className="h-px flex-1 bg-outline-variant" />
              {root.reply_count} {root.reply_count === 1 ? 'reply' : 'replies'}
              <span className="h-px flex-1 bg-outline-variant" />
            </div>
            {replies.map(row)}
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
          </div>
        </div>
      </div>
      <MessageComposer thread />
    </div>
  )
}
