'use client'
import { Name } from './name'
import { asAccount } from '../lib/people'
import { personName } from '../lib/names'
import { ViewActorTag } from './view_actor'
import { useP2pApp } from '../lib/client/p2p_react'

import { useAccount, useStoreApi } from '../lib/client/react'

import {
  Fragment,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  Clock,
  Hash,
  Lock,
  Menu,
  MoreVertical,
  MessageSquareText,
  MessagesSquare,
  NotebookPen,
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
import { SELF_DM_TEXT, SELF_DM_TITLE } from '../lib/dm_list'
import { dayStarts } from '../lib/date_dividers'
import { escapeMarksRead } from '../lib/follow'
import { mentionLookups, mentionsUser } from '../lib/mentions'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer, useLive } from '../lib/place/react'
import { slowTitle } from '../lib/slowmode'
import { canQuote, repliesToMe } from '../lib/replies'
import { messageRights, replyAccess } from '../lib/actions/message'
import { actionPress, openActionMenu, useHasMenu } from '../lib/actions/menu'
import type { Target } from '../lib/actions/types'
import {
  byUsername,
  confirmDeleteMessage,
  myRank,
  roleColor,
  roleLook,
  userRefFor,
  useStore,
  viewKey,
  allPings,
  groupMentionsMe,
  type ContextMenuOptions,
  type Outgoing,
} from '../lib/store'
import { outranksKnown } from '../lib/hierarchy'
import type { CallLog, Member, Message, UserRef } from '../lib/types'
import { callTone, type CallTone } from '../lib/voice_layout'
import { callLogInfo } from '../lib/call_choice'
import { UserAvatar } from './user_avatar'
import { UnreadDivider } from './unread_banner'
import { hostedUnread, type UnreadCount } from '../lib/unread_banner'
import { DateDivider } from './date_divider'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { MarkdownMessage } from './markdown_message'
import { ShownName, useShown } from './shown_user'
import { TypingIndicator } from './typing_indicator'
import { MessageComposer } from './message_composer'
import StatusClock from './status_clock'
import { InboxButton } from './inbox'
import { longPress, useMedia } from './context_menu'
import { profileTrigger } from './profile_card'
import { useCallShare, VoiceGrid } from './voice_grid'
import { ChannelTopic } from './channel_topic'
import { CallButtons, CallDuration, DirectBadge } from './call_buttons'
import { useChatScroll, useFocusMessage, useScrollAnchor } from './viewport_height'
import { Masked, useEscape, useOwnServer } from './ui'
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
import { MessageList, NewerOnSight } from './message_list'
import { useMessages } from '../lib/place/use_messages'
import { PinNotice, PinsButton, PinsWindow, useCanPin } from './pins'
import { ThreadsButton, ThreadsWindow } from './threads'
import { PollCard } from './poll_card'
import { SystemNotice } from './system_messages'
import { useMyTimeoutEnds } from './timeout_dialog'
import { isNotice, isSystem } from '../lib/system_messages'
import type { Look } from '../lib/role_looks'
import { RoleIcon } from './role_icon'
import { MessageTime, ShortTime } from './timestamp'
import { messagePlaces, type GroupPlace } from '../lib/message_groups'
import { BlockedComposer, BlockedList } from './blocking'
import { Row, Stack, Surface, Inset } from './layout'
import {
  BulkJobBar,
  SelectButton,
  Selectable,
  SelectionBar,
  openSelectionMenu,
  useSelectionKeys,
} from './selection'
import { Button, IconButton } from './controls'

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
  const store = useStoreApi()
  const me = useStore(s => s.me)
  const dms = useStore(s => s.dms)
  const acceptCall = useStore(s => s.acceptCall)
  const declineCall = useStore(s => s.declineCall)
  const openDm = useStore(s => s.openDm)
  const call = message.call
  if (!call) return null
  const tone = callTone(call)
  const incoming = me !== null && me.username !== call.from
  const caller = userRefFor(store.getState(), call.from)
  const other = dms.find(d => d.id === message.dm_id)?.other
  const name = (u: UserRef | undefined) =>
    u ? (
      <Name of={personName(asAccount(u, 'call'))} withUsername look="font-medium text-on-surface" />
    ) : (
      <span className="font-medium text-on-surface">Someone</span>
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
          <Surface
            as="span"
            row
            pad="sm"
            inset="chip"
            gap="2xs"
            tone="plain"
            radius="full"
            text="xs"
            look="bg-status-green/15 font-medium text-status-green tabular-nums"
          >
            <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-status-green" />
            <CallDuration from={call.answered_at} />
          </Surface>
        )
      }
    >
      {tone === 'ringing' && incoming && (
        <Row as="span" gap="xs">
          <Surface
            title="Accept"
            aria-label="Accept"
            onClick={() => {
              if (message.dm_id !== null) void openDm(message.dm_id)
              void acceptCall()
            }}
            as="button"
            row
            pad="md"
            inset="chip"
            gap="2xs"
            tone="plain"
            radius="full"
            text="xs"
            look="bg-status-green font-medium text-surface outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11"
          >
            <Phone size={12} />
            Accept
          </Surface>
          <Surface
            title="Decline"
            aria-label="Decline"
            onClick={declineCall}
            as="button"
            row
            pad="md"
            inset="chip"
            gap="2xs"
            tone="plain"
            radius="full"
            text="xs"
            look="bg-danger font-medium text-on-danger outline-offset-2 hover:brightness-110 focus-visible:outline-2 focus-visible:outline-primary pointer-coarse:min-h-11"
          >
            <PhoneOff size={12} />
            Decline
          </Surface>
        </Row>
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
    <Inset data-call-row row pad="lg" inset="line" gap="md" look="hover:bg-surface-container-low">
      <span
        role="img"
        title={direction}
        aria-label={direction}
        className={`flex w-9 shrink-0 justify-center ${iconCls}`}
      >
        <Icon size={18} className={tone === 'ringing' ? 'motion-safe:animate-pulse' : ''} />
      </span>
      <Row gap="sm" wrap lineGap="2xs" text="sm" ink="muted" place="min-w-0 flex-1">
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
      </Row>
    </Inset>
  )
}

