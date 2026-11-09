'use client'

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import {
  ArrowLeft,
  ArrowRight,
  CircleAlert,
  Check,
  Clock,
  Copy,
  EyeOff,
  Forward,
  Hash,
  History,
  MessageSquareText,
  Pin,
  PinOff,
  Plus,
  Reply,
  SendHorizontal,
  Smile,
  Trash2,
  X,
} from 'lucide-react'
import { maskOf, useStore, type ContextMenuItem } from '../../lib/store'
import { noticeOpen } from '../../lib/home'
import { hideTip, useHome } from '../../lib/home_store'
import {
  chatKey,
  chatScope,
  p2pDm,
  p2pFiles,
  p2pThread,
  p2pUser,
  profileName,
  useP2p,
  type P2pChat,
} from '../../lib/p2p/app'
import { displayName } from '../../lib/p2p/contacts'
import { hiddenRemovedText, SLOW_HIDDEN_TEXT } from '../../lib/p2p/flows'
import {
  bodyTooLong,
  messageActs,
  STORAGE_FULL_TEXT,
  PEER_FULL_TEXT,
  type P2pMessage,
} from '../../lib/p2p/dm'
import { emojiBase } from '../../lib/reactions'
import { LIMITS as P2P_LIMITS } from '../../lib/p2p/content'
import { charCount, counterFrom } from '../../lib/rules'
import { clock } from '../../lib/slowmode'
import { useCountdown } from '../../lib/countdown'
import { composing, sendKey } from '../../lib/keys'
import { spliceText } from '../../lib/autocomplete'
import { loadEmojiData } from '../../lib/emoji'
import { newSince } from '../../lib/lists'
import { plainLine } from '../../lib/replies'
import { messageStampToken } from '../../lib/timestamps'
import { systemParts } from '../../lib/system_messages'
import { sharing } from '../../lib/platform'
import type { ForwardClip } from '../../lib/forward'
import type { Message, UserRef } from '../../lib/types'
import { ChatSourceProvider, type ChatSource } from '../chat_source'
import { MarkdownMessage } from '../markdown_message'
import { MessageEditor, editAction, editMenuItem, type EditBinding } from '../message_editor'
import { MessageToolbar, type ToolbarAction } from '../message_toolbar'
import { QuickReactions, ReactionBar, rowAt } from '../reactions'
import { ComposerBar, ReplyPreview } from '../replies'
import { ForwardBar, ForwardCard, forwardAction } from '../forwards'
import { PinLine, PinsPanel, confirmUnpin } from '../pins'
import { TypingIndicator } from '../typing_indicator'
import { EmojiPicker, SHEET_QUERY } from '../emoji_picker'
import { longPress, useMedia } from '../context_menu'
import { useTextAssist } from '../text_assist'
import { MessageTime } from '../timestamp'
import { PresentBar, useChatScroll, useFocusMessage } from '../viewport_height'
import { mentionRowCls } from '../message_pane'
import { Masked, textBtn } from '../ui'
import { KeyAvatar, P2pBadge } from './p2p_badge'
import { AttachmentList, attachmentMenu, PendingFiles } from './p2p_files'
import { namePasted } from '../message_composer'
import { FormatToolbar, useFormatting } from '../format_toolbar'
import { P2pCallRow } from './p2p_call'

// The message list and composer of a P2P conversation, shared by direct messages and P2P server
// channels: what differs (the header, who may do what, names, mentions) comes in as props.

const BODY_MAX = P2P_LIMITS.body
const EMPTY: P2pMessage[] = []

// Shared message components key rows by a number that grows in display order (jumps and the
// unread line rely on it): display time in ms times 1000, plus a counter for ties.
export const numbering = (list: P2pMessage[]) => {
  const num = new Map<string, number>()
  let last = 0
  for (const m of list) {
    const n = Math.max(m.ts * 1000, last + 1)
    num.set(m.id, n)
    last = n
  }
  return num
}

const seconds = (ms: number) => Math.floor(ms / 1000)

export const asMessage = (
  m: P2pMessage,
  num: number,
  replyNum: number,
  user: (ik: string) => UserRef,
  me: string
): Message => ({
  id: num,
  channel_id: null,
  dm_id: null,
  thread_root_id: null,
  author: user(m.sender),
  content: m.unavailable ? '_Message unavailable_' : m.fwd ? m.fwd.body : m.body,
  created_at: seconds(m.ts),
  reply_count: m.replies ?? 0,
  media: null,
  embeds: [],
  kind: m.system ? m.system.kind : 'user',
  call: null,
  reactions: m.reactions.map(r => ({
    emoji: r.key,
    count: r.count,
    me: r.me,
    first_at: seconds(r.first),
  })),
  reply_to: m.reply
    ? {
        id: replyNum,
        author: m.reply.sender ? user(m.reply.sender) : null,
        content: m.reply.body === null ? '' : plainLine(m.reply.body),
        has_media: false,
        deleted: m.reply.body === null,
        mention: m.reply.sender === me && m.sender !== me,
      }
    : null,
  edited_at: m.edited !== null ? seconds(m.edited) : null,
  forward: m.fwd
    ? {
        author: {
          username: m.fwd.name,
          display_name: m.fwd.name,
          avatar_kind: 'color',
          avatar_color: null,
        },
        created_at: seconds(m.fwd.ts),
        source_id: 0,
        origin: null,
        dropped: null,
      }
    : null,
  pinned_at: m.pinned !== null ? seconds(m.pinned) : null,
})

export const noteBarCls =
  'mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] flex shrink-0 flex-wrap items-center gap-2 rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant keyboard:mb-3'

