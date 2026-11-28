// A message's menu in the message list and the thread panel, and the menus of its embeds, of
// timestamps in its text, and of inbox rows. The author's rows are the member actions.

import { ask, sendTo } from '../asks'
import {
  AtSign,
  Check,
  Clock,
  Copy,
  ExternalLink,
  Forward,
  Hash,
  Link,
  Lock,
  LockOpen,
  MessageSquareText,
  Pencil,
  Pin,
  PinOff,
  Reply,
  Server,
  SquareCheckBig,
  Trash2,
  Users,
} from 'lucide-react'
import { isGuestName } from '../guest_voice'
import { locatedNow } from '../forward_locate'
import { hostedPill } from '../forward_pill'
import { messageLinkUrl } from '../message_links'
import { openMessageLink } from '../link_open'
import { sharing } from '../platform'
import { pollClosed, votersShown } from '../polls'
import { selectable } from '../selection'
import { canDeleteIn } from '../selection_store'
import { channelCan, messageServer, myPerms, myTimeoutEnds } from '../store'
import type { RChatState } from '../store_types'
import { isNotice } from '../system_messages'
import { messageStampToken } from '../timestamps'
import { Perm, hasPerm, type Message } from '../types'
import { isWebhookMessage, webhookIdOf } from '../webhooks'
import { messageFlags } from '../place/rows'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

const copy = (text: string) => void sharing().copyText(text)

// The author, or in a channel someone with Manage messages, may close and reopen. Nobody while
// timed out in the poll's server.
export const managesPoll = (s: RChatState, m: Message) => {
  if (!s.me || s.guest || m.kind !== 'poll' || m.poll?.snapshot) return false
  const server = messageServer(s, m)
  if (myTimeoutEnds(s, server) !== null) return false
  if (m.author.username === s.me.username) return true
  return server !== null && channelCan(s, server, m.channel_id).manage
}

// The message a menu is on, with its list.
const onMessage = (ctx: ActionCtx) => {
  const t = ctx.target
  return t.kind === 'message' ? { m: t.message, list: t.list } : null
}

// In the thread panel; `root`: its root.
const threadRow = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  return at && at.list.startsWith('t') ? { root: at.m.id === Number(at.list.slice(1)) } : null
}

// What the message's row may do.
const flags = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  return at && messageFlags(ctx.s, at.m, at.list)
}

// Signed-out readers copy anything; signed-in ones copy only the id of a notice.
export const copiesAll = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  return !!at && (!ctx.s.me || !isNotice(at.m))
}

const linkOf = (ctx: ActionCtx, m: Message) =>
  messageLinkUrl(m, messageServer(ctx.s, m), ctx.acct.shareOrigin)

// Where a forwarded copy's original is, as the viewer's lookup answered.
const originOf = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  const fwd = at?.m.forward
  if (!at || !fwd) return null
  return hostedPill(ctx.s, at.m, locatedNow(ctx.acct, fwd.source_id))
}

// Runs `f` on the target message and its list.
const withMessage = (f: (m: Message, list: string, ctx: ActionCtx) => void) => (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  if (at) f(at.m, at.list, ctx)
}

const message = { scope: 'message', targets: ['message'] } as const

