'use client'

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import {
  ArrowLeft,
  CircleAlert,
  Check,
  Clock,
  Copy,
  Forward,
  Hash,
  History,
  Menu,
  Pin,
  PinOff,
  Reply,
  SendHorizontal,
  Smile,
  Trash2,
  X,
} from 'lucide-react'
import { useStore, type ContextMenuItem } from '../../lib/store'
import { allPings } from '../../lib/selectors'
import { home, writeLocal } from '../../lib/instances'
import { chatScope, p2p, p2pDm, p2pUser, useP2p, type P2pChat } from '../../lib/p2p/app'
import { displayName, shieldOf, type Contact } from '../../lib/p2p/contacts'
import {
  bodyTooLong,
  FULL_BYTES_TEXT,
  FULL_TEXT,
  MOVED_TEXT,
  PEER_FULL_TEXT,
  STORAGE_FULL_TEXT,
  type P2pMessage,
} from '../../lib/p2p/dm'
import { DAG } from '../../lib/p2p/dag'
import { emojiBase } from '../../lib/reactions'
import { MESSAGE_MAX, charCount } from '../../lib/rules'
import { composing, sendKey } from '../../lib/keys'
import { spliceText } from '../../lib/autocomplete'
import { loadEmojiData } from '../../lib/emoji'
import { newSince } from '../../lib/lists'
import { plainLine } from '../../lib/replies'
import { messageStampToken } from '../../lib/timestamps'
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
import { PinsButton, PinsPanel, confirmUnpin } from '../pins'
import { TypingIndicator } from '../typing_indicator'
import { EmojiPicker, SHEET_QUERY } from '../emoji_picker'
import { longPress, useMedia } from '../context_menu'
import { useTextAssist } from '../text_assist'
import { MessageTime } from '../timestamp'
import { PingBadge, pingLabel } from '../ping_badge'
import { PresentBar, useChatScroll, useFocusMessage } from '../viewport_height'
import { mentionRowCls } from '../message_pane'
import { textBtn } from '../ui'
import { ContactShield, KeyAvatar, P2pBadge, PresenceDot } from './p2p_badge'
import { ElsewhereNotice } from './p2p_home'

const EMPTY: P2pMessage[] = []
const NONE: string[] = []

