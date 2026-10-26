'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  Hash,
  Menu,
  MessageSquareText,
  MessagesSquare,
  Phone,
  PhoneMissed,
  PhoneOff,
  Search,
  Trash2,
  Users,
  Video,
  Volume2,
} from 'lucide-react'
import { canModerate, memberPerms } from '../lib/rules'
import { unreadMark } from '../lib/lists'
import {
  banMenuItem,
  byUsername,
  confirmDeleteMessage,
  confirmKick,
  confirmTransfer,
  memberOf,
  myPerms,
  revokeAdminFor,
  roleColor,
  roleMenuItems,
  useStore,
  viewKey,
  type ContextMenuItem,
  type Outgoing,
} from '../lib/store'
import { Perm, hasPerm, type Member, type Message } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import StatusClock from './status_clock'
import { longPress } from './context_menu'
import { profileTrigger } from './profile_card'
import { VoiceGrid } from './voice_grid'
import {
  EdgeSentinel,
  OlderLoading,
  PresentBar,
  UnreadBar,
  useFocusMessage,
  usePinnedBottom,
  useScrollAnchor,
} from './viewport_height'

const EMPTY: Message[] = []

export const fmtTime = (ts: number) => {
  const d = new Date(ts * 1000)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
  return d.toDateString() === new Date().toDateString() ? time : `${d.toLocaleDateString()} ${time}`
}

const fmtDuration = (s: number) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

function CallDuration({ from }: { from: number }) {
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000))
  useEffect(() => {
    const id = setInterval(() => setNow(Math.floor(Date.now() / 1000)), 1000)
    return () => clearInterval(id)
  }, [])
  return <>{fmtDuration(Math.max(0, now - from))}</>
}

function CallLogRow({ message }: { message: Message }) {
  const me = useStore(s => s.me)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const openDm = useStore(s => s.openDm)
  const call = message.call
  if (!call) return null
  const ringing = call.answered_at === null && call.ended_at === null
  const active = call.answered_at !== null && call.ended_at === null
  const incoming = me !== null && me.username !== call.from
  let icon = <Phone size={14} className="shrink-0" />
  let label: ReactNode = 'Call'
  if (ringing) label = incoming ? 'Incoming call' : 'Calling…'
  else if (active && call.answered_at !== null)
    label = (
      <>
        Call · <CallDuration from={call.answered_at} />
      </>
    )
  else if (call.ended_at !== null) {
    if (call.outcome === 'completed' && call.answered_at !== null)
      label = `Call · ${fmtDuration(Math.max(0, call.ended_at - call.answered_at))}`
    else if (call.outcome === 'declined') {
      icon = <PhoneOff size={14} className="shrink-0" />
      label = 'Call declined'
    } else {
      icon = <PhoneMissed size={14} className="shrink-0" />
      label = 'Missed call'
    }
  }
  return (
    <div className="flex justify-center px-4 py-1.5">
      <div className="flex items-center gap-2 rounded-full bg-surface-container px-3 py-1 text-xs text-on-surface-variant">
        {icon}
        <span>{label}</span>
        <span className="opacity-60">{fmtTime(message.created_at)}</span>
        {ringing && incoming && (
          <span className="ml-1 flex items-center gap-1">
            <button
              title="Accept"
              onClick={() => {
                if (message.dm_id !== null) void openDm(message.dm_id)
                void acceptCall()
              }}
              className="rounded-full bg-primary p-1 text-on-primary hover:opacity-90"
            >
              <Phone size={12} />
            </button>
            <button
              title="Decline"
              onClick={declineCall}
              className="rounded-full bg-error p-1 text-on-error hover:opacity-90"
            >
              <PhoneOff size={12} />
            </button>
          </span>
        )}
      </div>
    </div>
  )
}

const EMPTY_OUT: Outgoing[] = []

const copy = (text: string) => void navigator.clipboard.writeText(text)

export const avatarTriggerCls =
  'block cursor-pointer rounded-full outline-offset-2 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-primary'
export const nameTriggerCls =
  'cursor-pointer rounded-sm outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'

