'use client'

import { useEffect, useRef, useState, type ReactNode } from 'react'
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
import {
  myPerms,
  roleColor,
  roleMenuItems,
  useStore,
  viewKey,
  type ContextMenuItem,
  type Outgoing,
} from '../lib/store'
import { Perm, hasPerm, type Message } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { MarkdownMessage } from './markdown_message'
import { MessageComposer } from './message_composer'
import StatusClock from './status_clock'
import { longPress } from './context_menu'
import { VoiceGrid } from './voice_grid'

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

export function OutboxRows({ msgKey, size = 36 }: { msgKey: string; size?: number }) {
  const me = useStore(s => s.me)
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
              <UserAvatar
                username={me.username}
                avatarKind={me.avatar_kind}
                avatarColor={me.avatar_color}
                size={size}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline gap-2">
                <span className="streamer text-sm font-medium">{me.display_name}</span>
                <span className={`text-xs ${failed ? 'text-error' : 'text-on-surface-variant'}`}>
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
  const servers = useStore(s => s.servers)
  const dms = useStore(s => s.dms)
  const messages = useStore(s => (s.view ? s.messages[viewKey(s.view)] : undefined)) ?? EMPTY
  const outCount = useStore(s => (s.view ? (s.outbox[viewKey(s.view)]?.length ?? 0) : 0))
  const anchor = useStore(s => (s.view ? s.unreadAnchor[viewKey(s.view)] : undefined))
  const markRead = useStore(s => s.markRead)
  const setAtBottom = useStore(s => s.setAtBottom)
  const memberList = useStore(s =>
    s.view?.kind === 'channel' ? s.members[s.view.server]?.list : undefined
  )
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const loadOlder = useStore(s => s.loadOlder)
  const deleteMessage = useStore(s => s.deleteMessage)
  const startDm = useStore(s => s.startDm)
  const kickMember = useStore(s => s.kickMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const revokeAdmin = useStore(s => s.revokeAdmin)
  const transferAdmin = useStore(s => s.transferAdmin)
  const openDialog = useStore(s => s.openDialog)
  const openContextMenu = useStore(s => s.openContextMenu)
  const openThread = useStore(s => s.openThread)
  const openSearch = useStore(s => s.openSearch)
  const uploadFile = useStore(s => s.uploadFile)
  const startCall = useStore(s => s.startCall)
  const startP2pCall = useStore(s => s.startP2pCall)
  const call = useStore(s => s.call)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const dividerRef = useRef<HTMLDivElement>(null)
  const autoScroll = useRef(true)
  const lastScrollTop = useRef(0)
  const loadingOlder = useRef(false)
  const initialScrolled = useRef(false)
  const atBottomRef = useRef(true)

  const scope = view ? viewKey(view) : null
  const dividerIndex = anchor === undefined ? -1 : messages.findIndex(m => m.id > anchor)

  useEffect(() => {
    autoScroll.current = true
    initialScrolled.current = false
    atBottomRef.current = true
    lastScrollTop.current = 0
  }, [view])

  useEffect(() => {
    const el = listRef.current
    if (!el) return
    if (!initialScrolled.current && messages.length) {
      initialScrolled.current = true
      const divider = dividerRef.current
      el.scrollTop = divider ? Math.max(0, divider.offsetTop - 48) : el.scrollHeight
      lastScrollTop.current = el.scrollTop
      const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60
      atBottomRef.current = bottom
      setAtBottom(bottom)
      if (bottom && scope) {
        const last = messages[messages.length - 1]
        if (last) markRead(scope, last.id)
      }
      return
    }
    if (autoScroll.current && atBottomRef.current) el.scrollTop = el.scrollHeight
  }, [messages, outCount, setAtBottom, scope, markRead])

  const detail = view?.kind === 'channel' ? servers[view.server] : undefined
  const channel =
    view?.kind === 'channel' ? detail?.channels.find(c => c.id === view.channelId) : undefined
  const channelName = channel?.name
  const isVoice = channel?.kind === 'voice'
  const dm = view?.kind === 'dm' ? dms.find(d => d.id === view.dmId) : undefined
  const dmCall =
    dm && call?.dmId === dm.id && (call.state === 'active' || call.from === me?.username)

  const onScroll = () => {
    const el = listRef.current
    if (!el) return
    const st = el.scrollTop
    const bottom = el.scrollHeight - st - el.clientHeight < 60
    if (st < lastScrollTop.current - 2 && !bottom) autoScroll.current = false
    lastScrollTop.current = st
    if (bottom !== atBottomRef.current) {
      atBottomRef.current = bottom
      setAtBottom(bottom)
    }
    if (bottom && scope) {
      const last = messages[messages.length - 1]
      if (last) markRead(scope, last.id)
    }
    if (st === 0 && messages.length && !loadingOlder.current) {
      loadingOlder.current = true
      void loadOlder().finally(() => {
        loadingOlder.current = false
      })
    }
  }

  const authorMenu = (msg: Message) => (x: number, y: number) => {
    if (!me) return
    const { author } = msg
    const self = author.username === me.username
    const items: ContextMenuItem[] = [
      { label: 'Direct Message', action: () => void startDm(author.username) },
    ]
    if (view?.kind === 'channel') {
      items.unshift({ label: 'Reply in thread', action: () => void openThread(msg) })
    }
    if (view?.kind === 'channel' && !self) {
      const target = memberList?.find(m => m.username === author.username)
      if (hasPerm(perms, Perm.Kick))
        items.push({
          label: 'Kick',
          danger: true,
          action: () => void kickMember(view.server, author.username),
        })
      if (hasPerm(perms, Perm.ManageAdmins))
        items.push(
          target?.is_admin
            ? {
                label: 'Revoke Admin',
                action: () => void revokeAdmin(view.server, author.username),
              }
            : {
                label: 'Promote to Admin',
                action: () => void grantAdmin(view.server, author.username),
              },
          {
            label: 'Transfer Admin',
            action: () => void transferAdmin(view.server, author.username),
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
        label: 'Ban',
        danger: true,
        action: () => openDialog({ kind: 'ban_confirm', username: author.username }),
      })
    }
    items.push(
      {
        label: 'Copy Message ID',
        action: () => void navigator.clipboard.writeText(String(msg.id)),
      },
      {
        label: 'Copy User ID',
        action: () => void navigator.clipboard.writeText(msg.author.username),
      }
    )
    openContextMenu(x, y, items)
  }

  const canDelete = (m: Message) =>
    me !== null &&
    (m.author.username === me.username ||
      (view?.kind === 'channel' && hasPerm(perms, Perm.DeleteMessages)))

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
        if (file) uploadFile(file)
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
            <UserAvatar
              username={dm.other.username}
              avatarKind={dm.other.avatar_kind}
              avatarColor={dm.other.avatar_color}
              size={24}
            />
            <span className="streamer truncate">{dm.other.display_name}</span>
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
          <div ref={listRef} onScroll={onScroll} className="flex-1 overflow-y-auto py-3">
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
            {messages.map((m, i) => {
              const divider = i === dividerIndex && (
                <div ref={dividerRef} className="px-4 py-1" aria-hidden>
                  <div className="h-0.5 rounded-full bg-error" />
                </div>
              )
              if (m.kind === 'call')
                return (
                  <div key={m.id}>
                    {divider}
                    <CallLogRow message={m} />
                  </div>
                )
              const lp = longPress(authorMenu(m))
              return (
                <div key={m.id}>
                  {divider}
                  <div className="group relative flex gap-3 px-4 py-1.5 hover:bg-surface-container-low">
                    <div className="shrink-0 pt-0.5" {...lp}>
                      <UserAvatar
                        username={m.author.username}
                        avatarKind={m.author.avatar_kind}
                        avatarColor={m.author.avatar_color}
                        size={36}
                      />
                    </div>
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-2">
                        <span
                          {...lp}
                          style={{
                            ...lp.style,
                            color: roleColor(
                              detail?.roles,
                              memberList?.find(x => x.username === m.author.username)?.role_ids ??
                                []
                            ),
                          }}
                          className="streamer cursor-default text-sm font-medium"
                        >
                          {m.author.display_name}
                        </span>
                        <span className="text-xs text-on-surface-variant">
                          {fmtTime(m.created_at)}
                        </span>
                      </div>
                      <MarkdownMessage message={m} canDelete={canDelete(m)} />
                      {view?.kind === 'channel' && m.reply_count > 0 && (
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
                    <div className="invisible absolute top-1 right-3 flex gap-1 group-hover:visible">
                      {view?.kind === 'channel' && (
                        <button
                          title="Reply in thread"
                          onClick={() => void openThread(m)}
                          className="rounded-full bg-surface-container-high p-1.5 text-on-surface-variant hover:text-primary"
                        >
                          <MessageSquareText size={14} />
                        </button>
                      )}
                      {canDelete(m) && (
                        <button
                          title="Delete message"
                          onClick={() => void deleteMessage(m.id)}
                          className="rounded-full bg-surface-container-high p-1.5 text-on-surface-variant hover:text-error"
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              )
            })}
            {view && <OutboxRows msgKey={viewKey(view)} />}
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