// Shared message components key rows by a number that grows in display order (jumps and the
// unread line rely on it): display time in ms times 1000, plus a counter for ties.
const numbering = (list: P2pMessage[]) => {
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

const asMessage = (
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
  content: m.fwd ? m.fwd.body : m.body,
  created_at: seconds(m.ts),
  reply_count: 0,
  media: null,
  embeds: [],
  kind: 'user',
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
        content: m.reply.body ?? '',
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

const introKey = (user: string) => `rchat_p2p_intro:${user}`

const readIntro = (user: string | null) => {
  if (!user) return true
  try {
    return localStorage.getItem(home.scoped(introKey(user))) === '1'
  } catch {
    return true
  }
}

function IntroBanner({ name }: { name: string }) {
  const account = useP2p(s => s.account)
  const [hidden, setHidden] = useState(() => readIntro(account))
  if (hidden) return null
  return (
    <div
      data-p2p-intro
      className="mx-4 mt-3 flex items-start gap-3 rounded-2xl border border-dashed border-tertiary bg-tertiary-container/40 px-4 py-3 text-sm text-on-surface"
    >
      <P2pBadge />
      <p className="min-w-0 flex-1">
        This conversation is stored only on your device and{' '}
        <span className="streamer font-medium">{name}</span>&apos;s. Messages are delivered when you
        are both online, and the instance never sees them.
      </p>
      <button
        title="Dismiss"
        aria-label="Dismiss"
        onClick={() => {
          setHidden(true)
          if (account) writeLocal(home.scoped(introKey(account)), '1')
        }}
        className="shrink-0 rounded-full p-1 hover:bg-surface-container-highest"
      >
        <X size={16} />
      </button>
    </div>
  )
}

const statusLine = (online: boolean, name: string): ReactNode =>
  online ? (
    'Connected'
  ) : (
    <>
      Offline. Messages wait until <span className="streamer">{name}</span> is online
    </>
  )

interface RowProps {
  p: P2pMessage
  m: Message
  mine: boolean
  peerName: string
  mentioned: boolean
  divider: boolean
  flash: boolean
  canAct: boolean
  peerFull: boolean
  editing: EditBinding | null
  onMenu: (p: P2pMessage, m: Message, x: number, y: number) => void
  onJump: (num: number) => void
}

const P2pRow = memo(function P2pRow({
  p,
  m,
  mine,
  peerName,
  mentioned,
  divider,
  flash,
  canAct,
  peerFull,
  editing,
  onMenu,
  onJump,
}: RowProps) {
  const actions: ToolbarAction[] = []
  if (canAct && mine && !p.fwd && !editing)
    actions.push(editAction(() => p2pDm.startEdit(chatRoom(), p.id)))
  if (canAct)
    actions.push({
      key: 'reply',
      label: 'Reply',
      icon: Reply,
      onClick: () => p2pDm.startReply(chatRoom(), p.id),
    })
  actions.push(forwardAction(() => copyForP2p(p, m)))
  if (canAct && mine)
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
        title={peerFull ? 'Their storage is full' : `Waiting for ${peerName} to come online`}
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
            <div className="flex min-w-0 items-baseline gap-2">
              <span className="streamer min-w-0 truncate text-sm font-medium">
                {m.author.display_name}
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
              <MarkdownMessage
                message={m}
                editor={editing ? <MessageEditor binding={editing} /> : undefined}
              />
            )}
            <ReactionBar m={m} canReact={canAct} canRemove={canAct} />
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

const chatRoom = () => useP2p.getState().chat?.room ?? ''

const confirmDelete = (id: string, skip = false) => {
  const run = () => void p2pDm.remove(id)
  if (skip) return run()
  useStore.getState().askConfirm({
    title: 'Delete Message',
    body: 'Delete this message? It is removed here now, and on the other device the next time you are both online.',
    confirm: 'Delete',
    action: run,
  })
}

// Puts a message on the forward clipboard: Send in another conversation forwards it there (a
// P2P one directly; an instance one after it says the text will be copied there).
const copyForP2p = (p: P2pMessage, m: Message) => {
  const clip: ForwardClip = {
    id: 1 + Math.floor(Math.random() * 2 ** 40),
    author: p.fwd ? (m.forward?.author ?? null) : m.author,
    snippet: plainLine(p.fwd ? p.fwd.body : p.body),
    has_media: false,
    created_at: p.fwd ? seconds(p.fwd.ts) : m.created_at,
    body: p.fwd ? p.fwd.body : p.body,
    p2p: true,
  }
  useStore.getState().copyForwardClip(clip)
}

// Forwards straight into another P2P conversation.
const forwardTo = async (ik: string, p: P2pMessage, author: string) => {
  const fwd = p.fwd ?? { name: author, ts: p.sentTs, body: p.body }
  const target = await p2pDm.ensureRoom(ik)
  if (target && (await p2pDm.forward(target, fwd))) {
    const c = useP2p.getState().contacts.find(x => x.ik === ik)
    useStore.getState().showToast(`Forwarded to ${c ? displayName(c) : 'contact'}`)
  }
}

const useNames = (peer: Contact | undefined, myName: string, me: string | null) =>
  useMemo(() => {
    const names = new Map<string, string>()
    const add = (n: string | null | undefined, ik: string) => {
      const k = n?.trim().toLowerCase()
      if (k && !names.has(k)) names.set(k, ik)
    }
    if (peer) {
      add(peer.name, peer.ik)
      add(peer.petname, peer.ik)
    }
    if (me) add(myName, me)
    return names
  }, [peer, myName, me])

function P2pComposer({
  chat,
  peer,
  disabled,
}: {
  chat: P2pChat
  peer: Contact
  disabled: ReactNode
}) {
  const room = chat.room
  const scope = chatScope(room)
  const text = useP2p(s => s.drafts[room] ?? '')
  const replying = useP2p(s => (s.replying?.room === room ? s.replying.id : null))
  const replyTo = useP2p(s => s.chat?.messages.find(m => m.id === replying))
  const me = useP2p(s => s.me)
  const myName = useP2p(s => s.name)
  const forwarding = useStore(s => s.forwardClip !== null)
  const streamer = useStore(s => s.streamer)
  const sheet = useMedia(SHEET_QUERY)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const sel = useRef({ start: 0, end: 0 })
  const typedAt = useRef(0)
  const getText = () => useP2p.getState().drafts[room] ?? ''
  const setText = (v: string) => p2pDm.setDraft(room, v)
  const assist = useTextAssist({
    listKey: scope,
    text,
    getText,
    setText,
    inputRef,
    paused: pickerOpen,
    maxHeight: 160,
  })

  const typing = focused && text.trim() !== ''
  useEffect(() => {
    if (!typing) {
      if (typedAt.current) p2pDm.typing(room, false)
      typedAt.current = 0
      return
    }
    const now = Date.now()
    if (now - typedAt.current < 3000) return
    typedAt.current = now
    p2pDm.typing(room, true)
  }, [typing, text, room])

  if (disabled) return <>{disabled}</>

  const count = charCount(text)
  const tooLong = count > MESSAGE_MAX || bodyTooLong(text)
  const send = () => {
    if (!text.trim() || tooLong) return
    const sent = text
    void p2pDm.send(room, sent).then(ok => {
      if (ok && getText() === sent) setText('')
    })
    typedAt.current = 0
    p2pDm.typing(room, false)
  }
  const bar = replyTo ? (
    <ComposerBar onClose={p2pDm.cancelReply} closeLabel="Cancel reply">
      Replying to{' '}
      <span className="streamer font-semibold text-on-surface">
        {replyTo.sender === me ? myName : displayName(peer)}
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
          .forward(room, {
            name: author,
            ts: clip.created_at * 1000,
            body: clip.body ?? clip.snippet,
          })
          .then(ok => {
            if (!ok) return
            if (useStore.getState().forwardClip?.id === clip.id) useStore.getState().clearForward()
            useStore.getState().showToast(`Forwarded to ${displayName(peer)}`)
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
      {bar}
      <div
        className={`relative flex items-end gap-2 bg-surface-container-high px-3 py-2 ${bar ? 'rounded-b-3xl' : 'rounded-3xl'}`}
      >
        {assist.popups}
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
            if (
              e.key === 'ArrowUp' &&
              !text &&
              !e.shiftKey &&
              !e.altKey &&
              !e.metaKey &&
              !e.ctrlKey &&
              !composing(e) &&
              p2pDm.editLast(room)
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
          placeholder={streamer ? 'Send a P2P message' : `Message ${displayName(peer)}`}
          className="max-h-40 flex-1 resize-none bg-transparent py-1.5 text-base outline-none placeholder:text-on-surface-variant md:text-sm"
        />
        {(count > MESSAGE_MAX - 500 || tooLong) && (
          <span
            data-too-long={tooLong ? '' : undefined}
            title={
              count > MESSAGE_MAX
                ? `Messages can be up to ${MESSAGE_MAX} characters`
                : tooLong
                  ? 'This message takes too much space. Use fewer special characters.'
                  : `Messages can be up to ${MESSAGE_MAX} characters`
            }
            className={`shrink-0 self-center text-xs tabular-nums ${tooLong ? 'font-medium text-error' : 'text-on-surface-variant'}`}
          >
            {count > MESSAGE_MAX || !tooLong ? MESSAGE_MAX - count : 'Too long'}
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
          title={tooLong ? 'Message is too long' : 'Send'}
          aria-label="Send"
          onClick={send}
          disabled={tooLong}
          className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          <SendHorizontal size={16} />
        </button>
      </div>
    </div>
  )
}

const noteBarCls =
  'mx-3 mb-[max(0.75rem,env(safe-area-inset-bottom))] flex shrink-0 flex-wrap items-center gap-2 rounded-2xl bg-surface-container px-4 py-3 text-sm text-on-surface-variant keyboard:mb-3'

export function P2pDmPane({ onBack, onMenu }: { onBack: () => void; onMenu: () => void }) {
  const chat = useP2p(s => s.chat)
  const me = useP2p(s => s.me)
  const myName = useP2p(s => s.name)
  const reader = useP2p(s => s.reader)
  const elsewhere = useP2p(s => s.elsewhere)
  const status = useP2p(s => s.status)
  const peer = useP2p(s => s.contacts.find(c => c.ik === s.chat?.peer))
  const presence = useP2p(s => (s.chat ? (s.presence[s.chat.peer] ?? 'offline') : 'offline'))
  const room = useP2p(s => (s.chat ? s.rooms[s.chat.room] : undefined))
  const typingIks = useP2p(s => (s.chat ? (s.typing[s.chat.room] ?? NONE) : NONE))
  const pins = useP2p(s => (s.pins && s.pins.room === s.chat?.room ? s.pins : null))
  const editingState = useP2p(s => (s.editing?.room === s.chat?.room ? s.editing : null))
  const focus = useP2p(s => (s.focus && s.focus.room === s.chat?.room ? s.focus : null))
  const pulling = useP2p(s => s.pulling)
  const storageFull = useP2p(s => s.storageFull)
  const menuPings = useStore(allPings)
  const openContextMenu = useStore(s => s.openContextMenu)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const [picker, setPicker] = useState<{ m: Message; anchor: HTMLElement | null } | null>(null)

  const messages = chat?.messages ?? EMPTY
  const peerIk = chat?.peer ?? ''
  const peerName = peer ? displayName(peer) : 'Contact'
  const online = presence === 'online'
  const scope = chat ? chatScope(chat.room) : null
  const canAct = !reader && !elsewhere && peer?.state === 'mutual' && status !== 'moved'

  const user = useCallback(
    (ik: string) => p2pUser(ik, ik === me ? myName || 'You' : peerName),
    [me, myName, peerName]
  )
  const names = useNames(peer, myName, me)
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
  const shared = useMemo(() => rows.map(r => r.m), [rows])
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
      user: name => user(names.get(name) ?? peerIk),
      mine: name => names.get(name) === me,
      people: q => {
        const needle = q.toLowerCase()
        const list: UserRef[] = []
        if (peer) {
          const handle = peer.name || peer.petname || ''
          if (
            handle &&
            (handle.toLowerCase().startsWith(needle) ||
              displayName(peer).toLowerCase().startsWith(needle))
          )
            list.push({ ...p2pUser(peer.ik, displayName(peer)), username: handle })
        }
        if (me && myName && myName.toLowerCase().startsWith(needle))
          list.push({ ...p2pUser(me, myName), username: myName })
        return list
      },
    }),
    [idOf, rows, user, names, peerIk, me, myName, peer]
  )

  const lastNum = shared[shared.length - 1]?.id
  const ownCount = useMemo(() => messages.filter(m => m.sender === me).length, [messages, me])
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: shared.length,
    lastId: lastNum,
    stale: chat?.loading === true && messages.length === 0,
    focus: focus !== null,
    detached: false,
    outCount: ownCount,
    onBottom: () => {
      if (chat && typeof document !== 'undefined' && document.visibilityState === 'visible')
        p2pDm.markRead(chat.room)
    },
  })
  const fresh = newSince(shared, scroll.leftAt, me ?? undefined)
  const focusNum = focus ? (num.get(focus.id) ?? null) : null
  const focusObj = useMemo(
    () => (focus && focusNum !== null ? { id: focusNum, flash: true } : undefined),
    [focus, focusNum]
  )
  const flash = useFocusMessage(listRef, scope, focusObj, shared, scroll.settle)
  useEffect(() => {
    if (focus && focusNum !== null) p2pDm.clearFocus()
  }, [focus, focusNum])

  const divider = useMemo(() => {
    if (!chat || !chat.readSeq) return -1
    return messages.findIndex(m => m.sender !== me && m.seq > chat.readSeq)
  }, [chat, messages, me])

  const editing = useMemo<EditBinding | null>(
    () =>
      editingState
        ? {
            text: editingState.text,
            listKey: scope ?? '',
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
    const mine = p.sender === me
    const items: ContextMenuItem[] = []
    if (canAct) {
      items.push({ label: 'Reply', icon: Reply, action: () => p2pDm.startReply(chatRoom(), p.id) })
      if (mine && !p.fwd) items.push(editMenuItem(() => p2pDm.startEdit(chatRoom(), p.id)))
    }
    const others = useP2p.getState().contacts.filter(c => c.state === 'mutual' && c.ik !== peerIk)
    items.push({
      label: 'Forward',
      icon: Forward,
      submenu: [
        ...others.map(c => ({
          label: displayName(c),
          action: () => void forwardTo(c.ik, p, m.author.display_name),
        })),
        { label: 'Copy for forwarding', icon: Copy, action: () => copyForP2p(p, m) },
      ],
    })
    if (canAct)
      items.push(
        p.pinned !== null
          ? {
              label: 'Unpin Message',
              icon: PinOff,
              action: () => void p2pDm.pin(p.id, false),
            }
          : { label: 'Pin Message', icon: Pin, action: () => void p2pDm.pin(p.id, true) }
      )
    if (canAct && mine)
      items.push({
        label: 'Delete Message',
        danger: true,
        icon: Trash2,
        action: () => confirmDelete(p.id),
      })
    const body = p.fwd ? p.fwd.body : p.body
    if (body.trim())
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
      canAct
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
  const rowJump = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) void p2pDm.jumpTo(id)
    },
    [idOf]
  )

  if (!chat) return null

  const disabled: ReactNode =
    reader || elsewhere ? (
      <div className={noteBarCls}>
        <ElsewhereNotice />
      </div>
    ) : status === 'moved' ? (
      <div className={noteBarCls}>{MOVED_TEXT}</div>
    ) : room?.full ? (
      <div className={noteBarCls} role="status">
        {room.fullWhy === 'bytes' ? FULL_BYTES_TEXT(DAG.roomBytes) : FULL_TEXT(DAG.roomCap)}
      </div>
    ) : !peer ? (
      <div className={noteBarCls}>This contact was removed.</div>
    ) : peer.state === 'blocked' ? (
      <div className={noteBarCls}>
        You blocked <span className="streamer font-medium">{peerName}</span>. Remove the block to
        message them again.
      </div>
    ) : peer.state !== 'mutual' ? (
      <div className={noteBarCls}>
        <span className="streamer font-medium">{peerName}</span> isn&apos;t a mutual contact right
        now.
      </div>
    ) : null

  const gapNote = room?.gap && !chat.more && (
    <div
      data-p2p-gap
      className="flex flex-wrap items-center justify-center gap-2 px-4 py-3 text-xs text-on-surface-variant"
    >
      <History size={14} />
      {online ? (
        <>
          Older messages are not on this device yet.
          <button onClick={p2pDm.loadOlderHistory} disabled={pulling} className={textBtn}>
            {pulling ? 'Loading…' : 'Load older'}
          </button>
        </>
      ) : (
        <>
          Older messages unavailable until <span className="streamer">{peerName}</span> is online
        </>
      )}
    </div>
  )

  const typingNames = typingIks.filter(ik => ik === peerIk).map(() => peerName)

  return (
    <ChatSourceProvider value={source}>
      <main data-p2p-dm className="relative flex h-full min-w-0 flex-1 flex-col bg-surface">
        <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-3 md:px-4">
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
          <button
            title="Back to contacts"
            aria-label="Back to contacts"
            onClick={onBack}
            className="rounded-full p-1.5 hover:bg-surface-container-high"
          >
            <ArrowLeft size={20} />
          </button>
          <button
            onClick={() => peer && p2p.openDialog({ kind: 'contact', ik: peer.ik })}
            className="flex min-w-0 items-center gap-2 rounded-full py-1 pr-2.5 pl-1 hover:bg-surface-container-high"
          >
            <span className="relative">
              <KeyAvatar ik={peerIk} size={28} />
              <PresenceDot presence={presence} />
            </span>
            <span className="flex min-w-0 flex-col text-left">
              <span className="flex min-w-0 items-center gap-1.5">
                <span className="streamer truncate text-sm font-medium">{peerName}</span>
                {peer && <ContactShield kind={shieldOf(peer)} size={14} />}
              </span>
              <span
                data-p2p-online={online ? 'yes' : 'no'}
                className="truncate text-xs text-on-surface-variant"
              >
                {statusLine(online, peerName)}
              </span>
            </span>
          </button>
          <P2pBadge />
          <div className="ml-auto flex shrink-0 items-center gap-1">
            <PinsButton
              toggle={{
                open: pins !== null,
                onClick: () => (pins ? p2pDm.closePins() : void p2pDm.openPins()),
              }}
            />
          </div>
        </header>
        <div className="relative flex min-h-0 flex-1 flex-col">
          {scroll.positioned && fresh > 0 && <PresentBar count={fresh} onJump={scroll.toBottom} />}
          <div ref={listRef} onScroll={scroll.onScroll} className="flex-1 overflow-y-auto py-3">
            <IntroBanner name={peerName} />
            {!chat.loading && messages.length === 0 && (
              <div className="flex h-full flex-col items-center justify-center gap-1 px-6 text-center text-on-surface-variant opacity-70">
                <span className="text-2xl font-semibold">No messages here yet</span>
                <span className="text-sm">
                  Say hi. It arrives when {online ? 'sent' : 'they are online'}.
                </span>
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
              {rows.map(({ p, m }, i) => (
                <P2pRow
                  key={p.id}
                  p={p}
                  m={m}
                  mine={p.sender === me}
                  peerName={peerName}
                  mentioned={
                    p.sender !== me &&
                    ((me !== null && p.mentions.includes(me)) || p.reply?.sender === me)
                  }
                  divider={i === divider}
                  flash={flash === m.id}
                  canAct={canAct}
                  peerFull={room?.peerFull === true}
                  editing={editing && editingState?.id === p.id ? editing : null}
                  onMenu={rowMenu}
                  onJump={rowJump}
                />
              ))}
            </div>
          </div>
        </div>
        <div className="relative shrink-0">
          <TypingIndicator scope={null} bg="bg-surface" names={typingNames} />
          {!disabled && (storageFull || room?.peerFull) && (
            <div data-p2p-full className={noteBarCls} role="status">
              <CircleAlert size={16} className="shrink-0 text-error" aria-hidden />
              {storageFull ? STORAGE_FULL_TEXT : PEER_FULL_TEXT}
            </div>
          )}
          <P2pComposer chat={chat} peer={peer as Contact} disabled={disabled} />
        </div>
        {pins && (
          <PinsPanel
            list={
              pins.list?.map(p =>
                asMessage(p, num.get(p.id) ?? Math.max(1, p.ts * 1000), 0, user, me ?? '')
              ) ?? null
            }
            failed={false}
            place="conversation"
            empty="This conversation doesn't have any pinned messages yet."
            canUnpin={canAct}
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
      </main>
    </ChatSourceProvider>
  )
}