// The note at the top of a conversation. Once closed it stays closed for the account, in every
// tab.
export function P2pIntro({ id, children }: { id: string; children: ReactNode }) {
  const account = useP2p(s => s.account)
  const open = useHome(s => noticeOpen(s.owner, account, s.prefs, id))
  if (!open) return null
  return (
    <div
      data-p2p-intro
      className="mx-4 mt-3 flex items-start gap-3 rounded-2xl border border-dashed border-tertiary bg-tertiary-container/40 px-4 py-3 text-sm text-on-surface"
    >
      <P2pBadge />
      <p className="min-w-0 flex-1">{children}</p>
      <button
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => hideTip(id)}
        className="shrink-0 rounded-full p-1 hover:bg-surface-container-highest"
      >
        <X size={16} />
      </button>
    </div>
  )
}

interface RowProps {
  p: P2pMessage
  m: Message
  mine: boolean
  pendingTip: string
  mentioned: boolean
  divider: boolean
  flash: boolean
  canAct: boolean
  canDelete: boolean
  editing: EditBinding | null
  // Where replies and edits of this row are written (the conversation, channel or thread).
  draftKey: string
  // A top-level message of a server channel: its thread can be made or opened.
  threads: boolean
  onMenu: (p: P2pMessage, m: Message, x: number, y: number) => void
  // Puts the row on the forward clipboard.
  onCopy: (p: P2pMessage, m: Message) => void
  onJump: (num: number) => void
}

// "Create thread" on a message without replies that we may answer, "View thread" once it has
// some.
// A message whose body isn't here ("Message unavailable") keeps its thread reachable; one from
// the copy a server was transferred from (spec 3.8) has none here.
export const threadAct = (p: P2pMessage, canAct: boolean) =>
  p.system || p.call || p.thread || p.noThread || p.archived
    ? null
    : p.replies
      ? 'View thread'
      : canAct && !p.unavailable
        ? 'Create thread'
        : null

