'use client'

import { Button, LinkButton } from './controls'
import { UNREADABLE_TEXT } from '../lib/sealing'
import { memo, type ReactNode } from 'react'
import { Check, CircleAlert, Clock, EyeOff, MessageSquareText, Reply, Trash2 } from 'lucide-react'
import { hiddenRemovedText, SLOW_HIDDEN_TEXT } from '../lib/p2p/flows'
import { canQuote } from '../lib/replies'
import { isNotice } from '../lib/system_messages'
import type { Message } from '../lib/types'
import { isWebhookAuthor } from '../lib/webhooks'
import { longPress } from './context_menu'
import { ForwardCard, forwardAction } from './forwards'
import { groupPadCls, gutterTimeCls } from './grouped_row'
import { Inset, Row } from './layout'
import { MarkdownMessage } from './markdown_message'
import { Name } from './name'
import type { Face } from '../lib/place/looks'
import { useAuthor, useNameColor } from '../lib/place/use_looks'
import { personCalled } from '../lib/names'
import { MessageEditor, editAction } from './message_editor'
import type { EditBinding } from '../lib/place/row_acts'
import { RowFiles } from './row_files'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { KeyAvatar } from './p2p/p2p_badge'
import { PollCard } from './poll_card'
import { ProfileButton } from './profile_card'
import { ReactionBar } from './reactions'
import { ReplyPreview } from './replies'
import { RoleIcon } from './role_icon'
import { MessageTime, ShortTime } from './timestamp'
import { UnreadDivider } from './unread_banner'
import { UserAvatar } from './user_avatar'
import { WebhookBadge } from './webhooks'
import { plays, playsOn } from '../lib/motion/play'

// A row rises as its message arrives and fades as it is deleted.
const ARRIVES = plays('message.arrive', plays('message.remove'))

export const avatarTriggerCls =
  'block cursor-pointer rounded-full outline-offset-2 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-primary'

// Avatar on the left; name and `meta` (the time) above `children` on the right.
export function AuthorRow({
  face,
  size,
  meta,
  children,
}: {
  face: Face
  size: number
  meta: ReactNode
  children: ReactNode
}) {
  const { who, name, color, icon } = face
  if (who.kind === 'key')
    return (
      <Row gap="md" align="stretch">
        <div className="shrink-0">
          <KeyAvatar person={who.person} size={size} />
        </div>
        <div className="min-w-0 flex-1">
          <Row gap="sm" align="baseline" wrap>
            <Name of={name} color={color} look="min-w-0 truncate text-sm font-medium" />
            <RoleIcon emoji={icon?.emoji} role={icon?.role} />
            {meta}
          </Row>
          {children}
        </div>
      </Row>
    )
  const { person: author, server } = who
  return (
    <Row gap="md" align="stretch">
      <div className="shrink-0">
        <ProfileButton
          user={author}
          server={server}
          focusable={false}
          shape="round"
          title="View profile"
          place="flex"
        >
          <UserAvatar person={author} size={size} />
        </ProfileButton>
      </div>
      <div className="min-w-0 flex-1">
        <Row gap="sm" align="baseline" wrap place="min-w-0">
          <ProfileButton user={author} server={server}>
            <Name
              of={name}
              withUsername
              fit
              link
              color={color}
              place="min-w-0"
              look="truncate text-sm font-medium"
            />
          </ProfileButton>
          <RoleIcon emoji={icon?.emoji} role={icon?.role} />
          {isWebhookAuthor(author.username) && <WebhookBadge />}
          {meta}
        </Row>
        {children}
      </div>
    </Row>
  )
}

// A row that continues its author's group: the author for screen readers only (`name` is the
// name component with `look="sr-only"`), and hours and
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
      {name}
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
  'absolute top-0 left-1/2 flex h-row-line -translate-x-1/2 items-center text-on-surface-variant'

export const timeMeta = (ts: number) => (
  <MessageTime ts={ts} className="shrink-0 text-xs text-on-surface-variant" />
)

// A message that mentions you: a warm wash and a bar on its left edge, in both themes.
export const mentionRowCls =
  'bg-mention before:absolute before:inset-y-0 before:left-0 before:w-0.5 before:bg-mention-bar hover:bg-mention-hover'

export const replyAction = (onClick: () => void): ToolbarAction => ({
  key: 'reply',
  label: 'Reply',
  icon: Reply,
  onClick,
})