const EMPTY_OUT: Outgoing[] = []

export const avatarTriggerCls =
  'block cursor-pointer rounded-full outline-offset-2 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-primary'
// The name color and role icon of a row's author, as row props.
const authorLook = (look: Look) => ({
  color: look.color,
  icon: look.icon?.emoji,
  iconRole: look.icon?.role,
})

// Avatar on the left; name and `meta` (the time) above `children` on the right.
export function AuthorRow({
  author,
  server,
  size,
  color,
  icon,
  meta,
  children,
}: {
  author: UserRef
  server: string | null
  size: number
  color?: string
  icon?: Look['icon']
  meta: ReactNode
  children: ReactNode
}) {
  const store = useStoreApi()
  const shown = useShown(author, server)
  return (
    <Row gap="md" align="stretch">
      <div className="shrink-0">
        <span
          {...profileTrigger(store, author, server, false)}
          title="View profile"
          className={avatarTriggerCls}
        >
          <UserAvatar person={shown} size={size} />
        </span>
      </div>
      <div className="min-w-0 flex-1">
        <Row gap="sm" align="baseline" wrap place="min-w-0">
          <Name
            of={personName(shown)}
            withUsername
            fit
            link
            {...profileTrigger(store, author, server)}
            color={color}
            place="min-w-0"
            look="truncate text-sm font-medium"
          />
          <RoleIcon emoji={icon?.emoji} role={icon?.role} />
          {isWebhookAuthor(author.username) && <WebhookBadge />}
          {meta}
        </Row>
        {children}
      </div>
    </Row>
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
    <Row gap="md" align="stretch" data-grouped>
      <span className="streamer sr-only">{name}</span>
      <div className="relative shrink-0" style={{ width: size }}>
        {status ? (
          <span className={gutterStatusCls}>{status}</span>
        ) : (
          <ShortTime ts={ts} className={gutterTimeCls} />
        )}
      </div>
      <div className="min-w-0 flex-1">{children}</div>
    </Row>
  )
}

const gutterStatusCls =
  'absolute top-0 left-1/2 flex h-[22.75px] -translate-x-1/2 items-center text-on-surface-variant'