export const P2pRow = memo(function P2pRow({
  p,
  m,
  mine,
  pendingTip,
  mentioned,
  divider,
  flash,
  canAct,
  canDelete,
  editing,
  draftKey,
  threads,
  onMenu,
  onCopy,
  onJump,
}: RowProps) {
  const actions: ToolbarAction[] = []
  // From the old copy (spec 3.8): read-only here.
  const act = canAct && !p.archived
  const can = messageActs(p, act, mine)
  const thread = threads ? threadAct(p, act) : null
  if (can.edit && !editing) actions.push(editAction(() => p2pDm.startEdit(draftKey, p.id)))
  if (can.reply)
    actions.push({
      key: 'reply',
      label: 'Reply',
      icon: Reply,
      onClick: () => p2pDm.startReply(draftKey, p.id),
    })
  if (can.forward) actions.push(forwardAction(() => onCopy(p, m)))
  if (thread)
    actions.push({
      key: 'thread',
      label: thread,
      icon: MessageSquareText,
      onClick: () => void p2pThread.open(p.id),
    })
  if (act && canDelete)
    actions.push({
      key: 'delete',
      label: 'Delete message (hold Shift to skip confirmation)',
      icon: Trash2,
      danger: true,
      onClick: e => confirmDelete(p.id, e.shiftKey),
    })
  const status = mine ? (
    p.failed ? (
      <span data-failed className="flex shrink-0 items-center gap-1.5 text-xs text-error">
        <CircleAlert size={12} aria-hidden />
        Not sent
        {canAct && (
          <>
            <button onClick={() => void p2pDm.retry(p.id)} className="font-medium hover:underline">
              Retry
            </button>
            <button
              onClick={e => confirmDelete(p.id, e.shiftKey)}
              className="font-medium hover:underline"
            >
              Delete
            </button>
          </>
        )}
      </span>
    ) : p.pending ? (
      <span
        data-pending
        role="img"
        title={pendingTip}
        aria-label="Not delivered yet"
        className="flex shrink-0 text-on-surface-variant"
      >
        <Clock size={12} />
      </span>
    ) : (
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
  ) : null
  return (
    <div data-row data-mid={m.id} data-event={p.id}>
      {divider && (
        <div data-divider className="px-4 py-1" aria-hidden>
          <div className="h-0.5 rounded-full bg-error" />
        </div>
      )}
      <div
        {...longPress((x, y) => onMenu(p, m, x, y))}
        data-flash={flash ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        className={`group relative px-4 py-1.5 ${mentioned ? mentionRowCls : 'hover:bg-surface-container-low'}`}
      >
        {m.reply_to && <ReplyPreview quote={m.reply_to} avatar={36} onJump={onJump} />}
        <div className="flex gap-3">
          <div className="shrink-0 pt-0.5">
            <KeyAvatar ik={p.sender} size={36} />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
              <span className="streamer min-w-0 truncate text-sm font-medium">
                <Masked text={m.author.display_name} by={m.author.username} />
              </span>
              <MessageTime ts={m.created_at} className="shrink-0 text-xs text-on-surface-variant" />
              {p.late && (
                <span
                  data-late
                  title={`Sent ${new Date(p.sentTs).toLocaleString()}`}
                  className="shrink-0 text-[11px] text-on-surface-variant italic"
                >
                  sent earlier, arrived later
                </span>
              )}
              {status}
            </div>
            {m.forward ? (
              <ForwardCard m={m} canDelete={false} local />
            ) : (
              (m.content.trim() !== '' || editing) && (
                <MarkdownMessage
                  message={m}
                  editor={editing ? <MessageEditor binding={editing} /> : undefined}
                />
              )
            )}
            <AttachmentList att={p.fwd?.att ?? p.att} canFetch={canAct} own={!p.fwd && mine} />
            <ReactionBar m={m} canReact={act} canRemove={act} />
            {threads && !!p.replies && !p.archived && (
              <button
                title="Open thread"
                data-p2p-thread-chip
                onClick={() => void p2pThread.open(p.id)}
                className="mt-1 flex items-center gap-1.5 rounded-full bg-surface-container px-2.5 py-1 text-xs font-medium text-primary hover:bg-surface-container-high"
              >
                <MessageSquareText size={12} />
                {p.replies} {p.replies === 1 ? 'reply' : 'replies'}
              </button>
            )}
          </div>
        </div>
        <MessageToolbar
          m={m}
          react={canAct}
          actions={actions}
          onMore={(x, y) => onMenu(p, m, x, y)}
        />
      </div>
    </div>
  )
})

// "alice joined the party." in a server's system channel, made here from a member event.
function P2pSystemRow({ m, divider }: { m: Message; divider: boolean }) {
  const [before, after] = systemParts(m)
  const join = m.kind === 'join'
  const Arrow = join ? ArrowRight : ArrowLeft
  return (
    <div data-row data-mid={m.id}>
      {divider && (
        <div data-divider className="px-4 py-1" aria-hidden>
          <div className="h-0.5 rounded-full bg-error" />
        </div>
      )}
      <div data-system={m.kind} className="flex items-start gap-3 px-4 py-1">
        <span
          className={`flex w-9 shrink-0 justify-center pt-0.5 ${join ? 'text-status-green' : 'text-error'}`}
        >
          <Arrow size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
          {before}
          <span className="streamer font-medium text-on-surface">
            <Masked text={m.author.display_name} by={m.author.username} />
          </span>
          {after}
          <MessageTime ts={m.created_at} className="ml-2 text-xs opacity-70" />
        </p>
      </div>
    </div>
  )
}

// "alice pinned a message to this channel. See all pinned messages."
function P2pPinRow({
  p,
  m,
  divider,
  place,
  onMenu,
}: {
  p: P2pMessage
  m: Message
  divider: boolean
  place: 'conversation' | 'channel'
  onMenu: (p: P2pMessage, x: number, y: number) => void
}) {
  const target = p.system?.target ?? null
  return (
    <PinLine
      row={{ 'data-row': '', 'data-mid': m.id, 'data-event': p.id }}
      inner={{ 'data-system': 'pin' }}
      divider={
        divider && (
          <div data-divider className="px-4 py-1" aria-hidden>
            <div className="h-0.5 rounded-full bg-error" />
          </div>
        )
      }
      press={longPress((x, y) => onMenu(p, x, y))}
      name={
        <span className="streamer font-medium text-on-surface">
          <Masked text={m.author.display_name} by={m.author.username} />
        </span>
      }
      place={place}
      ts={m.created_at}
      onMessage={target ? () => void p2pDm.jumpTo(target) : null}
      onPins={() => void p2pDm.openPins()}
    />
  )
}

// Whether a row pings us: it mentions us, answers us, or mentions everyone.
export const pingsMe = (p: P2pMessage, me: string | null) =>
  p.sender !== me &&
  ((me !== null && p.mentions.includes(me)) || p.reply?.sender === me || p.everyone === true)

// The row a jump focused (`focus`), flashed once it shows; the focus is cleared then.
export function useP2pFlash(
  listRef: RefObject<HTMLDivElement | null>,
  scope: string,
  focus: { id: string } | null,
  num: Map<string, number>,
  shared: Message[],
  settle: Parameters<typeof useFocusMessage>[4]
) {
  const focusNum = focus ? (num.get(focus.id) ?? null) : null
  const focusObj = useMemo(
    () => (focus && focusNum !== null ? { id: focusNum, flash: true } : undefined),
    [focus, focusNum]
  )
  const flash = useFocusMessage(listRef, scope, focusObj, shared, settle)
  useEffect(() => {
    if (focus && focusNum !== null) p2pDm.clearFocus()
  }, [focus, focusNum])
  return flash
}

const pinLineMenu = (p: P2pMessage, m: Message): ContextMenuItem[] => {
  const target = p.system?.target ?? null
  return [
    ...(target
      ? [{ label: 'Jump to Message', icon: ArrowRight, action: () => void p2pDm.jumpTo(target) }]
      : []),
    { label: 'Pinned Messages', icon: Pin, action: () => void p2pDm.openPins() },
    {
      label: 'Copy Timestamp',
      icon: Clock,
      action: () => void sharing().copyText(messageStampToken(m.created_at)),
    },
    { label: 'Copy Message ID', icon: Hash, action: () => void sharing().copyText(p.id) },
  ]
}

// In place of a message sent around the time its author was removed (spec 8.2).
export function P2pHiddenRow({ m, divider }: { m: Message; divider: boolean }) {
  const [before, after] = hiddenRemovedText('\u0000').split('\u0000')
  return (
    <div data-row data-mid={m.id}>
      {divider && (
        <div data-divider className="px-4 py-1" aria-hidden>
          <div className="h-0.5 rounded-full bg-error" />
        </div>
      )}
      <div data-p2p-hidden className="flex items-start gap-3 px-4 py-1">
        <span className="flex w-9 shrink-0 justify-center pt-0.5 text-on-surface-variant">
          <EyeOff size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant italic">
          {before}
          <span className="streamer">
            <Masked text={m.author.display_name} by={m.author.username} />
          </span>
          {after}
          <MessageTime ts={m.created_at} className="ml-2 text-xs not-italic opacity-70" />
        </p>
      </div>
    </div>
  )
}

// In place of our own message slow mode hides (spec 3.5).
export function P2pSlowRow({ m, divider }: { m: Message; divider: boolean }) {
  return (
    <div data-row data-mid={m.id}>
      {divider && (
        <div data-divider className="px-4 py-1" aria-hidden>
          <div className="h-0.5 rounded-full bg-error" />
        </div>
      )}
      <div data-p2p-slow-hidden className="flex items-start gap-3 px-4 py-1">
        <span className="flex w-9 shrink-0 justify-center pt-0.5 text-on-surface-variant">
          <EyeOff size={16} aria-hidden />
        </span>
        <p className="min-w-0 flex-1 text-sm text-on-surface-variant italic">
          {SLOW_HIDDEN_TEXT}
          <MessageTime ts={m.created_at} className="ml-2 text-xs not-italic opacity-70" />
        </p>
      </div>
    </div>
  )
}

const confirmDelete = (id: string, skip = false) => {
  const run = () => void p2pDm.remove(id)
  if (skip) return run()
  const server = !!useP2p.getState().chat?.ch
  useStore.getState().askConfirm({
    title: 'Delete Message',
    body: server
      ? 'Delete this message? It is removed here now, and on other members’ devices as they sync.'
      : 'Delete this message? It is removed here now, and on the other device the next time you are both online.',
    confirm: 'Delete',
    action: run,
  })
}

// Puts a message on the forward clipboard: Send in another conversation forwards it there (a
// P2P one directly; an instance one after it says the text will be copied there).
export const copyForP2p = (p: P2pMessage, m: Message, author: string) => {
  const clip: ForwardClip = {
    id: 1 + Math.floor(Math.random() * 2 ** 40),
    author: p.fwd ? (m.forward?.author ?? null) : p2pUser(p.sender, author),
    snippet: plainLine(p.fwd ? p.fwd.body : p.body),
    has_media: false,
    created_at: p.fwd ? seconds(p.fwd.ts) : m.created_at,
    body: p.fwd ? p.fwd.body : p.body,
    p2p: true,
  }
  useStore.getState().copyForwardClip(clip)
}

// Forwards straight into a P2P conversation with a contact. `author`: the sender's own profile
// name (profileName), never a display string.
export const forwardTo = async (ik: string, p: P2pMessage, author: string) => {
  const fwd = p.fwd ?? {
    name: author,
    ts: p.sentTs,
    body: p.body,
    ...(p.att.length ? { att: p.att } : {}),
  }
  const target = await p2pDm.ensureRoom(ik)
  if (target && (await p2pDm.forward(target, fwd))) {
    const c = useP2p.getState().contacts.find(x => x.ik === ik)
    const s = useStore.getState()
    s.showToast('Forwarded to', c ? maskOf(s)(displayName(c)) : 'contact')
  }
}

// Someone a message can mention: who they are, and the handle the composer writes.
export interface Mentionable {
  ik: string
  name: string
  handle: string
}

// A row shown in the open conversation or thread.
const shownRow = (
  s: { chat: P2pChat | null; thread: { head: P2pMessage | null; messages: P2pMessage[] } | null },
  id: string | null
) =>
  id === null
    ? undefined
    : (s.chat?.messages.find(m => m.id === id) ??
      (s.thread?.head?.id === id ? s.thread.head : s.thread?.messages.find(m => m.id === id)))

export function P2pComposer({
  draftKey: key,
  scope,
  title,
  placeholder,
  nameOf,
  disabled,
}: {
  // Where the draft, files, reply and sends go (a conversation, channel or thread).
  draftKey: string
  scope: string
  title: string
  placeholder: string
  nameOf: (ik: string) => string
  disabled: ReactNode
}) {
  const text = useP2p(s => s.drafts[key] ?? '')
  const replying = useP2p(s => (s.replying?.room === key ? s.replying.id : null))
  const replyTo = useP2p(s => shownRow(s, replying))
  const forwarding = useStore(s => s.forwardClip !== null)
  const streamer = useStore(s => s.streamer)
  const sheet = useMedia(SHEET_QUERY)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const files = useP2p(s => s.attaching[key]?.length ?? 0)
  // A thread's replies count in its channel's slow mode (spec 3.5): the channel's countdown.
  const slowLeft = useCountdown(useP2p(s => s.slowUntil[key.split('#')[0]] ?? 0))
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const sel = useRef({ start: 0, end: 0 })
  const typedAt = useRef(0)
  const getText = () => useP2p.getState().drafts[key] ?? ''
  const setText = (v: string) => p2pDm.setDraft(key, v)
  const assist = useTextAssist({
    listKey: scope,
    text,
    getText,
    setText,
    inputRef,
    paused: pickerOpen,
    maxHeight: 160,
  })
  const formatting = useFormatting({ inputRef, getText, setText })

  const typing = focused && text.trim() !== ''
  useEffect(() => {
    if (!typing) {
      if (typedAt.current) p2pDm.typing(key, false)
      typedAt.current = 0
      return
    }
    const now = Date.now()
    if (now - typedAt.current < 3000) return
    typedAt.current = now
    p2pDm.typing(key, true)
  }, [typing, text, key])

  if (disabled) return <>{disabled}</>

  const count = charCount(text)
  const tooLong = count > BODY_MAX || bodyTooLong(text)
  const send = () => {
    if ((!text.trim() && !files) || tooLong || slowLeft > 0) return
    const sent = text
    void p2pDm.send(key, sent).then(ok => {
      if (ok && getText() === sent) setText('')
    })
    typedAt.current = 0
    p2pDm.typing(key, false)
  }
  const bar = replyTo ? (
    <ComposerBar onClose={p2pDm.cancelReply} closeLabel="Cancel reply">
      Replying to{' '}
      <span className="streamer font-semibold text-on-surface">
        <Masked text={nameOf(replyTo.sender)} by={replyTo.sender} />
      </span>
    </ComposerBar>
  ) : forwarding ? (
    <ForwardBar
      draftKey={scope}
      onSend={() => {
        const clip = useStore.getState().forwardClip
        if (!clip) return
        const author = clip.author?.display_name ?? 'Deleted user'
        void p2pDm
          .forward(key, {
            name: author,
            ts: clip.created_at * 1000,
            body: clip.body ?? clip.snippet,
          })
          .then(ok => {
            if (!ok) return
            if (useStore.getState().forwardClip?.id === clip.id) useStore.getState().clearForward()
            useStore.getState().showToast('Forwarded to', title)
          })
      }}
    />
  ) : null

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3">
      {pickerOpen && (
        <EmojiPicker
          anchor={emojiRef.current}
          onPick={e => {
            const cur = getText()
            const start = Math.min(sel.current.start, cur.length)
            const end = Math.min(Math.max(sel.current.end, start), cur.length)
            sel.current = { start: start + e.length, end: start + e.length }
            setText(spliceText(cur, start, end, e))
          }}
          onClose={() => {
            setPickerOpen(false)
            if (!sheet)
              requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }))
          }}
        />
      )}
      {!textOnly && <PendingFiles room={key} />}
      {slowLeft > 0 && (
        <p
          role="status"
          data-p2p-slow-left
          className="mb-1 flex items-center justify-end gap-1 px-3 text-xs text-on-surface-variant tabular-nums"
        >
          <Clock size={12} className="shrink-0" />
          Slow mode: {clock(slowLeft)}
        </p>
      )}
      {bar}
      <div
        className={`relative flex items-end gap-2 bg-surface-container-high px-3 py-2 ${bar ? 'rounded-b-3xl' : 'rounded-3xl'}`}
      >
        {assist.popups}
        <FormatToolbar open={formatting.selected} onFormat={formatting.apply} />
        {!textOnly && (
          <>
            <button
              title="Attach files"
              aria-label="Attach files"
              onClick={() => fileRef.current?.click()}
              className="shrink-0 rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface"
            >
              <Plus size={20} />
            </button>
            <input
              ref={fileRef}
              type="file"
              multiple
              data-p2p-file-input
              className="hidden"
              onChange={e => {
                p2pFiles.add(key, Array.from(e.target.files ?? []))
                e.target.value = ''
              }}
            />
          </>
        )}
        <textarea
          ref={inputRef}
          rows={1}
          data-p2p-composer
          {...assist.textarea}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            assist.textarea.onBlur()
            setFocused(false)
          }}
          onKeyDown={e => {
            if (assist.popupKey(e)) return
            if (formatting.onKeyDown(e)) return
            if (
              e.key === 'ArrowUp' &&
              !text &&
              !e.shiftKey &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !composing(e) &&
              p2pDm.editLast(key)
            ) {
              e.preventDefault()
              return
            }
            if (e.key === 'Escape' && !e.nativeEvent.isComposing && replyTo) {
              e.preventDefault()
              p2pDm.cancelReply()
              return
            }
            if (sendKey(e)) {
              e.preventDefault()
              send()
            }
          }}
          onPaste={e => {
            if (textOnly) return
            const pasted = Array.from(e.clipboardData.items)
              .filter(i => i.kind === 'file')
              .map(i => i.getAsFile())
              .filter((f): f is File => f !== null)
            if (!pasted.length) return
            e.preventDefault()
            p2pFiles.add(
              key,
              pasted.map(f => (f.name && f.name !== 'image.png' ? f : namePasted(f)))
            )
          }}
          placeholder={streamer ? 'Send a P2P message' : placeholder}
          className="max-h-40 min-w-0 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:whitespace-nowrap placeholder:text-on-surface-variant md:text-sm"
        />
        {(count > counterFrom(BODY_MAX) || tooLong) && (
          <span
            data-too-long={tooLong ? '' : undefined}
            title={
              count > BODY_MAX
                ? `Messages can be up to ${BODY_MAX} characters`
                : tooLong
                  ? 'This message takes too much space. Use fewer special characters.'
                  : `Messages can be up to ${BODY_MAX} characters`
            }
            className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
          >
            {count > BODY_MAX || !tooLong ? BODY_MAX - count : 'Too long'}
          </span>
        )}
        <button
          ref={emojiRef}
          type="button"
          title="Emoji"
          aria-label="Emoji"
          aria-expanded={pickerOpen}
          onPointerEnter={() => void loadEmojiData().catch(() => {})}
          onClick={() => {
            const el = inputRef.current
            if (el) sel.current = { start: el.selectionStart, end: el.selectionEnd }
            setPickerOpen(o => !o)
          }}
          className={`shrink-0 rounded-full p-1.5 ${
            pickerOpen
              ? 'bg-surface-container-highest text-primary'
              : 'text-on-surface-variant hover:bg-surface-container-highest hover:text-on-surface'
          }`}
        >
          <Smile size={20} />
        </button>
        <button
          title={
            tooLong
              ? 'Message is too long'
              : slowLeft > 0
                ? `Slow mode: ${clock(slowLeft)}`
                : 'Send'
          }
          aria-label="Send"
          onClick={send}
          disabled={tooLong || slowLeft > 0}
          className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}