export const messageActions: Action[] = [
  {
    id: 'message_pause_guest',
    title: 'Pause guest posting',
    icon: Clock,
    ...message,
    order: 290,
    danger: true,
    available: ctx => {
      const at = onMessage(ctx)
      if (!at || !signedIn(ctx.s) || !isGuestName(at.m.author.username)) return false
      const name = messageServer(ctx.s, at.m)
      return name !== null && hasPerm(myPerms(ctx.s, name), Perm.TimeoutMembers)
    },
    run: withMessage((m, _list, ctx) =>
      ctx.acct.store.getState().askConfirm({
        title: 'Pause guest posting?',
        body: 'Stops this guest and new guest sessions from their address from posting here for 10 minutes.',
        confirm: 'Pause posting',
        action: () => {
          void sendTo(ctx.acct, ask.pauseGuestPosting(m.id)).catch(
            ctx.acct.lifetime.inSession((e: Error) => ctx.acct.store.getState().setError(e.message))
          )
        },
      })
    ),
  },
  {
    id: 'message_edit',
    title: 'Edit Message',
    icon: Pencil,
    ...message,
    order: 100,
    available: ctx => !!flags(ctx)?.canEdit,
    run: withMessage((m, list, ctx) => ctx.acct.store.getState().startEdit(list, m)),
  },
  {
    id: 'message_reply',
    title: 'Reply',
    icon: Reply,
    ...message,
    order: 110,
    available: ctx => !!flags(ctx)?.canReply,
    run: withMessage((m, list, ctx) => ctx.acct.store.getState().startReply(list, m)),
  },
  {
    id: 'message_forward',
    title: 'Forward',
    icon: Forward,
    ...message,
    order: 120,
    available: ctx => !!flags(ctx)?.canForward,
    run: withMessage((m, _list, ctx) => ctx.acct.store.getState().copyForward(m)),
  },
  {
    id: 'message_open_original',
    title: 'Open original message',
    icon: ExternalLink,
    ...message,
    order: 125,
    available: ctx => {
      const pill = originOf(ctx)
      return pill?.kind === 'open' || (pill?.kind === 'dm' && pill.open)
    },
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().openForward(m)),
  },
  {
    id: 'message_open_source_server',
    title: 'Open server',
    icon: Server,
    ...message,
    order: 126,
    available: ctx => originOf(ctx)?.kind === 'open',
    run: ctx => {
      const pill = originOf(ctx)
      if (pill?.kind === 'open') void ctx.acct.store.getState().openServer(pill.server.key)
    },
  },
  {
    id: 'message_thread',
    title: 'Reply in thread',
    icon: MessageSquareText,
    ...message,
    order: 130,
    available: ctx => !!flags(ctx)?.thread,
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().openThread(m)),
  },
  {
    id: 'message_pin',
    title: 'Pin Message',
    icon: Pin,
    ...message,
    order: 300,
    available: ctx => !!flags(ctx)?.canPin && !ctx.message?.pinned_at,
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().pinMessage(m.id)),
  },
  {
    id: 'message_unpin',
    title: 'Unpin Message',
    icon: PinOff,
    ...message,
    order: 300,
    available: ctx => !!flags(ctx)?.canPin && !!ctx.message?.pinned_at,
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().unpinMessage(m.id)),
  },
  {
    id: 'poll_voters',
    title: 'View Votes',
    icon: Users,
    ...message,
    order: 310,
    available: ctx => {
      const at = onMessage(ctx)
      return (
        !!at && at.m.kind === 'poll' && votersShown(at.m.poll) && (!!ctx.s.me || !!threadRow(ctx))
      )
    },
    run: withMessage((m, _list, ctx) =>
      ctx.acct.store.getState().openDialog({ kind: 'poll_voters', message: m })
    ),
  },
  {
    id: 'poll_close',
    title: 'Close Poll',
    icon: Lock,
    ...message,
    order: 320,
    available: ctx => {
      const at = onMessage(ctx)
      return !!at?.m.poll && managesPoll(ctx.s, at.m) && !pollClosed(at.m.poll)
    },
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().closePoll(m.id)),
  },
  {
    id: 'poll_reopen',
    title: 'Reopen Poll',
    icon: LockOpen,
    ...message,
    order: 320,
    available: ctx => {
      const at = onMessage(ctx)
      return !!at?.m.poll && managesPoll(ctx.s, at.m) && pollClosed(at.m.poll)
    },
    run: withMessage((m, _list, ctx) => void ctx.acct.store.getState().reopenPoll(m.id)),
  },
  {
    id: 'message_select',
    title: 'Select Message',
    icon: SquareCheckBig,
    ...message,
    order: 500,
    available: ctx => {
      const at = onMessage(ctx)
      return (
        !!at &&
        signedIn(ctx.s) &&
        !threadRow(ctx)?.root &&
        selectable(at.m, canDeleteIn(ctx.s, at.list, at.m))
      )
    },
    run: withMessage((m, list, ctx) => ctx.acct.store.getState().startSelection(list, m)),
  },
  {
    id: 'message_delete',
    title: 'Delete Message',
    icon: Trash2,
    danger: true,
    ...message,
    order: 510,
    orderFor: ctx => (ctx.message && isNotice(ctx.message) ? 495 : 510),
    available: ctx => !!flags(ctx)?.canDelete,
    run: withMessage((m, _list, ctx) => ctx.acct.store.menu.confirmDeleteMessage(m.id)),
  },
  {
    id: 'message_copy_text',
    title: 'Copy Text',
    icon: Copy,
    ...message,
    order: 900,
    available: ctx => copiesAll(ctx) && !!ctx.message?.content.trim(),
    run: withMessage(m => copy(m.content)),
  },
  {
    id: 'message_copy_link',
    title: 'Copy Message Link',
    icon: Link,
    ...message,
    order: 910,
    available: ctx => copiesAll(ctx) && !!ctx.message && linkOf(ctx, ctx.message) !== null,
    run: withMessage((m, _list, ctx) => {
      const link = linkOf(ctx, m)
      if (link) copy(link)
    }),
  },
  {
    id: 'message_copy_timestamp',
    title: 'Copy Timestamp',
    icon: Clock,
    ...message,
    order: 920,
    available: copiesAll,
    run: withMessage(m => copy(messageStampToken(m.created_at))),
  },
  {
    id: 'message_copy_id',
    title: 'Copy Message ID',
    icon: Hash,
    ...message,
    order: 930,
    available: ctx => onMessage(ctx) !== null,
    run: withMessage(m => copy(String(m.id))),
  },
  {
    id: 'message_copy_webhook_id',
    title: 'Copy Webhook ID',
    icon: AtSign,
    ...message,
    order: 940,
    available: ctx => copiesAll(ctx) && !!ctx.message && isWebhookMessage(ctx.message),
    run: withMessage(m => copy(String(webhookIdOf(m.author.username) ?? ''))),
  },
]