// The other person in a DM's header: avatar and name, opening their profile.
export function DmPeer({ other }: { other: UserRef }) {
  const store = useStoreApi()
  return (
    <Surface
      {...profileTrigger(store, other, null)}
      as="span"
      row
      pad="sm"
      inset="chip"
      gap="sm"
      tone="plain"
      radius="full"
      look="cursor-pointer outline-offset-2 hover:bg-surface-container-high focus-visible:outline-2 focus-visible:outline-primary"
      place="min-w-0"
    >
      <span className={`flex shrink-0 ${showsUsername(other) ? 'max-sm:hidden' : ''}`.trim()}>
        <UserAvatar person={asAccount(other, 'dm')} size={24} />
      </span>
      <Name of={personName(asAccount(other, 'dm'))} withUsername look="truncate" />
    </Surface>
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

// A message that mentions you: a warm wash and a bar on its left edge, in both themes.
export const mentionRowCls =
  'bg-mention before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-mention-bar hover:bg-mention-hover'

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

const unreadDivider = <UnreadDivider />

// The new messages banner of a hosted list: counted from the loaded rows, or asked of the server
// while the first unread message or the newest one isn't loaded (`away`: the unread part is above
// or below what is loaded).
function useHostedUnread(
  scope: string | null,
  messages: Message[],
  first: number,
  away: boolean,
  tail: boolean,
  after: number,
  me: string | undefined
) {
  const { api } = useAccount()
  const ask = scope !== null && (away || (first >= 0 && !tail))
  const key = `${scope}:${after}`
  const [counted, setCounted] = useState<{ key: string; count: UnreadCount } | null>(null)
  useEffect(() => {
    if (!ask || scope === null) return
    let live = true
    api.getUnreadCount(scope, after).then(
      count => {
        if (live) setCounted({ key, count })
      },
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, ask, scope, after, key])
  const rows = useMemo(
    () => messages.map(m => ({ id: m.id, author: m.author.username, created_at: m.created_at })),
    [messages]
  )
  return useMemo(
    () => hostedUnread(rows, first, tail, me, after, counted?.key === key ? counted.count : null),
    [rows, first, tail, me, after, counted, key]
  )
}

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
  canVote: boolean
  canUnreact: boolean
  canReply: boolean
  canThread: boolean
  canEdit: boolean
  canForward: boolean
  editing: boolean
  server: string | null
  color: string | undefined
  // The emoji of the author's role icon and the role's name.
  icon: string | undefined
  iconRole: string | undefined
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
  canVote,
  canUnreact,
  canReply,
  canThread,
  canEdit,
  canForward,
  editing,
  server,
  color,
  icon,
  iconRole,
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
        <PollCard m={m} canVote={canVote} />
      ) : (
        <MarkdownMessage
          message={m}
          canDelete={canDelete}
          editor={editing ? <MessageEditor /> : undefined}
        />
      )}
      <ReactionBar m={m} canReact={canReact} canRemove={canUnreact} />
      {m.reply_count > 0 && (
        <Surface
          title="Open thread"
          onClick={() => void openThread(m)}
          as="button"
          row
          pad="md"
          inset="chip"
          gap="xs"
          tone="base"
          radius="full"
          text="xs"
          fit
          look="msg-part font-medium text-primary hover:bg-surface-container-high"
        >
          <MessageSquareText size={12} />
          {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}
        </Surface>
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
        className={`group relative ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : 'hover:bg-surface-container-low'}`}
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
            icon={icon && iconRole !== undefined ? { emoji: icon, role: iconRole } : undefined}
            meta={timeMeta(m.created_at)}
          >
            {body}
          </AuthorRow>
        ) : (
          <GroupedRow
            name={<ShownName user={m.author} server={server} />}
            ts={m.created_at}
            size={36}
          >
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
        <Row gap="md" text="xs" look="msg-part font-medium">
          <button onClick={onRetry} className="text-primary">
            Retry
          </button>
          <button onClick={onCancel} className="text-error">
            Delete
          </button>
        </Row>
      )}
    </>
  )
  return (
    <div
      className={`group relative ${groupPadCls(place.first, place.last)} ${failed ? '' : 'opacity-50'}`}
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
        <GroupedRow
          name={<ShownName user={author} server={server} />}
          ts={o.msg.created_at}
          size={size}
        >
          <span className="sr-only">{label}</span>
          {body}
        </GroupedRow>
      )}
    </div>
  )
}