// The rows of a conversation, channel or thread for the shared message components: numbered
// messages, the reaction and mention source, the edit binding and the row menu.
export interface ListOpts {
  messages: P2pMessage[]
  nameOf: (ik: string) => string
  // The sender's own profile name, for forwards (never a petname or a masked name).
  ownName: (ik: string) => string
  people: Mentionable[]
  draftKey: string
  scope: string
  canAct: boolean
  mayPin: boolean
  mayDelete: (p: P2pMessage) => boolean
  forwardSkip: string | null
  // A server channel's own list: its messages can start threads.
  threads: boolean
}

export function useP2pList({
  messages,
  nameOf,
  ownName,
  people,
  draftKey,
  scope,
  canAct,
  mayPin,
  mayDelete,
  forwardSkip,
  threads,
}: ListOpts) {
  const me = useP2p(s => s.me)
  const editingState = useP2p(s => (s.editing?.room === draftKey ? s.editing : null))
  const openContextMenu = useStore(s => s.openContextMenu)
  const [picker, setPicker] = useState<{ m: Message; anchor: HTMLElement | null } | null>(null)
  const user = useCallback((ik: string) => p2pUser(ik, nameOf(ik)), [nameOf])
  // Names the markdown recognizes as mentions, lowercased.
  const names = useMemo(() => {
    const out = new Map<string, string>()
    for (const p of people) {
      for (const n of [p.handle, p.name]) {
        const k = n.trim().toLowerCase()
        if (k && !out.has(k)) out.set(k, p.ik)
      }
    }
    return out
  }, [people])
  const num = useMemo(() => numbering(messages), [messages])
  const replyNums = useMemo(() => {
    const out = new Map<number, string>()
    let n = -1
    for (const m of messages)
      if (m.reply && !num.has(m.reply.id)) {
        out.set(n, m.reply.id)
        n -= 1
      }
    return out
  }, [messages, num])
  const replyNumOf = useCallback(
    (id: string) => {
      const known = num.get(id)
      if (known !== undefined) return known
      for (const [k, v] of replyNums) if (v === id) return k
      return 0
    },
    [num, replyNums]
  )
  const rows = useMemo(
    () =>
      messages.map(p => ({
        p,
        m: asMessage(
          p,
          num.get(p.id) as number,
          p.reply ? replyNumOf(p.reply.id) : 0,
          user,
          me ?? ''
        ),
      })),
    [messages, num, replyNumOf, user, me]
  )
  const shared = useMemo(
    () => rows.filter(r => !r.p.system && !r.p.removed && !r.p.slowHidden).map(r => r.m),
    [rows]
  )
  const idOf = useCallback(
    (n: number) => rows.find(r => r.m.id === n)?.p.id ?? replyNums.get(n) ?? null,
    [rows, replyNums]
  )

  const source = useMemo<ChatSource>(
    () => ({
      toggleReaction: (m, emoji, note = true) => {
        const id = idOf(m.id)
        if (!id) return
        const adding = !m.reactions?.some(r => r.emoji === emoji && r.me)
        if (adding && note) {
          const s = useStore.getState()
          s.noteEmoji(emojiBase(s.emoji, emoji), emoji)
        }
        void p2pDm.react(id, emoji, adding)
      },
      loadReactors: async (n, emoji) => {
        const id = idOf(n)
        const p = rows.find(r => r.p.id === id)?.p
        return (p?.reactions.find(r => r.key === emoji)?.by ?? []).map(user)
      },
      openReactPicker: (m, anchor) => setPicker({ m, anchor }),
      known: (_m, candidates) => candidates.filter(c => names.has(c)).join('\n'),
      user: name => user(names.get(name) ?? ''),
      mine: name => names.get(name) === me,
      self: me ?? '',
      people: q => {
        const needle = q.toLowerCase()
        return people
          .filter(
            p =>
              p.handle &&
              (p.handle.toLowerCase().startsWith(needle) || p.name.toLowerCase().startsWith(needle))
          )
          .slice(0, 20)
          .map(p => ({ ...p2pUser(p.ik, p.name), username: p.handle }))
      },
    }),
    [idOf, rows, user, names, me, people]
  )

  const editing = useMemo<EditBinding | null>(
    () =>
      editingState
        ? {
            max: BODY_MAX,
            text: editingState.text,
            listKey: scope,
            focus: editingState.focus,
            getText: () => useP2p.getState().editing?.text ?? '',
            setText: p2pDm.setEditText,
            save: () => void p2pDm.saveEdit(),
            cancel: () => p2pDm.cancelEdit(),
          }
        : null,
    [editingState, scope]
  )

  const menu = (p: P2pMessage, m: Message, x: number, y: number) => {
    if (p.system?.kind === 'pin') return openContextMenu(x, y, pinLineMenu(p, m))
    const mine = p.sender === me
    const items: ContextMenuItem[] = []
    const act = canAct && !p.archived
    const can = messageActs(p, act, mine)
    if (can.reply)
      items.push({ label: 'Reply', icon: Reply, action: () => p2pDm.startReply(draftKey, p.id) })
    if (can.edit) items.push(editMenuItem(() => p2pDm.startEdit(draftKey, p.id)))
    const others = useP2p
      .getState()
      .contacts.filter(c => c.state === 'mutual' && c.ik !== forwardSkip)
    if (can.forward)
      items.push({
        label: 'Forward',
        icon: Forward,
        submenu: [
          ...others.map(c => ({
            label: maskOf(useStore.getState())(displayName(c)),
            action: () => void forwardTo(c.ik, p, ownName(p.sender)),
          })),
          {
            label: 'Copy for forwarding',
            icon: Copy,
            action: () => copyForP2p(p, m, ownName(p.sender)),
          },
        ],
      })
    const thread = threads ? threadAct(p, act) : null
    if (thread)
      items.push({
        label: thread,
        icon: MessageSquareText,
        action: () => void p2pThread.open(p.id),
      })
    if (act && mayPin && !p.thread)
      items.push(
        p.pinned !== null
          ? {
              label: 'Unpin Message',
              icon: PinOff,
              action: () => void p2pDm.pin(p.id, false),
            }
          : { label: 'Pin Message', icon: Pin, action: () => void p2pDm.pin(p.id, true) }
      )
    if (act && mayDelete(p))
      items.push({
        label: 'Delete Message',
        danger: true,
        icon: Trash2,
        action: () => confirmDelete(p.id),
      })
    const files = attachmentMenu(p.fwd?.att ?? p.att, canAct)
    if (files) items.push(files)
    const body = p.fwd ? p.fwd.body : p.body
    if (can.copy)
      items.push({
        label: 'Copy Text',
        icon: Copy,
        action: () => void sharing().copyText(body),
      })
    items.push(
      {
        label: 'Copy Timestamp',
        icon: Clock,
        action: () => void sharing().copyText(messageStampToken(m.created_at)),
      },
      { label: 'Copy Message ID', icon: Hash, action: () => void sharing().copyText(p.id) }
    )
    openContextMenu(
      x,
      y,
      items,
      act
        ? {
            header: (
              <ChatSourceProvider value={source}>
                <QuickReactions m={m} anchor={rowAt(x, y)} />
              </ChatSourceProvider>
            ),
          }
        : undefined
    )
  }
  const menuRef = useRef(menu)
  useEffect(() => {
    menuRef.current = menu
  })
  const rowMenu = useCallback(
    (p: P2pMessage, m: Message, x: number, y: number) => menuRef.current(p, m, x, y),
    []
  )
  const copyRow = useCallback(
    (p: P2pMessage, m: Message) => copyForP2p(p, m, ownName(p.sender)),
    [ownName]
  )
  return {
    me,
    user,
    rows,
    shared,
    num,
    idOf,
    source,
    editing,
    editingState,
    rowMenu,
    copyRow,
    picker,
    setPicker,
  }
}

