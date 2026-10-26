'use client'

import { useEffect, useRef } from 'react'
import { MessageSquareText, Trash2, X } from 'lucide-react'
import { myPerms, roleColor, useStore, type ContextMenuItem } from '../lib/store'
import { Perm, hasPerm, type Message } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import {
  OLDER_THRESHOLD,
  OutboxRows,
  authorKey,
  avatarTriggerCls,
  fmtTime,
  messageCopyItems,
  nameTriggerCls,
  useAuthorMembers,
  useMemberLookup,
} from './message_pane'
import { longPress } from './context_menu'
import { profileTrigger } from './profile_card'
import { OlderLoading, usePinnedBottom, usePrependAnchor } from './viewport_height'

const EMPTY: Message[] = []

export default function ThreadPanel() {
  const root = useStore(s => {
    if (s.panel?.kind !== 'thread') return null
    const r = s.panel.root
    const list = r.channel_id !== null ? s.messages[`c${r.channel_id}`] : undefined
    return list?.find(m => m.id === r.id) ?? r
  })
  const replies =
    useStore(s => (s.panel?.kind === 'thread' ? s.messages[`t${s.panel.root.id}`] : undefined)) ??
    EMPTY
  const me = useStore(s => s.me)
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const roles = useStore(s =>
    s.view?.kind === 'channel' ? s.servers[s.view.server]?.roles : undefined
  )
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const memberFor = useMemberLookup(server)
  useAuthorMembers(server, authorKey(root ? [root, ...replies] : replies))
  const older = useStore(s =>
    s.panel?.kind === 'thread' ? s.older[`t${s.panel.root.id}`] : undefined
  )
  const outCount = useStore(s =>
    s.panel?.kind === 'thread' ? (s.outbox[`t${s.panel.root.id}`]?.length ?? 0) : 0
  )
  const closePanel = useStore(s => s.closePanel)
  const loadOlderThread = useStore(s => s.loadOlderThread)
  const deleteMessage = useStore(s => s.deleteMessage)
  const openContextMenu = useStore(s => s.openContextMenu)
  const listRef = useRef<HTMLDivElement>(null)
  const stickBottom = useRef(true)
  const rootId = root?.id
  const snapOlder = usePrependAnchor(listRef, replies[0]?.id)

  useEffect(() => {
    stickBottom.current = true
  }, [rootId])

  useEffect(() => {
    const el = listRef.current
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight
  }, [replies, outCount])

  usePinnedBottom(listRef, stickBottom, rootId)

  if (!root) return null

  const canDelete = (m: Message) =>
    me !== null && (m.author.username === me.username || hasPerm(perms, Perm.DeleteMessages))

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    stickBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    if (older?.loading) snapOlder()
    else if (el.scrollTop < OLDER_THRESHOLD && replies.length && older?.more !== false) {
      snapOlder()
      void loadOlderThread()
    }
  }

  const rowMenu = (m: Message) => (x: number, y: number) => {
    const items: ContextMenuItem[] = []
    if (m.id !== root.id && canDelete(m))
      items.push({
        label: 'Delete Message',
        danger: true,
        action: () => void deleteMessage(m.id),
      })
    items.push(...messageCopyItems(m))
    openContextMenu(x, y, items)
  }

  const row = (m: Message) => {
    return (
      <div
        key={m.id}
        data-mid={m.id}
        {...longPress(rowMenu(m))}
        className="group relative flex gap-3 px-4 py-1.5 hover:bg-surface-container"
      >
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
          <div className="flex items-baseline gap-2">
            <span
              {...profileTrigger(m.author, server)}
              style={{
                color: roleColor(roles, memberFor(m.author.username)?.role_ids ?? []),
              }}
              className={`streamer text-sm font-medium ${nameTriggerCls}`}
            >
              {m.author.display_name}
            </span>
            <span className="text-xs text-on-surface-variant">{fmtTime(m.created_at)}</span>
          </div>
          <MarkdownMessage message={m} canDelete={canDelete(m)} />
        </div>
        {m.id !== root.id && canDelete(m) && (
          <button
            title="Delete reply"
            onClick={() => void deleteMessage(m.id)}
            className="pointer-events-none absolute top-1 right-3 rounded-full bg-surface-container-high p-1.5 text-on-surface-variant opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100 hover:text-error"
          >
            <Trash2 size={14} />
          </button>
        )}
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
        <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-3">
          {row(root)}
          <div className="my-2 flex items-center gap-2 px-4 text-xs text-on-surface-variant">
            <span className="h-px flex-1 bg-outline-variant" />
            {root.reply_count} {root.reply_count === 1 ? 'reply' : 'replies'}
            <span className="h-px flex-1 bg-outline-variant" />
          </div>
          {replies.map(row)}
          <OutboxRows msgKey={`t${root.id}`} size={30} />
        </div>
      </div>
      <MessageComposer thread />
    </div>
  )
}