const ALONE: GroupPlace = { first: true, last: true }

// My sends on their way below a list; `places` are theirs from the list's grouping.
// `dayAbove`: the time of the last row shown above the sends, for their date lines.
export function OutboxRows({
  msgKey,
  outgoing,
  places,
  dayAbove,
  size = 36,
}: {
  msgKey: string
  outgoing: readonly Outgoing[]
  places: readonly GroupPlace[]
  dayAbove: number | null
  size?: number
}) {
  const me = useStore(s => s.me)
  const server = useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))
  const retryOutgoing = useStore(s => s.retryOutgoing)
  const cancelOutgoing = useStore(s => s.cancelOutgoing)
  const jumpTo = useStore(s => s.jumpTo)
  const jump = (id: number) => void jumpTo(msgKey, id)
  const days = useMemo(
    () =>
      dayStarts(
        outgoing.map(o => o.msg.created_at),
        dayAbove
      ),
    [outgoing, dayAbove]
  )
  if (!me || !outgoing.length) return null
  return (
    <>
      {outgoing.map((o, i) => (
        <Fragment key={o.tempId}>
          {days.has(i) && <DateDivider at={o.msg.created_at} />}
          <OutgoingRow
            o={o}
            author={me}
            server={server}
            place={places[i] ?? ALONE}
            size={size}
            onJump={jump}
            onRetry={() => retryOutgoing(msgKey, o.tempId)}
            onCancel={() => cancelOutgoing(msgKey, o.tempId)}
          />
        </Fragment>
      ))}
    </>
  )
}

// Your DM with yourself while it is empty: what the space is for.
function SelfDmEmpty() {
  const me = useStore(s => s.me)
  return (
    <Surface tone="plain" radius="none" pad="xl" place="h-full" data-self-dm-empty>
      <Stack gap="md" align="center" justify="center" place="flex-1">
        {me ? (
          <span className="rounded-full ring-4 ring-secondary-container">
            <UserAvatar person={asAccount(me, 'own')} size={64} />
          </span>
        ) : (
          <NotebookPen size={40} className="text-on-surface-variant" />
        )}
        <span className="text-center text-2xl font-semibold text-on-surface">{SELF_DM_TITLE}</span>
        <span className="max-w-md text-center text-sm text-on-surface-variant">{SELF_DM_TEXT}</span>
      </Stack>
    </Surface>
  )
}

export const HEADER_MORE = 'header-more'

// The header actions that fold into one menu when the header is narrow.
export function HeaderMore({ scope, search }: { scope: string | null; search: boolean }) {
  const acct = useAccount()

  const target: Target = { kind: 'header', list: scope, search }
  const open = useStore(s => s.contextMenu?.owner === HEADER_MORE)
  const has = useHasMenu(target)
  if (!has) return null
  return (
    <IconButton
      icon={MoreVertical}
      label="More"
      aria-haspopup="menu"
      aria-expanded={open}
      onClick={e => {
        const r = e.currentTarget.getBoundingClientRect()
        openActionMenu(r.right, r.bottom + 4, target, { owner: HEADER_MORE }, acct)
      }}
      size="lg"
      tone="inherit"
      place="@sm:hidden"
    />
  )
}

function OpenPins() {
  return <PinsWindow canUnpin={useCanPin()} />
}

// A channel the site admin has not opened as staff, in place of its messages.
function StaffShut({ channel }: { channel: number }) {
  const ask = useStore(s => s.askStaffView)
  return (
    <Surface tone="plain" radius="none" pad="xl" place="flex-1">
      <Stack gap="md" align="center" justify="center" place="flex-1">
        <Lock size={32} className="text-on-surface-variant" />
        <span className="text-center text-lg font-semibold text-on-surface-variant">
          Confirm to open this channel
        </span>
        <Button onClick={() => ask(channel)} variant="filled" size="md">
          Open channel
        </Button>
      </Stack>
    </Surface>
  )
}