export interface ChatBodyProps {
  chat: P2pChat
  // The header row, and what goes between it and the list (call bars, the stage).
  header: ReactNode
  above?: ReactNode
  intro?: ReactNode
  // In place of the composer, with the reason; null when sending works.
  disabled: ReactNode
  canAct: boolean
  // Display names, and who a message may mention.
  nameOf: (ik: string) => string
  people: Mentionable[]
  // "Forwarded to {title}", and the composer placeholder.
  title: string
  placeholder: string
  pendingTip: string
  peerFull: boolean
  gap: boolean
  online: boolean
  // What the gap note says while nobody who has older history is online.
  gapOffline: ReactNode
  empty: ReactNode
  typingNames: string[]
  // Others' messages a moderator may delete, and whether pins may change.
  mayDelete: (p: P2pMessage) => boolean
  mayPin: boolean
  // Forward targets other than this conversation (contacts).
  forwardSkip: string | null
  pinsEmpty: string
  pinsPlace: 'conversation' | 'channel'
  dataAttr: Record<string, string>
}

export function P2pChatBody(props: ChatBodyProps) {
  const { chat, canAct, nameOf, people, mayDelete, mayPin, disabled, forwardSkip, typingNames } =
    props
  const key = chatKey(chat)
  const me = useP2p(s => s.me)
  const movingAt = useP2p(s => s.movingAt)
  const pins = useP2p(s => (s.pins && s.pins.room === s.chat?.room ? s.pins : null))
  const focus = useP2p(s => (s.focus && s.focus.room === s.chat?.room ? s.focus : null))
  const pulling = useP2p(s => s.pulling)
  const storageFull = useP2p(s => s.storageFull)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const textOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const messages = chat.messages ?? EMPTY
  const scope = chatScope(chat.room, chat.ch)
  const ownRoom = chat.ch ? chat.room : undefined
  const ownName = useCallback((ik: string) => profileName(ik, ownRoom), [ownRoom])
  const canDrop = canAct && !textOnly && movingAt === null

  const {
    user,
    rows,
    shared,
    num,
    idOf,
    source,
    editing,
    editingState,
    rowMenu,
    copyRow,
    picker,
    setPicker,
  } = useP2pList({
    messages,
    nameOf,
    ownName,
    people,
    draftKey: key,
    scope,
    canAct,
    mayPin,
    mayDelete,
    forwardSkip,
    threads: !!chat.ch,
  })

  const lastNum = shared[shared.length - 1]?.id
  const ownCount = useMemo(() => messages.filter(m => m.sender === me).length, [messages, me])
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: shared.length,
    lastId: lastNum,
    stale: chat.loading === true && messages.length === 0,
    focus: focus !== null,
    detached: false,
    outCount: ownCount,
    onBottom: () => {
      if (
        typeof document !== 'undefined' &&
        document.visibilityState === 'visible' &&
        !useP2p.getState().chat?.newer
      )
        p2pDm.markRead(key)
    },
  })
  const fresh = newSince(shared, scroll.leftAt, me ?? undefined)
  const flash = useP2pFlash(listRef, scope, focus, num, shared, scroll.settle)

  const divider = useMemo(() => {
    if (!chat.readSeq) return -1
    return messages.findIndex(m => m.sender !== me && m.seq > chat.readSeq)
  }, [chat, messages, me])

  const rowJump = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) void p2pDm.jumpTo(id)
    },
    [idOf]
  )

  const gapNote = props.gap && !chat.more && (
    <div
      data-p2p-gap
      className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 text-xs text-on-surface-variant"
    >
      <History size={14} />
      {props.online ? (
        <>
          Older messages are not on this device yet.
          <button onClick={p2pDm.loadOlderHistory} disabled={pulling} className={textBtn}>
            {pulling ? 'Loading…' : 'Load older'}
          </button>
        </>
      ) : (
        props.gapOffline
      )}
    </div>
  )

  return (
    <ChatSourceProvider value={source}>
      <main
        {...props.dataAttr}
        className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
        onDragEnter={e => {
          e.preventDefault()
          if (!canDrop || !e.dataTransfer.types.includes('Files')) return
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
          if (canDrop) p2pFiles.add(key, Array.from(e.dataTransfer.files))
        }}
      >
        {props.header}
        {props.above}
        <div className="relative flex min-h-0 flex-1 flex-col">
          {scroll.positioned && fresh > 0 && <PresentBar count={fresh} onJump={scroll.toBottom} />}
          <div ref={listRef} onScroll={scroll.onScroll} className="flex-1 overflow-y-auto py-3">
            {props.intro}
            {!chat.loading && messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-on-surface-variant opacity-70">
                {props.empty}
              </div>
            )}
            <div ref={contentRef}>
              {chat.more && (
                <div className="flex justify-center py-2">
                  <button onClick={() => void p2pDm.loadOlderPage()} className={textBtn}>
                    Show older messages
                  </button>
                </div>
              )}
              {gapNote}
              {rows.map(({ p, m }, i) =>
                p.system?.kind === 'pin' ? (
                  <P2pPinRow
                    key={p.id}
                    p={p}
                    m={m}
                    divider={i === divider}
                    place={props.pinsPlace}
                    onMenu={(row, x, y) => rowMenu(row, m, x, y)}
                  />
                ) : p.system ? (
                  <P2pSystemRow key={p.id} m={m} divider={i === divider} />
                ) : p.removed ? (
                  <P2pHiddenRow key={p.id} m={m} divider={i === divider} />
                ) : p.slowHidden ? (
                  <P2pSlowRow key={p.id} m={m} divider={i === divider} />
                ) : p.call ? (
                  <P2pCallRow key={p.id} p={p} me={me} />
                ) : (
                  <P2pRow
                    key={p.id}
                    p={p}
                    m={m}
                    mine={p.sender === me}
                    pendingTip={props.peerFull ? 'Their storage is full' : props.pendingTip}
                    mentioned={pingsMe(p, me)}
                    divider={i === divider}
                    flash={flash === m.id}
                    canAct={canAct && !p.archived}
                    canDelete={mayDelete(p)}
                    editing={editing && editingState?.id === p.id ? editing : null}
                    draftKey={key}
                    threads={!!chat.ch}
                    onMenu={rowMenu}
                    onCopy={copyRow}
                    onJump={rowJump}
                  />
                )
              )}
              {chat.newer && (
                <div
                  data-p2p-newer
                  className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 text-xs text-on-surface-variant"
                >
                  <History size={14} />
                  Newer messages aren&apos;t shown.
                  <button
                    onClick={() => void p2pDm.loadNewerPage()}
                    disabled={chat.loading}
                    className={textBtn}
                  >
                    Show newer
                  </button>
                  <button onClick={() => void p2pDm.toPresent()} className={textBtn}>
                    Jump to present
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        <div className="relative shrink-0">
          <TypingIndicator scope={null} bg="bg-surface" names={typingNames} />
          {!disabled && (storageFull || props.peerFull) && (
            <div data-p2p-full className={noteBarCls} role="status">
              <CircleAlert size={16} className="shrink-0 text-error" aria-hidden />
              {storageFull ? STORAGE_FULL_TEXT : PEER_FULL_TEXT}
            </div>
          )}
          <P2pComposer
            draftKey={key}
            scope={scope}
            title={props.title}
            placeholder={props.placeholder}
            nameOf={nameOf}
            disabled={disabled}
          />
        </div>
        {pins && (
          <PinsPanel
            list={
              pins.list?.map(p =>
                asMessage(p, num.get(p.id) ?? Math.max(1, p.ts * 1000), 0, user, me ?? '')
              ) ?? null
            }
            failed={false}
            place={props.pinsPlace}
            empty={props.pinsEmpty}
            canUnpin={canAct && mayPin}
            profiles={false}
            onClose={p2pDm.closePins}
            onRetry={() => void p2pDm.openPins()}
            onJump={n => {
              const id = pins.list?.find(p => (num.get(p.id) ?? Math.max(1, p.ts * 1000)) === n)?.id
              p2pDm.closePins()
              if (id) void p2pDm.jumpTo(id)
            }}
            onUnpin={n => {
              const id = pins.list?.find(p => (num.get(p.id) ?? Math.max(1, p.ts * 1000)) === n)?.id
              if (id) confirmUnpin(() => void p2pDm.pin(id, false))
            }}
          />
        )}
        {picker && (
          <EmojiPicker
            anchor={picker.anchor?.isConnected ? picker.anchor : null}
            side="top"
            align="end"
            label="Add reaction"
            onPick={e => source.toggleReaction(picker.m, e, false)}
            onClose={() => setPicker(null)}
          />
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-tertiary bg-surface/80 font-medium text-tertiary">
            Drop files to send peer-to-peer
          </div>
        )}
      </main>
    </ChatSourceProvider>
  )
}