// What a list does for its rows. One object per list, kept between renders, so a row draws again
// only when the row itself changes.
export interface RowHandlers {
  menu: (m: Message, x: number, y: number) => void
  // Shows the message a quote answers.
  jump: (id: number) => void
  edit: (m: Message) => void
  reply: (m: Message) => void
  // Puts the row on the forward clipboard.
  forward: (m: Message) => void
  thread: (m: Message) => void
  remove: (m: Message, skipConfirm: boolean) => void
  // Sends a failed message again, where sends can fail in place.
  retry?: (m: Message) => void
}

export interface RowProps {
  m: Message
  // The place's own key for the message, where it has one beside the number.
  event?: string
  // Its place in its author's group: only the first row shows the avatar, name and time.
  first: boolean
  last: boolean
  mentioned: boolean
  divider: boolean
  flash: boolean
  // A row of a thread panel: a smaller picture, and its delete says "reply".
  inThread?: boolean
  // The server whose members the row's notices name; null without one.
  server: string | null
  canEdit: boolean
  canReply: boolean
  canForward: boolean
  // What starting or opening the row's thread is called; null when it has none to offer.
  thread: string | null
  // Whether the count of thread replies shows under the row.
  chip?: boolean
  canDelete: boolean
  // Whether the row's files and cards offer their own removal.
  canTrim?: boolean
  canReact: boolean
  canUnreact: boolean
  canVote?: boolean
  // The edit box of the row while it is edited in place.
  editing: EditBinding | false
  // A place that loads nothing by itself: text shows only when there is some, and forwards
  // are drawn from the copy they carry.
  local?: boolean
  // Whether the files the place keeps with the message can be fetched.
  canFetch?: boolean
  // How far one of your own sends got, where the place tells.
  sent?: 'failed' | 'pending' | 'delivered'
  sentTip?: string
  // Whether a failed send can be sent again, and whether it can be dropped.
  canRetry?: boolean
  canDrop?: boolean
  // When a message that arrived long after it was sent was sent, in ms.
  lateAt?: number
  on: RowHandlers
}

function Sent({ m, sent, sentTip, canRetry, canDrop, on }: RowProps) {
  if (sent === 'failed')
    return (
      <Row as="span" data-failed gap="xs" place="shrink-0">
        <CircleAlert size={12} aria-hidden className="text-error" />
        <span className="text-xs text-error">Not sent</span>
        {canRetry && (
          <span className="text-xs">
            <LinkButton onClick={() => on.retry?.(m)} tone="error">
              Retry
            </LinkButton>
          </span>
        )}
        {canDrop && (
          <span className="text-xs">
            <LinkButton onClick={e => on.remove(m, e.shiftKey)} tone="error">
              Delete
            </LinkButton>
          </span>
        )}
      </Row>
    )
  if (sent === 'pending')
    return (
      <span
        data-pending
        role="img"
        title={sentTip}
        aria-label="Not delivered yet"
        className="flex shrink-0 text-on-surface-variant"
      >
        <Clock size={12} />
      </span>
    )
  return (
    <span
      data-delivered
      role="img"
      title="Delivered"
      aria-label="Delivered"
      className="flex shrink-0 text-on-surface-variant"
    >
      <Check size={12} />
    </span>
  )
}

