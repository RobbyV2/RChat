'use client'

import { memo, type ComponentType, type ReactNode } from 'react'
import { Check, CircleAlert, Clock, EyeOff, MessageSquareText, Reply, Trash2 } from 'lucide-react'
import { useStoreApi } from '../lib/client/react'
import { hiddenRemovedText, SLOW_HIDDEN_TEXT } from '../lib/p2p/flows'
import { canQuote } from '../lib/replies'
import type { Look } from '../lib/role_looks'
import { isNotice } from '../lib/system_messages'
import type { Message, UserRef } from '../lib/types'
import { isWebhookAuthor } from '../lib/webhooks'
import { longPress } from './context_menu'
import { ForwardCard, forwardAction } from './forwards'
import { groupPadCls, gutterTimeCls } from './grouped_row'
import { Inset, Row, Surface } from './layout'
import { MarkdownMessage } from './markdown_message'
import { Name } from './name'
import { personCalled, personName } from '../lib/names'
import { shownUser } from '../lib/people'
import { MessageEditor, editAction, type EditBinding } from './message_editor'
import { MessageToolbar, type ToolbarAction } from './message_toolbar'
import { KeyAvatar } from './p2p/p2p_badge'
import { PollCard } from './poll_card'
import { profileTrigger } from './profile_card'
import { ReactionBar } from './reactions'
import { ReplyPreview } from './replies'
import { RoleIcon } from './role_icon'
import { ShownName, useShown } from './shown_user'
import { MessageTime, ShortTime } from './timestamp'
import { Masked } from './ui'
import { UnreadDivider } from './unread_banner'
import { UserAvatar } from './user_avatar'
import { WebhookBadge } from './webhooks'

export const avatarTriggerCls =
  'block cursor-pointer rounded-full outline-offset-2 hover:opacity-85 focus-visible:outline-2 focus-visible:outline-primary'

// Avatar on the left; name and `meta` (the time) above `children` on the right.
export function AuthorRow({
  author,
  server,
  ik,
  size,
  color,
  icon,
  meta,
  children,
}: {
  author: UserRef
  server: string | null
  // The author's identity key, where the place knows people by key: the row shows the key's
  // picture and opens no profile.
  ik?: string
  size: number
  color?: string
  icon?: Look['icon']
  meta: ReactNode
  children: ReactNode
}) {
  const store = useStoreApi()
  const shown = useShown(author, server)
  if (ik !== undefined)
    return (
      <Row gap="md" align="stretch">
        <div className="shrink-0">
          <KeyAvatar person={shownUser({ ...author, username: ik }, null)} size={size} />
        </div>
        <div className="min-w-0 flex-1">
          <Row gap="sm" align="baseline" wrap>
            <Name
              of={personCalled(author.display_name, author.username)}
              color={color}
              look="min-w-0 truncate text-sm font-medium"
            />
            <RoleIcon emoji={icon?.emoji} role={icon?.role} />
            {meta}
          </Row>
          {children}
        </div>
      </Row>
    )
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

// The name color and role icon of a row's author, as row props.
export const authorLook = (look: Look | undefined) => ({
  color: look?.color,
  icon: look?.icon?.emoji,
  iconRole: look?.icon?.role,
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
  // The server whose member looks and profile cards the author shows; null without one.
  server: string | null
  // The author's identity key, where the place knows people by key.
  ik?: string
  color: string | undefined
  // The emoji of the author's role icon and the role's name.
  icon: string | undefined
  iconRole: string | undefined
  quoteColor?: string
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
  // The edit in progress on this row: the account's own (`true`), or the place's binding.
  editing: EditBinding | boolean
  // A place that loads nothing by itself: text shows only when there is some, and forwards
  // are drawn from the copy they carry.
  local?: boolean
  // What draws the files the place keeps with the message.
  Files?: ComponentType<{ m: Message }>
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
          <button
            onClick={() => on.retry?.(m)}
            className="text-xs font-medium text-error hover:underline"
          >
            Retry
          </button>
        )}
        {canDrop && (
          <button
            onClick={e => on.remove(m, e.shiftKey)}
            className="text-xs font-medium text-error hover:underline"
          >
            Delete
          </button>
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
  const { m, first, last, mentioned, divider, flash, server, ik, on } = props
  const { inThread = false, local = false, chip = false, canTrim = false, editing, Files } = props
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
  const editor = editing ? (
    <MessageEditor binding={editing === true ? undefined : editing} />
  ) : undefined
  const body = (
    <>
      {m.forward ? (
        <ForwardCard m={m} canDelete={canTrim} local={local} />
      ) : m.kind === 'poll' ? (
        <PollCard m={m} canVote={props.canVote ?? false} />
      ) : (
        (!local || m.content.trim() !== '' || editor) && (
          <MarkdownMessage message={m} canDelete={canTrim} editor={editor} />
        )
      )}
      {Files && <Files m={m} />}
      <ReactionBar m={m} canReact={canReact} canRemove={props.canUnreact} />
      {chip && m.reply_count > 0 && (
        <Surface
          as="button"
          title="Open thread"
          data-thread-chip
          onClick={() => on.thread(m)}
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
  const status = props.sent ? <Sent {...props} /> : null
  return (
    <div data-row data-mid={m.id} data-event={props.event}>
      {divider && <UnreadDivider />}
      <div
        {...longPress((x, y) => on.menu(m, x, y))}
        data-flash={flash ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        className={`group relative ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : inThread ? 'hover:bg-surface-container' : 'hover:bg-surface-container-low'}`}
      >
        {m.reply_to && (
          <ReplyPreview
            quote={m.reply_to}
            avatar={size}
            color={props.quoteColor}
            local={local}
            onJump={on.jump}
          />
        )}
        {first ? (
          <AuthorRow
            author={m.author}
            server={server}
            ik={ik}
            size={size}
            color={props.color}
            icon={
              props.icon && props.iconRole !== undefined
                ? { emoji: props.icon, role: props.iconRole }
                : undefined
            }
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
            name={
              ik === undefined ? (
                <ShownName user={m.author} server={server} />
              ) : (
                <Masked text={m.author.display_name} by={m.author.username} />
              )
            }
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