export function MessagePane({ onMenu, onMembers }: { onMenu: () => void; onMembers: () => void }) {
  const identity = useP2pApp()
  const p2pMarkAll = identity?.p2pMarkAll

  const acct = useAccount()

  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const shut = useStore(s => s.staffShut !== null && s.staffShut === s.view)
  const detail = useStore(s => (s.view?.kind === 'channel' ? s.servers[s.view.server] : undefined))
  const dm = useStore(s => {
    const v = s.view
    return v?.kind === 'dm' ? s.dms.find(d => d.id === v.dmId) : undefined
  })
  const messages = useStore(s => (s.view ? s.messages[viewKey(s.view)] : undefined)) ?? EMPTY
  const outgoing = useStore(s => (s.view ? s.outbox[viewKey(s.view)] : undefined)) ?? EMPTY_OUT
  const outCount = outgoing.length
  const anchor = useStore(s => (s.view ? s.unreadAnchor[viewKey(s.view)] : undefined))
  const list = useMessages()
  const listState = useLive(list.state)
  const { older, newer } = listState
  const stale = useStore(s => (s.view ? s.stale[viewKey(s.view)] === true : false))
  const focus = useStore(s => (s.view ? s.focus[viewKey(s.view)] : undefined))
  const menuPings = useStore(allPings)
  const memberServer = view?.kind === 'channel' ? view.server : null
  const memberFor = useMemberLookup(memberServer)
  useAuthorMembers(memberServer, usePeopleKey(messages, me ? [me.username] : []))
  const jumpTo = useStore(s => s.jumpTo)
  const startReply = useStore(s => s.startReply)
  const startEdit = useStore(s => s.startEdit)
  const editingId = useStore(s =>
    s.editing && s.view && s.editing.key === viewKey(s.view) ? s.editing.id : null
  )
  const askMarkAllRead = useStore(s => s.askMarkAllRead)
  const openSearch = useStore(s => s.openSearch)
  const uploadFile = useStore(s => s.uploadFile)
  const attachmentsEnabled = useStore(s => s.settings.asset_uploads || s.settings.p2p_attachments)
  const call = useStore(s => s.call)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const ownServer = useOwnServer(view?.kind === 'channel' ? view.server : null)

  const channel =
    view?.kind === 'channel' ? detail?.channels.find(c => c.id === view.channelId) : undefined
  const can = useChannelCan(
    useHostedServer(view?.kind === 'channel' ? view.server : null),
    view?.kind === 'channel' ? view.channelId : null
  )
  const canAttach = attachmentsEnabled && !channel?.text_only && can.attach
  const channelName = channel?.name
  const isVoice = channel?.kind === 'voice'
  const scope = view && !isVoice ? viewKey(view) : null
  const detached = newer.more
  const snapEdge = useScrollAnchor(listRef, messages[0]?.id, older.loading || newer.loading)
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
  const ownLast = lastOwn(messages, me?.username)
  const mark = unreadMark(ids, anchor, older.more, ownLast)
  const dividerIndex = mark.divider
  // Opened in older history: every loaded message is at or before the read marker.
  const below =
    !!anchor && dividerIndex < 0 && !mark.above && detached && (ids.at(-1) ?? 0) <= anchor
  const unread = useHostedUnread(
    scope,
    messages,
    dividerIndex,
    mark.above || below,
    !detached,
    Math.max(anchor ?? 0, ownLast),
    myName
  )
  const bannered =
    !!scope && (mark.above || dividerIndex >= 0 || (below && (unread.count ?? 0) > 0))
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
      if (last) list.markRead(String(last.id))
    },
  })
  const positioned = scroll.positioned
  // The newest page is loading over a cached list or none: placeholders until it is placed.
  const loading = stale && !positioned
  const fresh = newSince(messages, scroll.leftAt, me?.username)

  const flash = useFocusMessage(listRef, scope, focus, messages, scroll.settle)
  const threadScope = useStore(s => (s.panel?.kind === 'thread' ? `t${s.panel.root.id}` : null))
  useSelectionKeys(scope, [scope, threadScope], threadScope)
  const selecting = useStore(s => scope !== null && s.selection?.scope === scope)
  const wide = useMedia('(min-width: 768px)')
  useEscape(e => {
    if (acct.store.getState().selection) {
      acct.store.getState().exitSelection()
      return
    }
    if (guest || !escapeMarksRead(e)) return
    if (e.shiftKey) askMarkAllRead(p2pMarkAll?.())
    else list.dismissUnread()
  }, 'stage')

  const otherBlocked = useStore(s => (dm ? s.blocked[dm.other.username] === true : false))
  const dmCall =
    dm && call?.dmId === dm.id && (call.state === 'active' || call.from === me?.username)
  const callShare = useCallShare(dm?.id ?? -1)

  const onScroll = () => {
    scroll.onScroll()
    if (older.loading || newer.loading) snapEdge()
  }

  const messageMenu = (msg: Message, x: number, y: number) => {
    if (!scope || openSelectionMenu(scope, msg, x, y, acct)) return
    const react = !isNotice(msg) && messageRights(acct.store.getState(), msg, scope).react
    openActionMenu(
      x,
      y,
      { kind: 'message', message: msg, list: scope },
      react ? reactHeader(msg, x, y) : undefined,
      acct
    )
  }

  const canUnreact = me !== null && !guest
  const timedOutEnds = useMyTimeoutEnds(view?.kind === 'channel' ? view.server : null)
  const acting =
    canUnreact &&
    (view?.kind === 'dm' ||
      (view?.kind === 'channel' &&
        me.servers.some(x => x.name === view.server) &&
        timedOutEnds === null))
  const canWrite = acting && can.send
  const canReact = acting && can.react
  const replies = useStore(
    useShallow(s =>
      replyAccess(
        s,
        memberServer,
        view?.kind === 'channel' ? view.channelId : null,
        canWrite,
        view?.kind === 'dm'
      )
    )
  )

  const rank = useStore(useShallow(s => (memberServer ? myRank(s, memberServer) : undefined)))
  const canDelete = (m: Message) =>
    me !== null &&
    (m.author.username === me.username ||
      (view?.kind === 'channel' &&
        can.manage &&
        outranksKnown(rank, memberFor(m.author.username), detail?.roles)))

  const canEdit = (m: Message) => canWrite && ownEditable(m, me?.username)

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
      data-share-drop-pane
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
      <Inset
        as="header"
        row
        pad="lg"
        inset="sides"
        gap="md"
        border="bottom"
        look="@container h-14"
        place="shrink-0"
      >
        <IconButton
          icon={Menu}
          label="Menu"
          tooltip={menuPings ? `Menu, ${pingLabel(menuPings)}` : 'Menu'}
          onClick={onMenu}
          size="lg"
          tone="inherit"
          place="relative md:hidden"
        >
          <PingBadge
            count={menuPings}
            className="absolute -top-1 -right-1.5 border-2 border-surface"
          />
        </IconButton>
        {view?.kind === 'channel' && (
          <Stack gap="none" rowFrom="md" place="min-w-0 flex-1">
            <Row
              as="span"
              gap="xs"
              look={`font-medium ${!isVoice && channel?.topic?.trim() ? 'md:max-w-1/2' : ''}`}
              place="max-w-full min-w-0 shrink-0"
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
            </Row>
            {channel && !isVoice && (
              <Inset
                as="span"
                row
                pad="md"
                inset="sides"
                look="md:border-l md:border-outline-variant"
                place="min-w-0 md:flex-1 max-md:hidden"
              >
                <ChannelTopic channel={channel} />
              </Inset>
            )}
          </Stack>
        )}
        {dm && (
          <Row as="span" gap="sm" look="font-medium" place="min-w-0">
            <DmPeer other={dm.other} />
            {dm.is_self && (
              <Surface
                as="span"
                pad="sm"
                inset="chip"
                tone="secondary"
                radius="full"
                text="xs"
                place="shrink-0"
              >
                yourself
              </Surface>
            )}
          </Row>
        )}
        <ViewActorTag header />
        <Row gap="2xs" place="ml-auto shrink-0">
          {dm && !dm.is_self && !guest && !otherBlocked && <CallButtons dm={dm} />}
          <StatusClock timeCls="@max-lg:hidden" />
          {scope && <SelectButton scope={scope} className="@max-sm:hidden" />}
          {scope && <PinsButton className="@max-sm:hidden" />}
          {scope && <ThreadsButton className="@max-sm:hidden" />}
          {!guest && <InboxButton />}
          {view?.kind === 'channel' && !isVoice && (
            <IconButton
              icon={Search}
              label="Search"
              onClick={() => openSearch()}
              size="lg"
              tone="inherit"
              place="@max-sm:hidden"
            />
          )}
          <HeaderMore scope={scope} search={view?.kind === 'channel' && !isVoice} />
          {view?.kind === 'channel' && (
            <IconButton
              icon={Users}
              label="Members"
              onClick={onMembers}
              size="lg"
              tone="inherit"
              place="lg:hidden"
            />
          )}
        </Row>
      </Inset>
      {shut && view?.kind === 'channel' ? (
        <StaffShut channel={view.channelId} />
      ) : isVoice && view?.kind === 'channel' ? (
        <VoiceGrid key={`c${view.channelId}`} channelId={view.channelId} />
      ) : (
        <>
          {dm && dmCall && (
            <div
              className={`flex shrink-0 flex-col overflow-hidden ${
                callShare ? 'h-dvh-70' : 'h-dvh-45'
              }`}
            >
              <VoiceGrid key={`d${dm.id}`} dmId={dm.id} />
            </div>
          )}
          {wide && <SelectionBar scope={scope} sheet={false} />}
          <BulkJobBar scope={scope} />
          <MessageList
            list={list}
            state={listState}
            listRef={listRef}
            contentRef={contentRef}
            onScroll={onScroll}
            loading={loading}
            positioned={positioned}
            ends={
              messages.length
                ? { first: messages[0].id, last: messages[messages.length - 1].id }
                : null
            }
            banner={
              bannered
                ? {
                    unread,
                    onJump: () => {
                      const line = listRef.current?.querySelector('[data-divider]')
                      if (dividerIndex >= 0 && line) line.scrollIntoView({ block: 'center' })
                      else list.toUnread()
                    },
                  }
                : null
            }
            fresh={fresh}
            toBottom={scroll.toBottom}
            beforePage={snapEdge}
            empty={
              !view ? (
                <Stack gap="md" align="center" justify="center" place="h-full">
                  <MessagesSquare size={40} className="text-on-surface-variant" />
                  <span className="text-on-surface-variant">Select a conversation</span>
                </Stack>
              ) : messages.length > 0 ? null : dm?.is_self ? (
                <SelfDmEmpty />
              ) : (
                <Surface tone="plain" radius="none" pad="xl" place="h-full">
                  <Stack gap="2xs" align="center" justify="center" place="flex-1">
                    <span className="text-center text-2xl font-semibold text-on-surface-variant opacity-70">
                      No messages here yet
                    </span>
                    <span className="text-center text-sm text-on-surface-variant opacity-70">
                      Be the first to say something.
                    </span>
                  </Stack>
                </Surface>
              )
            }
            lightbox={{
              rows: () => ({ ids: messages.map(m => m.id), places }),
              forward: id => {
                const m = messages.find(x => x.id === id)
                return m && scope
                  ? actionPress(
                      'message_forward',
                      { kind: 'message', message: m, list: scope },
                      acct
                    )
                  : null
              },
            }}
          >
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
                    canVote={canWrite}
                    canUnreact={canUnreact}
                    canReply={replies.quote}
                    canThread={replies.thread}
                    canEdit={canEdit(m)}
                    canForward={forwardable(m)}
                    editing={editingId === m.id}
                    server={memberServer}
                    {...authorLook(
                      roleLook(detail?.roles, memberFor(m.author.username)?.role_ids ?? [])
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
              tail={lastShownAt => (
                <>
                  <NewerOnSight
                    list={list}
                    state={listState}
                    listRef={listRef}
                    positioned={positioned}
                    last={messages.at(-1)?.id}
                    beforePage={snapEdge}
                  />
                  {view && (
                    <OutboxRows
                      msgKey={viewKey(view)}
                      outgoing={outgoing}
                      places={places.slice(messages.length)}
                      dayAbove={lastShownAt}
                    />
                  )}
                </>
              )}
            />
          </MessageList>
          <div className="relative shrink-0">
            <TypingIndicator
              scope={view ? viewKey(view) : null}
              server={memberServer}
              bg="bg-surface"
            />
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
      {scope && <OpenPins />}
      {scope && <ThreadsWindow />}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/80 font-medium text-primary">
          Drop file to attach
        </div>
      )}
    </main>
  )
}