// One message of a list, in a hosted channel or DM, a P2P room or conversation, or a thread of
// any of them.
export const MessageRow = memo(function MessageRow(props: RowProps) {
  const { m, first, last, mentioned, divider, flash, on } = props
  const face = useAuthor(m, props.event)
  const quoteColor = useNameColor(m.reply_to?.author)
  const { inThread = false, local = false, chip = false, canTrim = false, editing } = props
  const { canReact, canDelete } = props
  const size = inThread ? 30 : 36
  const actions: ToolbarAction[] = []
  if (props.canEdit && !editing) actions.push(editAction(() => on.edit(m)))
  if (props.canReply && canQuote(m)) actions.push(replyAction(() => on.reply(m)))
  if (props.canForward) actions.push(forwardAction(() => on.forward(m)))
  if (props.thread !== null && !isNotice(m))
    actions.push({
      key: 'thread',
      label: props.thread,
      icon: MessageSquareText,
      onClick: () => on.thread(m),
    })
  if (canDelete)
    actions.push({
      key: 'delete',
      label: `Delete ${inThread ? 'reply' : 'message'} (hold Shift to skip confirmation)`,
      icon: Trash2,
      danger: true,
      onClick: e => on.remove(m, e.shiftKey),
    })
  const editor = editing ? <MessageEditor binding={editing} /> : undefined
  const body = (
    <>
      {m.unreadable ? (
        <p data-unreadable className="text-sm italic text-on-surface-variant">
          {UNREADABLE_TEXT}
        </p>
      ) : m.forward ? (
        <ForwardCard m={m} canDelete={canTrim} local={local} />
      ) : m.kind === 'poll' ? (
        <PollCard m={m} canVote={props.canVote ?? false} />
      ) : (
        (!local || m.content.trim() !== '' || editor) && (
          <MarkdownMessage message={m} canDelete={canTrim} editor={editor} />
        )
      )}
      {local && <RowFiles m={m} canFetch={props.canFetch === true} />}
      <ReactionBar m={m} canReact={canReact} canRemove={props.canUnreact} />
      {chip && m.reply_count > 0 && (
        <div className="msg-part">
          <Button
            variant="tonal"
            icon={MessageSquareText}
            title="Open thread"
            data-thread-chip
            onClick={() => on.thread(m)}
          >
            {m.reply_count} {m.reply_count === 1 ? 'reply' : 'replies'}
          </Button>
        </div>
      )}
    </>
  )
  const status = props.sent ? <Sent {...props} /> : null
  return (
    <div ref={ARRIVES} data-row data-mid={m.id} data-event={props.event}>
      {divider && <UnreadDivider />}
      <div
        ref={playsOn('message.send', props.sent === 'pending' ? 0 : 1)}
        {...longPress((x, y) => on.menu(m, x, y))}
        data-flash={flash ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        className={`group relative ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : inThread ? 'hover:bg-surface-container' : 'hover:bg-surface-container-low'}`}
      >
        {m.reply_to && (
          <ReplyPreview
            quote={m.reply_to}
            avatar={size}
            color={quoteColor}
            local={local}
            onJump={on.jump}
          />
        )}
        {first ? (
          <AuthorRow
            face={face}
            size={size}
            meta={
              <>
                {timeMeta(m.created_at)}
                {props.lateAt !== undefined && (
                  <span
                    data-late
                    title={`Sent ${new Date(props.lateAt).toLocaleString()}`}
                    className="shrink-0 text-2xs text-on-surface-variant italic"
                  >
                    sent earlier, arrived later
                  </span>
                )}
                {status}
              </>
            }
          >
            {body}
          </AuthorRow>
        ) : (
          <GroupedRow
            name={<Name of={face.name} withUsername look="sr-only" />}
            ts={m.created_at}
            size={size}
            status={props.sent === 'pending' ? status : undefined}
          >
            {body}
          </GroupedRow>
        )}
        <MessageToolbar
          m={m}
          react={canReact}
          actions={actions}
          onMore={(x, y) => on.menu(m, x, y)}
        />
      </div>
    </div>
  )
})

function HiddenLine({
  m,
  divider,
  attrs,
  children,
}: {
  m: Message
  divider: boolean
  attrs: Record<string, string>
  children: ReactNode
}) {
  return (
    <div data-row data-mid={m.id}>
      {divider && <UnreadDivider />}
      <Inset {...attrs} row pad="lg" inset="line" gap="md" align="start">
        <span className="flex h-lh w-9 shrink-0 items-center justify-center text-on-surface-variant">
          <EyeOff size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant italic">
          {children} <MessageTime ts={m.created_at} className="text-xs not-italic opacity-70" />
        </p>
      </Inset>
    </div>
  )
}

// In place of a message sent around the time its author was removed.
export function RemovedRow({ m, divider }: { m: Message; divider: boolean }) {
  const [before, after] = hiddenRemovedText('\u0000').split('\u0000')
  return (
    <HiddenLine m={m} divider={divider} attrs={{ 'data-hidden-row': 'removed' }}>
      {before}
      <Name of={personCalled(m.author.display_name, m.author.username)} />
      {after}
    </HiddenLine>
  )
}

// In place of your own message that slow mode hides.
export function SlowHiddenRow({ m, divider }: { m: Message; divider: boolean }) {
  return (
    <HiddenLine m={m} divider={divider} attrs={{ 'data-hidden-row': 'slow' }}>
      {SLOW_HIDDEN_TEXT}
    </HiddenLine>
  )
}
