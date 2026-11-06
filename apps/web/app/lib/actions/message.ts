// A message's menu in the message list and the thread panel, and the menus of its embeds, of
// timestamps in its text, and of inbox rows. The author's rows are the member actions.

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
  SquareCheckBig,
  Trash2,
  Users,
} from 'lucide-react'
import { canForward } from '../forward'
import { messageLinkUrl } from '../message_links'
import { sharing } from '../platform'
import { canPin } from '../pins'
import { pollClosed, votersShown } from '../polls'
import { readOnly } from '../reactions'
import { canQuote } from '../replies'
import { canEdit as ownEditable } from '../sed'
import { selectable } from '../selection'
import { canDeleteIn } from '../selection_store'
import { confirmDeleteMessage, messageServer, myPerms, myTimeoutEnds, useStore } from '../store'
import type { RChatState } from '../store_types'
import { isNotice } from '../system_messages'
import { messageStampToken } from '../timestamps'
import { Perm, hasPerm, type Message } from '../types'
import { isWebhookMessage, webhookIdOf } from '../webhooks'
import { signedIn } from './global'
import type { Action, ActionCtx } from './types'

const get = () => useStore.getState()

const copy = (text: string) => void sharing().copyText(text)

export interface MessageRights {
  react: boolean
  edit: boolean
  delete: boolean
  pin: boolean
  forward: boolean
  quote: boolean
}

// What you may do to a message in `list`. A thread list never pins.
export const messageRights = (s: RChatState, m: Message, list: string): MessageRights => {
  const me = s.me
  const signed = signedIn(s)
  const dm = list.startsWith('d')
  const server = dm ? null : messageServer(s, m)
  const member = server !== null && !!me?.servers.some(x => x.name === server)
  const free = myTimeoutEnds(s, server) === null
  const manages = server !== null && hasPerm(myPerms(s, server), Perm.DeleteMessages)
  const writable = server !== null && !readOnly(s.servers[server], m.channel_id)
  const react = signed && (dm || (member && writable && free))
  return {
    react,
    edit: react && ownEditable(m, me?.username),
    quote: react && canQuote(m),
    forward: signed && canForward(m),
    delete: signed && (m.author.username === me?.username || manages),
    pin: signed && !list.startsWith('t') && (dm || (member && manages)) && free && canPin(m),
  }
}

// The author, or in a channel someone with Manage messages, may close and reopen. Nobody while
// timed out in the poll's server.
export const managesPoll = (s: RChatState, m: Message) => {
  if (!s.me || s.guest || m.kind !== 'poll' || m.poll?.snapshot) return false
  const server = messageServer(s, m)
  if (myTimeoutEnds(s, server) !== null) return false
  if (m.author.username === s.me.username) return true
  return server !== null && hasPerm(myPerms(s, server), Perm.DeleteMessages)
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

const rights = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  return at && messageRights(ctx.s, at.m, at.list)
}

// Signed-out readers copy anything; signed-in ones copy only the id of a notice.
export const copiesAll = (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  return !!at && (!ctx.s.me || !isNotice(at.m))
}

const linkOf = (s: RChatState, m: Message) => messageLinkUrl(m, messageServer(s, m))

// Runs `f` on the target message and its list.
const withMessage = (f: (m: Message, list: string, ctx: ActionCtx) => void) => (ctx: ActionCtx) => {
  const at = onMessage(ctx)
  if (at) f(at.m, at.list, ctx)
}

const message = { scope: 'message', targets: ['message'] } as const

export const messageActions: Action[] = [
  {
    id: 'message_edit',
    title: 'Edit Message',
    icon: Pencil,
    ...message,
    order: 100,
    available: ctx => !!rights(ctx)?.edit,
    run: withMessage((m, list) => get().startEdit(list, m)),
  },
  {
    id: 'message_reply',
    title: 'Reply',
    icon: Reply,
    ...message,
    order: 110,
    available: ctx => !!rights(ctx)?.quote,
    run: withMessage((m, list) => get().startReply(list, m)),
  },
  {
    id: 'message_forward',
    title: 'Forward',
    icon: Forward,
    ...message,
    order: 120,
    available: ctx => !!rights(ctx)?.forward,
    run: withMessage(m => get().copyForward(m)),
  },
  {
    id: 'message_thread',
    title: 'Reply in thread',
    icon: MessageSquareText,
    ...message,
    order: 130,
    available: ctx => {
      const at = onMessage(ctx)
      return !!at && signedIn(ctx.s) && at.list.startsWith('c') && !isNotice(at.m)
    },
    run: withMessage(m => void get().openThread(m)),
  },
  {
    id: 'message_pin',
    title: 'Pin Message',
    icon: Pin,
    ...message,
    order: 300,
    available: ctx => !!rights(ctx)?.pin && !ctx.message?.pinned_at,
    run: withMessage(m => void get().pinMessage(m.id)),
  },
  {
    id: 'message_unpin',
    title: 'Unpin Message',
    icon: PinOff,
    ...message,
    order: 300,
    available: ctx => !!rights(ctx)?.pin && !!ctx.message?.pinned_at,
    run: withMessage(m => void get().unpinMessage(m.id)),
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
    run: withMessage(m => get().openDialog({ kind: 'poll_voters', message: m })),
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
    run: withMessage(m => void get().closePoll(m.id)),
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
    run: withMessage(m => void get().reopenPoll(m.id)),
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
    run: withMessage((m, list) => get().startSelection(list, m)),
  },
  {
    id: 'message_delete',
    title: 'Delete Message',
    icon: Trash2,
    danger: true,
    ...message,
    order: 510,
    orderFor: ctx => (ctx.message && isNotice(ctx.message) ? 495 : 510),
    available: ctx => !!rights(ctx)?.delete && !threadRow(ctx)?.root,
    run: withMessage(m => confirmDeleteMessage(m.id)),
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
    available: ctx => copiesAll(ctx) && !!ctx.message && linkOf(ctx.s, ctx.message) !== null,
    run: withMessage((m, _list, ctx) => {
      const link = linkOf(ctx.s, m)
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
  return t.kind === 'embed' && ctx.list !== null && messageRights(ctx.s, t.message, ctx.list).delete
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
      if (t) void get().deleteEmbed(t.message.id, t.ord, false)
    },
  },
  {
    id: 'embed_remove_banner',
    title: 'Remove banner',
    ...embed,
    order: 110,
    available: ctx => !!onEmbed(ctx)?.banner,
    run: ctx => {
      const t = onEmbed(ctx)
      if (t) void get().deleteEmbed(t.message.id, t.ord, true)
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
      if (t) for (const e of t.message.embeds) void get().deleteEmbed(t.message.id, e.ord, false)
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
