'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Clock,
  Hash,
  Lock,
  Menu,
  MoreVertical,
  MessageSquareText,
  MessagesSquare,
  Phone,
  PhoneCall,
  PhoneIncoming,
  PhoneMissed,
  PhoneOff,
  PhoneOutgoing,
  Reply,
  Search,
  Trash2,
  Users,
  Video,
  VideoOff,
  Volume2,
  type LucideIcon,
} from 'lucide-react'
import { lastOwn, newSince, unreadMark } from '../lib/lists'
import { escapeMarksRead } from '../lib/follow'
import { mentionLookups, mentionsUser } from '../lib/mentions'
import { readOnly } from '../lib/reactions'
import { slowTitle } from '../lib/slowmode'
import { canQuote, repliesToMe } from '../lib/replies'
import { messageRights, replyAccess } from '../lib/actions/message'
import { openActionMenu, useHasMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import {
  byUsername,
  confirmDeleteMessage,
  myPerms,
  roleColor,
  userRefFor,
  useStore,
  viewKey,
  allPings,
  groupMentionsMe,
  type ContextMenuOptions,
  type Outgoing,
} from '../lib/store'
import { Perm, hasPerm, type CallLog, type Member, type Message, type UserRef } from '../lib/types'
import { callTone, type CallTone } from '../lib/voice_layout'
import { callLogInfo } from '../lib/call_choice'
import { UserAvatar } from './user_avatar'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { MarkdownMessage } from './markdown_message'
import { TypingIndicator } from './typing_indicator'
import { MessageComposer } from './message_composer'
import StatusClock from './status_clock'
import { InboxButton } from './inbox'
import { longPress, useMedia } from './context_menu'
import { profileTrigger } from './profile_card'
import { useCallShare, VoiceGrid } from './voice_grid'
import { ChannelTopic } from './channel_topic'
import { CallButtons, CallDuration, DirectBadge } from './call_buttons'
import {
  EdgeSentinel,
  OlderLoading,
  PresentBar,
  UnreadBar,
  useChatScroll,
  useFocusMessage,
  useScrollAnchor,
} from './viewport_height'
import { Masked, useEscape, useOwnServer } from './ui'
import { FitName, NameWithUsername } from './display_name'
import { showsUsername } from '../lib/display_name'
import { PingBadge, pingLabel } from './ping_badge'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { groupPadCls, gutterTimeCls } from './grouped_row'
import { QuickReactions, ReactionBar, rowAt } from './reactions'
import { ReplyPreview } from './replies'
import { MessageEditor, editAction } from './message_editor'
import { canEdit as ownEditable } from '../lib/sed'
import { canForward } from '../lib/forward'
import { ForwardCard, forwardAction } from './forwards'
import { PinNotice, PinsButton, PinsWindow } from './pins'
import { PollCard } from './poll_card'
import { SystemNotice } from './system_messages'
import { useMyTimeoutEnds } from './timeout_dialog'
import { isNotice, isSystem } from '../lib/system_messages'
import { MessageTime, ShortTime } from './timestamp'
import { messagePlaces, type GroupPlace } from '../lib/message_groups'
import { BlockedComposer, BlockedList } from './blocking'
import {
  BulkJobBar,
  SelectButton,
  Selectable,
  SelectionBar,
  openSelectionMenu,
  useSelectionKeys,
} from './selection'
import { p2pMarkAll } from '../lib/p2p/app'

export { groupPadCls } from './grouped_row'

const EMPTY: Message[] = []

const callIcon = (tone: CallTone, video: boolean, incoming: boolean): LucideIcon => {
  if (video) return tone === 'missed' || tone === 'declined' ? VideoOff : Video
  switch (tone) {
    case 'ringing':
      return incoming ? PhoneIncoming : PhoneOutgoing
    case 'active':
      return PhoneCall
    case 'missed':
      return PhoneMissed
    case 'declined':
      return PhoneOff
    case 'ended':
      return incoming ? PhoneIncoming : PhoneOutgoing
  }
}

function CallLogRow({ message }: { message: Message }) {
  const me = useStore(s => s.me)
  const dms = useStore(s => s.dms)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const openDm = useStore(s => s.openDm)
  const call = message.call
  if (!call) return null
  const tone = callTone(call)
  const incoming = me !== null && me.username !== call.from
  const caller = userRefFor(useStore.getState(), call.from)
  const other = dms.find(d => d.id === message.dm_id)?.other
  const name = (u: UserRef | undefined) => (
    <span className="streamer font-medium text-on-surface">
      {u ? <NameWithUsername user={u} /> : 'Someone'}
    </span>
  )
  const status: ReactNode =
    tone === 'ringing' ? (
      incoming ? (
        <>{name(caller)} is calling you</>
      ) : (
        <>Calling {name(other)}…</>
      )
    ) : tone === 'active' ? (
      <>In progress</>
    ) : null
  return (
    <CallLogLine
      call={call}
      me={me?.username ?? null}
      time={message.created_at}
      status={status}
      badge={call.p2p === true ? <DirectBadge /> : null}
      live={
        tone === 'active' &&
        call.answered_at !== null && (
          <span className="flex items-center gap-1 rounded-full bg-status-green/15 px-2 py-0.5 text-xs font-medium text-status-green tabular-nums">
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-status-green" />
            <CallDuration from={call.answered_at} />
          </span>
        )
      }
    >
      {tone === 'ringing' && incoming && (
        <span className="flex items-center gap-1.5">
          <button
            title="Accept"
            aria-label="Accept"
            onClick={() => {
              if (message.dm_id !== null) void openDm(message.dm_id)
              void acceptCall()
            }}
            className="flex items-center gap-1 rounded-full bg-status-green px-2.5 py-1 text-xs font-medium text-surface outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <Phone size={12} />
            Accept
          </button>
          <button
            title="Decline"
            aria-label="Decline"
            onClick={declineCall}
            className="flex items-center gap-1 rounded-full bg-danger px-2.5 py-1 text-xs font-medium text-on-danger outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary"
          >
            <PhoneOff size={12} />
            Decline
          </button>
        </span>
      )}
    </CallLogLine>
  )
}

// One call log row: icon by kind and direction, "Voice call"/"Video call", the connection badge,
// the outcome (or `status` while it rings or runs), the duration and the time. Instance and P2P
// conversations both use it.
export function CallLogLine({
  call,
  me,
  time,
  status,
  badge,
  live,
  children,
}: {
  call: CallLog
  me: string | null
  time: number
  status?: ReactNode
  badge?: ReactNode
  live?: ReactNode
  children?: ReactNode
}) {
  const tone = callTone(call)
  const incoming = me !== null && me !== call.from
  const info = callLogInfo(call, me)
  const Icon = callIcon(tone, info.video, incoming)
  const running = tone === 'ringing' || tone === 'active'
  const iconCls = running
    ? 'text-status-green'
    : info.alert
      ? 'text-error'
      : 'text-on-surface-variant'
  const direction = `${incoming ? 'Incoming' : 'Outgoing'} ${info.label.toLowerCase()}`
  return (
    <div data-call-row className="flex items-center gap-3 px-4 py-1 hover:bg-surface-container-low">
      <span
        role="img"
        title={direction}
        aria-label={direction}
        className={`flex w-9 shrink-0 justify-center ${iconCls}`}
      >
        <Icon size={18} className={tone === 'ringing' ? 'motion-safe:animate-pulse' : ''} />
      </span>
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-on-surface-variant">
        <span className="font-medium text-on-surface">{info.label}</span>
        {badge}
        <span aria-hidden>·</span>
        <span className="min-w-0">
          {status ?? (
            <span className={info.alert ? 'font-medium text-error' : ''}>{info.outcome}</span>
          )}
        </span>
        {info.duration !== null && (
          <>
            <span aria-hidden>·</span>
            <span className="tabular-nums">{info.duration}</span>
          </>
        )}
        {live}
        <MessageTime ts={time} className="text-xs opacity-70" />
        {children}
      </div>
    </div>
  )
}

const EMPTY_OUT: Outgoing[] = []

export const avatarTriggerCls =
  'block cursor-pointer rounded-full outline-offset-2 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-primary'
export const nameTriggerCls =
  'cursor-pointer rounded-sm outline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-primary'
// Avatar on the left; name and `meta` (the time) above `children` on the right.
export function AuthorRow({
  author,
  server,
  size,
  color,
  meta,
  children,
}: {
  author: UserRef
  server: string | null
  size: number
  color?: string
  meta: ReactNode
  children: ReactNode
}) {
  return (
    <div className="flex gap-3">
      <div className="shrink-0 pt-0.5">
        <span
          {...profileTrigger(author, server, false)}
          title="View profile"
          className={avatarTriggerCls}
        >
          <UserAvatar
            username={author.username}
            avatarKind={author.avatar_kind}
            avatarColor={author.avatar_color}
            size={size}
          />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
          <FitName
            user={author}
            {...profileTrigger(author, server)}
            style={{ color }}
            className={`streamer min-w-0 truncate text-sm font-medium ${nameTriggerCls}`}
          />
          {isWebhookAuthor(author.username) && <WebhookBadge />}
          {meta}
        </div>
        {children}
      </div>
    </div>
  )
}

// A row that continues its author's group: the author for screen readers only, and hours and
// minutes in the avatar's place while the row is hovered or holds keyboard focus. A `status`
// (a send not delivered yet) takes the time's place and always shows.
export function GroupedRow({
  name,
  ts,
  size,
  status,
  children,
}: {
  name: ReactNode
  ts: number
  size: number
  status?: ReactNode
  children: ReactNode
}) {
  return (
    <div data-grouped className="flex gap-3">
      <span className="streamer sr-only">{name}</span>
      <div className="relative shrink-0" style={{ width: size }}>
        {status ? (
          <span className={gutterStatusCls}>{status}</span>
        ) : (
          <ShortTime ts={ts} className={gutterTimeCls} />
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  )
}

const gutterStatusCls =
  'absolute top-0 left-1/2 flex h-[22.75px] -translate-x-1/2 items-center text-on-surface-variant'

// The other person in a DM's header: avatar and name, opening their profile.
export function DmPeer({ other }: { other: UserRef }) {
  return (
    <span
      {...profileTrigger(other, null)}
      className="-ml-1.5 flex min-w-0 cursor-pointer items-center gap-2 rounded-full py-1 pr-2.5 pl-1.5 outline-offset-2 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary"
    >
      <span className={`flex shrink-0 ${showsUsername(other) ? 'max-sm:hidden' : ''}`.trim()}>
        <UserAvatar
          username={other.username}
          avatarKind={other.avatar_kind}
          avatarColor={other.avatar_color}
          size={24}
        />
      </span>
      <span className="streamer truncate">
        <NameWithUsername user={other} />
      </span>
    </span>
  )
}

export const timeMeta = (ts: number) => (
  <MessageTime ts={ts} className="shrink-0 text-xs text-on-surface-variant" />
)

const authorKey = (messages: Message[], extra: string[] = []) =>
  [...new Set([...messages.map(m => m.author.username), ...extra])].sort().join('\n')

const mentionedNames = (messages: Message[]) =>
  messages.flatMap(m => [
    ...(m.content.includes('@') ? mentionLookups(m.content) : []),
    ...(m.reply_to?.author ? [m.reply_to.author.username] : []),
  ])

// Authors plus everyone the messages may mention, so mention pills can show display names.
export const usePeopleKey = (messages: Message[], extra: string[] = []) => {
  const mentioned = useMemo(() => mentionedNames(messages), [messages])
  return authorKey(messages, [...extra, ...mentioned])
}

export const mentionRowCls =
  'bg-primary/8 before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-primary hover:bg-primary/12'

// Forwarded text is a copy of someone else's words: its mentions never highlight or ping.
export const mentionsMe = (m: Message, me: string | undefined) =>
  me !== undefined &&
  m.author.username !== me &&
  ((!m.forward && mentionsUser(m.content, me)) || repliesToMe(m, me))

export const replyAction = (onClick: () => void): ToolbarAction => ({
  key: 'reply',
  label: 'Reply',
  icon: Reply,
  onClick,
})

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

const unreadDivider = (
  <div data-divider className="px-4 py-1" aria-hidden>
    <div className="h-0.5 rounded-full bg-error" />
  </div>
)

interface RowProps {
  m: Message
  // Its place in its author's group: only the first row shows the avatar, name and time.
  first: boolean
  last: boolean
  mentioned: boolean
  divider: boolean
  flash: boolean
  canDelete: boolean
  canReact: boolean
  canUnreact: boolean
  canReply: boolean
  canThread: boolean
  canEdit: boolean
  canForward: boolean
  editing: boolean
  channel: boolean
  server: string | null
  color: string | undefined
  quoteColor: string | undefined
  onMenu: (m: Message, x: number, y: number) => void
  onReply: (m: Message) => void
  onEdit: (m: Message) => void
  onJump: (id: number) => void
}

const MessageRow = memo(function MessageRow({
  m,
  first,
  last,
  mentioned,
  divider,
  flash,
  canDelete,
  canReact,
  canUnreact,
  canReply,
  canThread,
  canEdit,
  canForward,
  editing,
  channel,
  server,
  color,
  quoteColor,
  onMenu,
  onReply,
  onEdit,
  onJump,
}: RowProps) {
  const openThread = useStore(s => s.openThread)
  const copyForward = useStore(s => s.copyForward)
  const actions: ToolbarAction[] = []
  if (canEdit && !editing) actions.push(editAction(() => onEdit(m)))
  if (canReply && canQuote(m)) actions.push(replyAction(() => onReply(m)))
  if (canForward) actions.push(forwardAction(() => copyForward(m)))
  if (canThread && !isNotice(m))
    actions.push({
      key: 'thread',
      label: 'Reply in thread',
      icon: MessageSquareText,
      onClick: () => void openThread(m),
    })
  if (canDelete)
    actions.push({
      key: 'delete',
      label: 'Delete message (hold Shift to skip confirmation)',
      icon: Trash2,
      danger: true,
      onClick: e => confirmDeleteMessage(m.id, e.shiftKey),
    })
  const mark = divider && unreadDivider
  if (m.kind === 'pin') return <PinNotice m={m} server={server} divider={mark} onMenu={onMenu} />
  if (isSystem(m)) return <SystemNotice m={m} server={server} divider={mark} onMenu={onMenu} />
  if (m.kind === 'call')
    return (
      <div data-row data-mid={m.id}>
        {mark}
        <CallLogRow message={m} />
      </div>
    )
  const body = (
    <>
      {m.forward ? (
        <ForwardCard m={m} canDelete={canDelete} />
      ) : m.kind === 'poll' ? (
        <PollCard m={m} canVote={canReact} />
      ) : (
        <MarkdownMessage
          message={m}
          canDelete={canDelete}
          editor={editing ? <MessageEditor /> : undefined}
        />
      )}
      <ReactionBar m={m} canReact={canReact} canRemove={canUnreact} />
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
    </>
  )
  return (
    <div data-row data-mid={m.id}>
      {mark}
      <div
        {...longPress((x, y) => onMenu(m, x, y))}
        data-flash={flash ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        className={`group relative px-4 ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : 'hover:bg-surface-container-low'}`}
      >
        {m.reply_to && (
          <ReplyPreview quote={m.reply_to} avatar={36} color={quoteColor} onJump={onJump} />
        )}
        {first ? (
          <AuthorRow
            author={m.author}
            server={server}
            size={36}
            color={color}
            meta={timeMeta(m.created_at)}
          >
            {body}
          </AuthorRow>
        ) : (
          <GroupedRow name={<NameWithUsername user={m.author} />} ts={m.created_at} size={36}>
            {body}
          </GroupedRow>
        )}
        <MessageToolbar
          m={m}
          react={canReact}
          actions={actions}
          onMore={(x, y) => onMenu(m, x, y)}
        />
      </div>
    </div>
  )
})

export const reactHeader = (m: Message, x: number, y: number): ContextMenuOptions => ({
  header: <QuickReactions m={m} anchor={rowAt(x, y)} />,
})

const outgoingLabel = (status: Outgoing['status']) =>
  status === 'failed' ? 'Failed to send' : status === 'sending' ? 'Sending' : 'Queued'

// One of my sends on its way: a header row with its status, or dimmed under the group it joins.
export function OutgoingRow({
  o,
  author,
  server,
  place,
  size,
  onJump,
  onRetry,
  onCancel,
}: {
  o: Outgoing
  author: UserRef
  server: string | null
  place: GroupPlace
  size: number
  onJump: (id: number) => void
  onRetry: () => void
  onCancel: () => void
}) {
  const failed = o.status === 'failed'
  const label = outgoingLabel(o.status)
  const body = (
    <>
      {o.msg.forward ? (
        <ForwardCard m={o.msg} canDelete={false} sending />
      ) : (
        <MarkdownMessage message={o.msg} canDelete={false} />
      )}
      {o.pending && <span className="text-xs text-on-surface-variant">{o.pending.file.name}</span>}
      {failed && (
        <div className="mt-1 flex items-center gap-3 text-xs font-medium">
          <button onClick={onRetry} className="text-primary">
            Retry
          </button>
          <button onClick={onCancel} className="text-error">
            Delete
          </button>
        </div>
      )}
    </>
  )
  return (
    <div
      className={`group relative px-4 ${groupPadCls(place.first, place.last)} ${failed ? '' : 'opacity-50'}`}
    >
      {o.msg.reply_to && <ReplyPreview quote={o.msg.reply_to} avatar={size} onJump={onJump} />}
      {place.first ? (
        <AuthorRow
          author={author}
          server={server}
          size={size}
          meta={
            <span
              className={`shrink-0 text-xs ${failed ? 'text-error' : 'text-on-surface-variant'}`}
            >
              {label}
            </span>
          }
        >
          {body}
        </AuthorRow>
      ) : (
        <GroupedRow name={<NameWithUsername user={author} />} ts={o.msg.created_at} size={size}>
          <span className="sr-only">{label}</span>
          {body}
        </GroupedRow>
      )}
    </div>
  )
}

const ALONE: GroupPlace = { first: true, last: true }

// My sends on their way below a list; `places` are theirs from the list's grouping.
export function OutboxRows({
  msgKey,
  outgoing,
  places,
  size = 36,
}: {
  msgKey: string
  outgoing: readonly Outgoing[]
  places: readonly GroupPlace[]
  size?: number
}) {
  const me = useStore(s => s.me)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const retryOutgoing = useStore(s => s.retryOutgoing)
  const cancelOutgoing = useStore(s => s.cancelOutgoing)
  const jumpTo = useStore(s => s.jumpTo)
  const jump = (id: number) => void jumpTo(msgKey, id)
  if (!me || !outgoing.length) return null
  return (
    <>
      {outgoing.map((o, i) => (
        <OutgoingRow
          key={o.tempId}
          o={o}
          author={me}
          server={server}
          place={places[i] ?? ALONE}
          size={size}
          onJump={jump}
          onRetry={() => retryOutgoing(msgKey, o.tempId)}
          onCancel={() => cancelOutgoing(msgKey, o.tempId)}
        />
      ))}
    </>
  )
}

export const HEADER_MORE = 'header-more'

// The header actions that fold into one menu when the header is narrow.
export function HeaderMore({ scope, search }: { scope: string | null; search: boolean }) {
  const target: Target = { kind: 'header', list: scope, search }
  const open = useStore(s => s.contextMenu?.owner === HEADER_MORE)
  const has = useHasMenu(target)
  if (!has) return null
  return (
    <button
      title="More"
      aria-label="More"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        openActionMenu(r.right, r.bottom + 4, target, { owner: HEADER_MORE })
      }}
      className="rounded-full p-1.5 hover:bg-surface-container-high @sm:hidden"
    >
      <MoreVertical size={20} />
    </button>
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
  const outgoing = useStore(s => (s.view ? s.outbox[viewKey(s.view)] : undefined)) ?? EMPTY_OUT
  const outCount = outgoing.length
  const anchor = useStore(s => (s.view ? s.unreadAnchor[viewKey(s.view)] : undefined))
  const older = useStore(s => (s.view ? s.older[viewKey(s.view)] : undefined))
  const newer = useStore(s => (s.view ? s.newer[viewKey(s.view)] : undefined))
  const stale = useStore(s => (s.view ? s.stale[viewKey(s.view)] === true : false))
  const focus = useStore(s => (s.view ? s.focus[viewKey(s.view)] : undefined))
  const markRead = useStore(s => s.markRead)
  const menuPings = useStore(allPings)
  const memberServer = view?.kind === 'channel' ? view.server : null
  const memberFor = useMemberLookup(memberServer)
  useAuthorMembers(memberServer, usePeopleKey(messages, me ? [me.username] : []))
  const perms = useStore(s => (s.view?.kind === 'channel' ? myPerms(s, s.view.server) : 0))
  const loadOlder = useStore(s => s.loadOlder)
  const loadNewer = useStore(s => s.loadNewer)
  const jumpToUnread = useStore(s => s.jumpToUnread)
  const jumpToPresent = useStore(s => s.jumpToPresent)
  const jumpTo = useStore(s => s.jumpTo)
  const startReply = useStore(s => s.startReply)
  const startEdit = useStore(s => s.startEdit)
  const editingId = useStore(s =>
    s.editing && s.view && s.editing.key === viewKey(s.view) ? s.editing.id : null
  )
  const dismissUnread = useStore(s => s.dismissUnread)
  const askMarkAllRead = useStore(s => s.askMarkAllRead)
  const openSearch = useStore(s => s.openSearch)
  const uploadFile = useStore(s => s.uploadFile)
  const canAttach = useStore(s => s.settings.asset_uploads || s.settings.p2p_attachments)
  const call = useStore(s => s.call)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const ownServer = useOwnServer(view?.kind === 'channel' ? view.server : null)

  const channel =
    view?.kind === 'channel' ? detail?.channels.find(c => c.id === view.channelId) : undefined
  const channelName = channel?.name
  const isVoice = channel?.kind === 'voice'
  const scope = view && !isVoice ? viewKey(view) : null
  const detached = newer?.more === true
  const snapEdge = useScrollAnchor(
    listRef,
    messages[0]?.id,
    older?.loading === true || newer?.loading === true
  )
  const ids = useMemo(() => messages.map(m => m.id), [messages])
  const myName = me?.username
  const groupIds = useStore(s =>
    messages
      .filter(m => groupMentionsMe(s, m))
      .map(m => m.id)
      .join(',')
  )
  const mentionedIds = useMemo(
    () =>
      new Set([
        ...messages.filter(m => mentionsMe(m, myName)).map(m => m.id),
        ...(groupIds ? groupIds.split(',').map(Number) : []),
      ]),
    [messages, myName, groupIds]
  )
  const mark = unreadMark(ids, anchor, older?.more !== false, lastOwn(messages, me?.username))
  const dividerIndex = mark.divider
  const places = useMemo(
    () =>
      messagePlaces(
        messages,
        new Set(detached ? [dividerIndex, messages.length] : [dividerIndex]),
        outgoing
      ),
    [messages, dividerIndex, detached, outgoing]
  )

  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: messages.length,
    lastId: messages[messages.length - 1]?.id,
    stale,
    focus: focus !== undefined,
    detached,
    outCount,
    onBottom: () => {
      const last = messages[messages.length - 1]
      if (last && scope) markRead(scope, last.id)
    },
  })
  const positioned = scroll.positioned
  const fresh = newSince(messages, scroll.leftAt, me?.username)

  const flash = useFocusMessage(listRef, scope, focus, messages, scroll.settle)
  const threadScope = useStore(s => (s.panel?.kind === 'thread' ? `t${s.panel.root.id}` : null))
  useSelectionKeys(scope, [scope, threadScope], threadScope)
  const selecting = useStore(s => scope !== null && s.selection?.scope === scope)
  const wide = useMedia('(min-width: 768px)')
  useEscape(e => {
    if (useStore.getState().selection) {
      useStore.getState().exitSelection()
      return
    }
    if (guest || !escapeMarksRead(e)) return
    if (e.shiftKey) askMarkAllRead(p2pMarkAll())
    else if (scope) dismissUnread(scope)
  }, 'stage')

  const otherBlocked = useStore(s => (dm ? s.blocked[dm.other.username] === true : false))
  const dmCall =
    dm && call?.dmId === dm.id && (call.state === 'active' || call.from === me?.username)
  const callShare = useCallShare(dm?.id ?? -1)

  const onScroll = () => {
    scroll.onScroll()
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
    if (!scope || openSelectionMenu(scope, msg, x, y)) return
    const react = !isNotice(msg) && messageRights(useStore.getState(), msg, scope).react
    openActionMenu(
      x,
      y,
      { kind: 'message', message: msg, list: scope },
      react ? reactHeader(msg, x, y) : undefined
    )
  }

  const canUnreact = me !== null && !guest
  const timedOutEnds = useMyTimeoutEnds(view?.kind === 'channel' ? view.server : null)
  const canReact =
    canUnreact &&
    (view?.kind === 'dm' ||
      (view?.kind === 'channel' &&
        me.servers.some(x => x.name === view.server) &&
        !readOnly(detail, view.channelId) &&
        timedOutEnds === null))
  const replies = useStore(
    useShallow(s =>
      replyAccess(s, memberServer, view?.kind === 'channel' ? view.channelId : null, canReact)
    )
  )

  const canDelete = (m: Message) =>
    me !== null &&
    (m.author.username === me.username ||
      (view?.kind === 'channel' && hasPerm(perms, Perm.DeleteMessages)))

  const canEdit = (m: Message) => canReact && ownEditable(m, me?.username)

  const forwardable = (m: Message) => canUnreact && canForward(m)

  const replyTo = (msg: Message) => {
    if (scope) startReply(scope, msg)
  }

  const editMsg = (msg: Message) => {
    if (scope) startEdit(scope, msg)
  }

  const menuRef = useRef(messageMenu)
  const replyRef = useRef(replyTo)
  const editRef = useRef(editMsg)
  useEffect(() => {
    menuRef.current = messageMenu
    replyRef.current = replyTo
    editRef.current = editMsg
  })
  const rowMenu = useCallback(
    (msg: Message, x: number, y: number) => menuRef.current(msg, x, y),
    []
  )
  const rowReply = useCallback((msg: Message) => replyRef.current(msg), [])
  const rowEdit = useCallback((msg: Message) => editRef.current(msg), [])
  const rowJump = useCallback(
    (id: number) => {
      if (scope) void jumpTo(scope, id)
    },
    [scope, jumpTo]
  )

  return (
    <main
      className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
      onDragEnter={e => {
        e.preventDefault()
        if (
          guest ||
          !view ||
          isVoice ||
          !canAttach ||
          timedOutEnds !== null ||
          !e.dataTransfer.types.includes('Files')
        )
          return
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
        if (guest || !view || isVoice || !canAttach || timedOutEnds !== null) return
        const file = e.dataTransfer.files.item(0)
        if (file) uploadFile(viewKey(view), file)
      }}
    >
      <header className="@container flex h-14 shrink-0 items-center gap-3 border-b border-outline-variant px-4">
        <button
          title={menuPings ? `Menu, ${pingLabel(menuPings)}` : 'Menu'}
          aria-label="Menu"
          onClick={onMenu}
          className="relative rounded-full p-1.5 hover:bg-surface-container-high md:hidden"
        >
          <Menu size={20} />
          <PingBadge
            count={menuPings}
            className="absolute -top-1 -right-1.5 border-2 border-surface"
          />
        </button>
        {view?.kind === 'channel' && (
          <div className="flex min-w-0 flex-1 flex-col md:flex-row md:items-center md:gap-3">
            <span
              className={`flex max-w-full min-w-0 shrink-0 items-center gap-1.5 font-medium ${
                !isVoice && channel?.topic?.trim() ? 'md:max-w-[50%]' : ''
              }`}
            >
              {isVoice ? (
                <Volume2 size={18} className="shrink-0 text-on-surface-variant" />
              ) : (
                <Hash size={18} className="shrink-0 text-on-surface-variant" />
              )}
              <span className="truncate">
                {channelName && <Masked text={channelName} own={ownServer} />}
              </span>
              {channel?.restrict_view && (
                <span
                  title="Private channel"
                  aria-label="Private channel"
                  role="img"
                  className="flex shrink-0 text-on-surface-variant"
                >
                  <Lock size={14} />
                </span>
              )}
              {!isVoice && channel && channel.slowmode_seconds > 0 && (
                <span
                  title={slowTitle(channel.slowmode_seconds)}
                  aria-label={slowTitle(channel.slowmode_seconds)}
                  role="img"
                  className="flex shrink-0 text-on-surface-variant"
                >
                  <Clock size={16} />
                </span>
              )}
            </span>
            {channel && !isVoice && (
              <span className="flex min-w-0 md:flex-1 md:border-l md:border-outline-variant md:pl-3">
                <ChannelTopic channel={channel} />
              </span>
            )}
          </div>
        )}
        {dm && (
          <span className="flex min-w-20 items-center gap-2 font-medium">
            <DmPeer other={dm.other} />
            {dm.is_self && (
              <span className="shrink-0 rounded-full bg-secondary-container px-2 py-0.5 text-xs text-on-secondary-container">
                yourself
              </span>
            )}
          </span>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2 @max-sm:gap-1">
          {dm && !dm.is_self && !guest && !otherBlocked && <CallButtons dm={dm} />}
          <StatusClock timeCls="@max-lg:hidden" />
          {scope && <SelectButton scope={scope} className="@max-sm:hidden" />}
          {scope && <PinsButton className="@max-sm:hidden" />}
          {!guest && <InboxButton />}
          {view?.kind === 'channel' && !isVoice && (
            <button
              title="Search"
              onClick={() => openSearch()}
              className="rounded-full p-1.5 hover:bg-surface-container-high @max-sm:hidden"
            >
              <Search size={20} />
            </button>
          )}
          <HeaderMore scope={scope} search={view?.kind === 'channel' && !isVoice} />
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
        <VoiceGrid key={`c${view.channelId}`} channelId={view.channelId} />
      ) : (
        <>
          {dm && dmCall && (
            <div
              className={`flex shrink-0 flex-col overflow-hidden ${
                callShare ? 'h-[70dvh]' : 'h-[45dvh]'
              }`}
            >
              <VoiceGrid key={`d${dm.id}`} dmId={dm.id} />
            </div>
          )}
          {wide && <SelectionBar scope={scope} sheet={false} />}
          <BulkJobBar scope={scope} />
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
            {!detached && positioned && fresh > 0 && (
              <PresentBar count={fresh} onJump={scroll.toBottom} />
            )}
            <div
              ref={listRef}
              onScroll={onScroll}
              className={`flex-1 overflow-y-auto py-3 ${stale && !positioned ? 'invisible' : ''}`}
            >
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
              <div ref={contentRef}>
                {positioned && messages.length > 0 && older?.more !== false && (
                  <EdgeSentinel key={messages[0].id} root={listRef} edge="top" onVisible={onTop} />
                )}
                <BlockedList
                  messages={messages}
                  focusId={focus?.id ?? null}
                  dividerAt={dividerIndex}
                  divider={unreadDivider}
                  row={(m, i) => (
                    <Selectable m={m} scope={scope}>
                      <MessageRow
                        m={m}
                        first={places[i]?.first ?? true}
                        last={places[i]?.last ?? true}
                        mentioned={mentionedIds.has(m.id)}
                        divider={i === dividerIndex}
                        flash={flash === m.id}
                        canDelete={canDelete(m)}
                        canReact={canReact}
                        canUnreact={canUnreact}
                        canReply={replies.quote}
                        canThread={replies.thread}
                        canEdit={canEdit(m)}
                        canForward={forwardable(m)}
                        editing={editingId === m.id}
                        channel={view?.kind === 'channel'}
                        server={memberServer}
                        color={roleColor(
                          detail?.roles,
                          memberFor(m.author.username)?.role_ids ?? []
                        )}
                        quoteColor={
                          m.reply_to?.author
                            ? roleColor(
                                detail?.roles,
                                memberFor(m.reply_to.author.username)?.role_ids ?? []
                              )
                            : undefined
                        }
                        onMenu={rowMenu}
                        onReply={rowReply}
                        onEdit={rowEdit}
                        onJump={rowJump}
                      />
                    </Selectable>
                  )}
                />
                {positioned && detached && messages.length > 0 && (
                  <EdgeSentinel
                    key={`n${messages[messages.length - 1].id}`}
                    root={listRef}
                    edge="bottom"
                    onVisible={onBottom}
                  />
                )}
                {view && (
                  <OutboxRows
                    msgKey={viewKey(view)}
                    outgoing={outgoing}
                    places={places.slice(messages.length)}
                  />
                )}
              </div>
            </div>
          </div>
          <div className="relative shrink-0">
            <TypingIndicator scope={view ? viewKey(view) : null} bg="bg-surface" />
            {selecting && !wide ? (
              <SelectionBar scope={scope} sheet />
            ) : dm && otherBlocked ? (
              <BlockedComposer user={dm.other} />
            ) : (
              <MessageComposer />
            )}
          </div>
        </>
      )}
      {scope && <PinsWindow />}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/80 font-medium text-primary">
          Drop file to attach
        </div>
      )}
    </main>
  )
}