const onEmbed = (ctx: ActionCtx) => {
  const t = ctx.target
  return t.kind === 'embed' && ctx.list !== null && messageFlags(ctx.s, t.message, ctx.list).canTrim
    ? t
    : null
}

const embed = { scope: 'message', targets: ['embed'] } as const

export const embedActions: Action[] = [
  {
    id: 'embed_remove',
    title: 'Remove embed',
    danger: true,
    ...embed,
    order: 100,
    available: ctx => onEmbed(ctx) !== null,
    run: ctx => {
      const t = onEmbed(ctx)
      if (t) void ctx.acct.store.getState().deleteEmbed(t.message.id, t.ord, false)
    },
  },
  {
    id: 'embed_remove_banner',
    title: 'Remove banner',
    danger: true,
    ...embed,
    order: 110,
    available: ctx => !!onEmbed(ctx)?.banner,
    run: ctx => {
      const t = onEmbed(ctx)
      if (t) void ctx.acct.store.getState().deleteEmbed(t.message.id, t.ord, true)
    },
  },
  {
    id: 'embed_remove_all',
    title: 'Remove all embeds',
    danger: true,
    ...embed,
    order: 120,
    available: ctx => onEmbed(ctx) !== null,
    run: ctx => {
      const t = onEmbed(ctx)
      if (t)
        for (const e of t.message.embeds)
          void ctx.acct.store.getState().deleteEmbed(t.message.id, e.ord, false)
    },
  },
  {
    id: 'link_open',
    title: 'Open Link',
    icon: ExternalLink,
    scope: 'message',
    targets: ['link'],
    available: ({ target }) => target.kind === 'link',
    run: ({ acct, target }) => {
      if (target.kind === 'link') openMessageLink(acct, target.href, target.label, target.own)
    },
  },
  {
    id: 'link_copy',
    title: 'Copy Link',
    icon: Link,
    scope: 'message',
    targets: ['link'],
    available: ({ target }) => target.kind === 'link',
    run: ({ target }) => {
      if (target.kind === 'link') copy(target.href)
    },
  },
  {
    id: 'timestamp_copy',
    title: 'Copy Timestamp',
    icon: Clock,
    scope: 'message',
    targets: ['timestamp'],
    available: ({ target }) => target.kind === 'timestamp',
    run: ({ target }) => {
      if (target.kind === 'timestamp') copy(target.token)
    },
  },
  {
    id: 'inbox_open',
    title: 'Jump to message',
    label: ({ target }) =>
      target.kind === 'inbox' && target.entry.where.kind === 'friends'
        ? 'Open friends'
        : 'Jump to message',
    icon: ExternalLink,
    scope: 'message',
    targets: ['inbox'],
    order: 100,
    available: ({ target }) => target.kind === 'inbox',
    run: ({ target }) => {
      if (target.kind === 'inbox') target.open()
    },
  },
  {
    id: 'thread_open',
    title: 'Open thread',
    icon: MessageSquareText,
    scope: 'message',
    targets: ['thread'],
    order: 100,
    available: ({ target }) => target.kind === 'thread',
    run: ({ target }) => {
      if (target.kind === 'thread') target.open()
    },
  },
  {
    id: 'thread_jump',
    title: 'Jump to message',
    icon: ExternalLink,
    scope: 'message',
    targets: ['thread'],
    order: 110,
    available: ({ target }) => target.kind === 'thread',
    run: ({ target }) => {
      if (target.kind === 'thread') target.jump()
    },
  },
  {
    id: 'inbox_mark_read',
    title: 'Mark as read',
    icon: Check,
    scope: 'message',
    targets: ['inbox'],
    order: 110,
    available: ({ target }) => target.kind === 'inbox' && target.entry.unread,
    run: ({ target }) => {
      if (target.kind === 'inbox') target.read()
    },
  },
]