export const authorKey = (messages: Message[], extra: string[] = []) =>
  [...new Set([...messages.map(m => m.author.username), ...extra])].sort().join('\n')

export function useAuthorMembers(server: string | null, key: string) {
  const ensureMembers = useStore(s => s.ensureMembers)
  const cached = useStore(s => (server ? s.memberInfo[server] !== undefined : false))
  const trim = useStore(s => (server ? (s.memberInfoTrim[server] ?? 0) : 0))
  useEffect(() => {
    if (server && key) void ensureMembers(server, key.split('\n'))
  }, [server, key, cached, trim, ensureMembers])
}

export function useMemberLookup(server: string | null) {
  const list = useStore(s => (server ? s.members[server]?.list : undefined))
  const known = useStore(s => (server ? s.memberInfo[server] : undefined))
  return useCallback(
    (username: string): Member | undefined =>
      (list ? byUsername(list).get(username) : undefined) ??
      (known && Object.hasOwn(known, username) ? (known[username] ?? undefined) : undefined),
    [list, known]
  )
}

interface RowProps {
  m: Message
  divider: boolean
  flash: boolean
  canDelete: boolean
  channel: boolean
  server: string | null
  color: string | undefined
  onMenu: (m: Message, x: number, y: number) => void
}

const MessageRow = memo(function MessageRow({
  m,
  divider,
  flash,
  canDelete,
  channel,
  server,
  color,
  onMenu,
}: RowProps) {
  const openThread = useStore(s => s.openThread)
  const mark = divider && (
    <div data-divider className="px-4 py-1" aria-hidden>
      <div className="h-0.5 rounded-full bg-error" />
    </div>
  )
  if (m.kind === 'call')
    return (
      <div data-mid={m.id}>
        {mark}
        <CallLogRow message={m} />
      </div>
    )
  return (
    <div data-mid={m.id}>
      {mark}
      <div
        {...longPress((x, y) => onMenu(m, x, y))}
        data-flash={flash ? '' : undefined}
        className="group relative flex gap-3 px-4 py-1.5 hover:bg-surface-container-low"
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
              size={36}
            />
          </span>
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-baseline gap-2">
            <span
              {...profileTrigger(m.author, server)}
              style={{ color }}
              className={`streamer min-w-0 truncate text-sm font-medium ${nameTriggerCls}`}
            >
              {m.author.display_name}
            </span>
            <span className="shrink-0 text-xs text-on-surface-variant">
              {fmtTime(m.created_at)}
            </span>
          </div>
          <MarkdownMessage message={m} canDelete={canDelete} />
          {channel && m.reply_count > 0 && (
            <button
              title="Open thread"
              onClick={() => void openThread(m)}
              className="mt-1 flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-xs font-medium text-primary hover:bg-surface-container-high"
            >
              <MessageSquareText size={12} />
              {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </div>
        <div className="pointer-events-none absolute top-1 right-3 flex gap-1 opacity-0 group-focus-within:pointer-events-auto group-focus-within:opacity-100 group-hover:pointer-events-auto group-hover:opacity-100">
          {channel && (
            <button
              title="Reply in thread"
              onClick={() => void openThread(m)}
              className="rounded-full bg-surface-container-high p-1.5 text-on-surface-variant hover:text-primary"
            >
              <MessageSquareText size={14} />
            </button>
          )}
          {canDelete && (
            <button
              title="Delete message (hold Shift to skip confirmation)"
              onClick={e => confirmDeleteMessage(m.id, e.shiftKey)}
              className="rounded-full bg-surface-container-high p-1.5 text-on-surface-variant hover:text-error"
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

export const messageCopyItems = (m: Message): ContextMenuItem[] => [
  ...(m.content.trim() ? [{ label: 'Copy Text', action: () => copy(m.content) }] : []),
  { label: 'Copy Message ID', action: () => copy(String(m.id)) },
  { label: 'Copy User ID', action: () => copy(m.author.username) },
]

export function OutboxRows({ msgKey, size = 36 }: { msgKey: string; size?: number }) {
  const me = useStore(s => s.me)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const outgoing = useStore(s => s.outbox[msgKey]) ?? EMPTY_OUT
  const retryOutgoing = useStore(s => s.retryOutgoing)
  const cancelOutgoing = useStore(s => s.cancelOutgoing)
  if (!me || !outgoing.length) return null
  return (
    <>
      {outgoing.map(o => {
        const failed = o.status === 'failed'
        return (
          <div
            key={o.tempId}
            className={`relative flex gap-3 px-4 py-1.5 ${failed ? '' : 'opacity-50'}`}
          >
            <div className="shrink-0 pt-0.5">
              <span
                {...profileTrigger(me, server, false)}
                title="View profile"
                className={avatarTriggerCls}
              >
                <UserAvatar
                  username={me.username}
                  avatarKind={me.avatar_kind}
                  avatarColor={me.avatar_color}
                  size={size}
                />
              </span>
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex min-w-0 items-baseline gap-2">
                <span
                  {...profileTrigger(me, server)}
                  className={`streamer min-w-0 truncate text-sm font-medium ${nameTriggerCls}`}
                >
                  {me.display_name}
                </span>
                <span
                  className={`shrink-0 text-xs ${failed ? 'text-error' : 'text-on-surface-variant'}`}
                >
                  {failed ? 'Failed to send' : o.status === 'sending' ? 'Sending' : 'Queued'}
                </span>
              </div>
              <MarkdownMessage message={o.msg} canDelete={false} />
              {o.pending && (
                <span className="text-xs text-on-surface-variant">{o.pending.file.name}</span>
              )}
              {failed && (
                <div className="mt-1 flex items-center gap-3 text-xs font-medium">
                  <button onClick={() => retryOutgoing(msgKey, o.tempId)} className="text-primary">
                    Retry
                  </button>
                  <button onClick={() => cancelOutgoing(msgKey, o.tempId)} className="text-error">
                    Delete
                  </button>
                </div>
              )}
            </div>
          </div>
        )
      })}
    </>
  )
}

export function MessagePane({ onMenu, onMembers }: { onMenu: () => void; onMembers: () => void }) {
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : undefined))
  const dm = useStore(s => {
    const v = s.view
    return v?.kind === 'dm' ? s.dms.find(d => d.id === v.dmId) : undefined
  })
  const messages = useStore(s => (s.view ? s.messages[viewKey(s.view)] : undefined)) ?? EMPTY
  const outCount = useStore(s => (s.view ? (s.outbox[viewKey(s.view)]?.length ?? 0) : 0))
  const anchor = useStore(s => (s.view ? s.unreadAnchor[viewKey(s.view)] : undefined))
  const older = useStore(s => (s.view ? s.older[viewKey(s.view)] : undefined))
  const newer = useStore(s => (s.view ? s.newer[viewKey(s.view)] : undefined))
  const stale = useStore(s => (s.view ? s.stale[viewKey(s.view)] === true : false))
  const focus = useStore(s => (s.view ? s.focus[viewKey(s.view)] : undefined))
  const markRead = useStore(s => s.markRead)
  const setAtBottom = useStore(s => s.setAtBottom)
  const memberServer = view?.kind === 'channel' ? view.server : null
  const memberFor = useMemberLookup(memberServer)
  useAuthorMembers(memberServer, authorKey(messages, me ? [me.username] : []))
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const loadOlder = useStore(s => s.loadOlder)
  const loadNewer = useStore(s => s.loadNewer)
  const jumpToUnread = useStore(s => s.jumpToUnread)
  const jumpToPresent = useStore(s => s.jumpToPresent)
  const dismissUnread = useStore(s => s.dismissUnread)
  const startDm = useStore(s => s.startDm)
  const grantAdmin = useStore(s => s.grantAdmin)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const openThread = useStore(s => s.openThread)
  const openSearch = useStore(s => s.openSearch)
  const uploadFile = useStore(s => s.uploadFile)
  const startCall = useStore(s => s.startCall)
  const startP2pCall = useStore(s => s.startP2pCall)
  const call = useStore(s => s.call)
  const [dragging, setDragging] = useState(false)
  const [ready, setReady] = useState<string | null>(null)
  const dragDepth = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const autoScroll = useRef(true)
  const lastScrollTop = useRef(0)
  const initialScrolled = useRef(false)
  const atBottomRef = useRef(true)

  const scope = view ? viewKey(view) : null
  const detached = newer?.more === true
  const positioned = scope !== null && ready === scope
  const snapEdge = useScrollAnchor(
    listRef,
    messages[0]?.id,
    older?.loading === true || newer?.loading === true
  )
  const ids = useMemo(() => messages.map(m => m.id), [messages])
  const mark = unreadMark(ids, anchor, older?.more !== false)
  const dividerIndex = mark.divider

  const settle = () => {
    const el = listRef.current
    if (!el) return
    lastScrollTop.current = el.scrollTop
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
    const live = bottom && !detached
    autoScroll.current = live
    atBottomRef.current = live
    setAtBottom(live)
    if (bottom && scope) {
      const last = messages[messages.length - 1]
      if (last) markRead(scope, last.id)
    }
  }

  useEffect(() => {
    autoScroll.current = true
    initialScrolled.current = false
    atBottomRef.current = true
    lastScrollTop.current = 0
  }, [view])

  useEffect(() => {
    const el = listRef.current
    if (!el || !scope) return
    if (!initialScrolled.current) {
      if (!messages.length || stale) return
      initialScrolled.current = true
      if (!focus) {
        const divider = el.querySelector<HTMLElement>('[data-divider]')
        el.scrollTop = divider ? Math.max(0, divider.offsetTop - 48) : el.scrollHeight
        settle()
      }
      setReady(scope)
      return
    }
    if (autoScroll.current && atBottomRef.current && !detached) el.scrollTop = el.scrollHeight
  }, [messages, outCount, scope, focus, detached, stale])

  const flash = useFocusMessage(listRef, scope, focus, messages, settle)

  const channel =
    view?.kind === 'channel' ? detail?.channels.find(c => c.id === view.channelId) : undefined
  const channelName = channel?.name
  const isVoice = channel?.kind === 'voice'
  usePinnedBottom(listRef, atBottomRef, isVoice)
  const dmCall =
    dm && call?.dmId === dm.id && (call.state === 'active' || call.from === me?.username)

  const onScroll = () => {
    const el = listRef.current
    if (!el || (stale && !positioned)) return
    const st = el.scrollTop
    const bottom = el.scrollHeight - st - el.clientHeight < 60
    const live = bottom && !detached
    if (live) autoScroll.current = true
    else if (st < lastScrollTop.current - 2 || detached) autoScroll.current = false
    lastScrollTop.current = st
    if (live !== atBottomRef.current) {
      atBottomRef.current = live
      setAtBottom(live)
    }
    if (bottom && scope) {
      const last = messages[messages.length - 1]
      if (last) markRead(scope, last.id)
    }
    if (older?.loading || newer?.loading) snapEdge()
  }

  const onTop = () => {
    if (older?.loading || older?.more === false || !messages.length) return
    snapEdge()
    void loadOlder()
  }

  const onBottom = () => {
    if (newer?.loading) return
    snapEdge()
    void loadNewer()
  }

  const messageMenu = (msg: Message, x: number, y: number) => {
    if (!me) {
      openContextMenu(x, y, messageCopyItems(msg))
      return
    }
    const { author } = msg
    const self = author.username === me.username
    const items: ContextMenuItem[] = [
      { label: 'Direct Message', action: () => void startDm(author.username) },
    ]
    if (view?.kind === 'channel') {
      items.unshift({ label: 'Reply in thread', action: () => void openThread(msg) })
    }
    if (view?.kind === 'channel' && !self) {
      const target = memberOf(useStore.getState(), view.server, author.username)
      if (
        hasPerm(perms, Perm.Kick) &&
        canModerate(perms, me.is_site_admin, memberPerms(target, detail?.roles ?? []))
      )
        items.push(
          {
            label: 'Kick',
            danger: true,
            action: () => confirmKick(view.server, author.username),
          },
          banMenuItem(view.server, author.username)
        )
      if (hasPerm(perms, Perm.ManageAdmins))
        items.push(
          target?.is_admin
            ? {
                label: 'Revoke Admin',
                action: () => revokeAdminFor(view.server, author.username),
              }
            : {
                label: 'Promote to Admin',
                action: () => void grantAdmin(view.server, author.username),
              },
          {
            label: 'Transfer Admin',
            action: () => confirmTransfer(view.server, author.username),
          }
        )
    }
    if (view?.kind === 'channel' && hasPerm(perms, Perm.ManageAdmins) && detail?.roles.length)
      items.push({
        label: 'Assign Role',
        action: () => openContextMenu(x, y, roleMenuItems(view.server, author.username)),
      })
    if (me.is_site_admin && !self) {
      items.push({
        label: 'Ban site-wide',
        danger: true,
        action: () => openDialog({ kind: 'ban_confirm', username: author.username }),
      })
    }
    if (canDelete(msg))
      items.push({
        label: 'Delete Message',
        danger: true,
        action: () => confirmDeleteMessage(msg.id),
      })
    items.push(...messageCopyItems(msg))
    openContextMenu(x, y, items)
  }

  const canDelete = (m: Message) =>
    me !== null &&
    (m.author.username === me.username ||
      (view?.kind === 'channel' && hasPerm(perms, Perm.DeleteMessages)))

  const menuRef = useRef(messageMenu)
  useEffect(() => {
    menuRef.current = messageMenu
  })
  const rowMenu = useCallback(
    (msg: Message, x: number, y: number) => menuRef.current(msg, x, y),
    []
  )

  return (
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
      onDragEnter={e => {
        e.preventDefault()
        if (guest || !view || isVoice || !e.dataTransfer.types.includes('Files')) return
        dragDepth.current += 1
        setDragging(true)
      }}
      onDragOver={e => e.preventDefault()}
      onDragLeave={() => {
        dragDepth.current = Math.max(0, dragDepth.current - 1)
        if (!dragDepth.current) setDragging(false)
      }}
      onDrop={e => {
        e.preventDefault()
        dragDepth.current = 0
        setDragging(false)
        if (guest || !view || isVoice) return
        const file = e.dataTransfer.files.item(0)
        if (file) uploadFile(viewKey(view), file)
      }}
    >
      <header className="flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant px-4">
        <button
          title="Menu"
          onClick={onMenu}
          className="rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
        >
          <Menu size={20} />
        </button>
        {view?.kind === 'channel' && (
          <span className="flex min-w-0 items-center gap-1.5 font-medium">
            {isVoice ? (
              <Volume2 size={18} className="shrink-0 text-on-surface-variant" />
            ) : (
              <Hash size={18} className="shrink-0 text-on-surface-variant" />
            )}
            <span className="truncate">{channelName}</span>
          </span>
        )}
        {dm && (
          <span className="flex min-w-0 items-center gap-2 font-medium">
            <span
              {...profileTrigger(dm.other, null)}
              className="-ml-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-full py-1 pr-2.5 pl-1.5 outline-offset-2 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary"
            >
              <UserAvatar
                username={dm.other.username}
                avatarKind={dm.other.avatar_kind}
                avatarColor={dm.other.avatar_color}
                size={24}
              />
              <span className="streamer truncate">{dm.other.display_name}</span>
            </span>
            {dm.is_self && (
              <span className="shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
                yourself
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {dm && !dm.is_self && !guest && (
            <>
              <button
                title="Call"
                disabled={call !== null}
                onClick={() => void startCall(dm.id, false)}
                className="rounded-full p-1.5 hover:bg-surface-container-high disabled:opacity-40"
              >
                <Phone size={20} />
              </button>
              <button
                title="Video call"
                disabled={call !== null}
                onClick={() => void startCall(dm.id, true)}
                className="rounded-full p-1.5 hover:bg-surface-container-high disabled:opacity-40"
              >
                <Video size={20} />
              </button>
              <button
                title="P2P call"
                disabled={call !== null}
                onClick={() => void startP2pCall(dm.id, false)}
                className="relative rounded-full p-1.5 hover:bg-surface-container-high disabled:opacity-40"
              >
                <Phone size={20} />
                <span className="absolute -right-1 -bottom-0.5 rounded bg-tertiary-container px-0.5 text-[8px] font-bold text-on-tertiary-container">
                  P2P
                </span>
              </button>
              <button
                title="P2P video call"
                disabled={call !== null}
                onClick={() => void startP2pCall(dm.id, true)}
                className="relative rounded-full p-1.5 hover:bg-surface-container-high disabled:opacity-40"
              >
                <Video size={20} />
                <span className="absolute -right-1 -bottom-0.5 rounded bg-tertiary-container px-0.5 text-[8px] font-bold text-on-tertiary-container">
                  P2P
                </span>
              </button>
            </>
          )}
          <StatusClock />
          {view?.kind === 'channel' && !isVoice && (
            <button
              title="Search"
              onClick={openSearch}
              className="rounded-full p-1.5 hover:bg-surface-container-high"
            >
              <Search size={20} />
            </button>
          )}
          {view?.kind === 'channel' && (
            <button
              title="Members"
              onClick={onMembers}
              className="rounded-full p-1.5 hover:bg-surface-container-high lg:hidden"
            >
              <Users size={20} />
            </button>
          )}
        </div>
      </header>
      {isVoice && view?.kind === 'channel' ? (
        <VoiceGrid channelId={view.channelId} />
      ) : (
        <>
          {dm && dmCall && (
            <div className="flex max-h-[45dvh] shrink-0 flex-col overflow-hidden border-b border-outline-variant">
              <VoiceGrid dmId={dm.id} />
            </div>
          )}
          <div className="relative flex min-h-0 flex-1 flex-col">
            {older?.loading ? (
              <OlderLoading />
            ) : (
              mark.above &&
              scope && (
                <UnreadBar
                  onJump={() => void jumpToUnread()}
                  onDismiss={() => dismissUnread(scope)}
                />
              )
            )}
            {newer?.loading && <OlderLoading newer />}
            {detached && !newer?.loading && scope && (
              <PresentBar onJump={() => void jumpToPresent(scope)} />
            )}
            <div
              ref={listRef}
              onScroll={onScroll}
              className={`flex-1 overflow-y-auto py-3 ${stale && !positioned ? 'invisible' : ''}`}
            >
              {positioned && messages.length > 0 && older?.more !== false && (
                <EdgeSentinel key={messages[0].id} root={listRef} edge="top" onVisible={onTop} />
              )}
              {!view && (
                <div className="flex h-full flex-col items-center justify-center gap-3 text-on-surface-variant">
                  <MessagesSquare size={40} />
                  <span>Select a conversation</span>
                </div>
              )}
              {view && messages.length === 0 && (
                <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-on-surface-variant opacity-70">
                  <span className="text-2xl font-semibold">No messages here yet</span>
                  <span className="text-sm">Be the first to say something.</span>
                </div>
              )}
              {messages.map((m, i) => (
                <MessageRow
                  key={m.id}
                  m={m}
                  divider={i === dividerIndex}
                  flash={flash === m.id}
                  canDelete={canDelete(m)}
                  channel={view?.kind === 'channel'}
                  server={memberServer}
                  color={roleColor(detail?.roles, memberFor(m.author.username)?.role_ids ?? [])}
                  onMenu={rowMenu}
                />
              ))}
              {positioned && detached && messages.length > 0 && (
                <EdgeSentinel
                  key={`n${messages[messages.length - 1].id}`}
                  root={listRef}
                  edge="bottom"
                  onVisible={onBottom}
                />
              )}
              {view && <OutboxRows msgKey={viewKey(view)} />}
            </div>
          </div>
          <MessageComposer />
        </>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/80 font-medium text-primary">
          Drop file to attach
        </div>
      )}
    </main>
  )
}
