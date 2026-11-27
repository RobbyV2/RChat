'use client'
import { PeerCodeButton } from './peer_code_button'
import { useActorSuffix, usePeerActor } from '../view_actor'
import { identityScopeKey } from '../../lib/p2p/app/host'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'
import { ChannelCanContext } from '../../lib/place/use_rights'
import { NO_THREADS_TEXT, type ChannelCan } from '../../lib/channel_perms'

import {
  Fragment,
  memo,
  useCallback,
  useContext,
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
  EyeOff,
  History,
  Lock,
  MessageSquareText,
  Plus,
  Reply,
  SendHorizontal,
  Smile,
  Trash2,
  X,
} from 'lucide-react'
import { useStore } from '../../lib/store'
import { outgoing } from '../../lib/link_safety'
import { actionPress, openActionMenu } from '../../lib/actions/menu'
import type { Target } from '../../lib/actions/types'
import { peerChat } from '../../lib/actions/p2p_chat'
import { noticeOpen } from '../../lib/home'
import { useHome } from '../../lib/home_store'
import { chatKey, chatScope, type P2pChat } from '../../lib/p2p/app'
import { hiddenRemovedText, SLOW_HIDDEN_TEXT } from '../../lib/p2p/flows'
import {
  bodyTooLong,
  messageActs,
  STORAGE_FULL_TEXT,
  PEER_FULL_TEXT,
  type P2pMessage,
} from '../../lib/p2p/dm'
import { LIMITS as P2P_LIMITS } from '../../lib/p2p/content'
import { charCount, counterFrom } from '../../lib/rules'
import { clock } from '../../lib/slowmode'
import { useCountdown } from '../../lib/countdown'
import { composing, sendKey } from '../../lib/keys'
import { spliceText } from '../../lib/autocomplete'
import { loadEmojiData } from '../../lib/emoji'
import { newSince } from '../../lib/lists'
import { systemParts } from '../../lib/system_messages'
import type { Message, UserRef } from '../../lib/types'
import { P2pDm, P2pRoom, type P2pList } from '../../lib/place/place'
import { PlaceProvider, useLive } from '../../lib/place/react'
import { messagesAt } from '../../lib/place/use_messages'
import { MessageList } from '../message_list'
import { chat as chatFeature } from '../../lib/place/chat'
import { featureAt, isUnsupported } from '../../lib/place/feature'
import { MarkdownMessage } from '../markdown_message'
import { MessageEditor, editAction, type EditBinding } from '../message_editor'
import { MessageToolbar, type ToolbarAction } from '../message_toolbar'
import { QuickReactions, ReactionBar, rowAt } from '../reactions'
import { ComposerBar, ReplyPreview } from '../replies'
import { clipAllowed, clipSourceNames } from '../../lib/forward_viewing'
import { fwdSource, p2pDestination, p2pForward } from '../../lib/forward'
import {
  ForwardBar,
  ForwardCard,
  forwardAction,
  useForwardClip,
  useVouchedFiles,
} from '../forwards'
import { PinLine, PinsWindow } from '../pins'
import { ThreadsWindow } from '../threads'
import { asMessage, numbering } from '../../lib/p2p/shown_message'
import { TypingIndicator } from '../typing_indicator'
import { EmojiPicker, SHEET_QUERY } from '../emoji_picker'
import { longPress, useMedia } from '../context_menu'
import { useTextAssist } from '../text_assist'
import { MessageTime } from '../timestamp'
import { useChatScroll, useFocusMessage } from '../viewport_height'
import { GroupedRow, groupPadCls, mentionRowCls } from '../message_pane'
import { groupPlaces, p2pCue } from '../../lib/message_groups'
import { dayStarts } from '../../lib/date_dividers'
import { DateDivider } from '../date_divider'
import { UnreadDivider } from '../unread_banner'
import { p2pUnread, p2pUnreadStart } from '../../lib/unread_banner'
import { Masked, textBtn } from '../ui'
import { KeyAvatar, P2pBadge } from './p2p_badge'
import { AttachmentList, PendingFiles } from './p2p_files'
import { namePasted } from '../message_composer'
import { FormatToolbar, useFormatting } from '../format_toolbar'
import { P2pCallRow } from './p2p_call'
import { RoleIcon } from '../role_icon'
import type { Look } from '../../lib/role_looks'
import { Row, Stack, Surface } from '../layout'

// The message list and composer of a P2P conversation, shared by direct messages and P2P server
// channels: what differs (the header, who may do what, names, mentions) comes in as props.

const BODY_MAX = P2P_LIMITS.body
const EMPTY: P2pMessage[] = []

// A note in the composer's place: why nothing can be sent here, or what is in the way. It keeps
// clear of the bottom safe area as the composer does.
export function NoteBar({
  children,
  ...rest
}: {
  children: ReactNode
  role?: 'status'
  [data: `data-${string}`]: string | boolean | undefined
}) {
  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3">
      <Surface {...rest} pad="lg" tone="base">
        <div className="flex flex-wrap items-center gap-2 text-sm text-on-surface-variant">
          {children}
        </div>
      </Surface>
    </div>
  )
}

// The note at the top of a conversation. Once closed it stays closed for the account, in every
// tab.
function P2pIntroBody({ id, children }: { id: string; children: ReactNode }) {
  const acct = useAccount()
  const account = useP2p(s => s.account)
  const open = useHome(s => noticeOpen(s.owner, account, s.prefs, id))
  if (!open) return null
  return (
    <Surface pad="lg" tone="plain" radius="none">
      <div
        data-p2p-intro
        className="rounded-2xl border border-dashed border-tertiary bg-tertiary-container/40 text-sm text-on-surface"
      >
        <Surface pad="lg" tone="plain" radius="none">
          <Row gap="md" align="start">
            <P2pBadge />
            <p className="min-w-0 flex-1">{children}</p>
            <button
              title="Dismiss"
              aria-label="Dismiss"
              onClick={() => acct.home.hideTip(id)}
              className="shrink-0 rounded-full p-1 hover:bg-surface-container-highest"
            >
              <X size={16} />
            </button>
          </Row>
        </Surface>
      </div>
    </Surface>
  )
}

interface RowProps {
  p: P2pMessage
  m: Message
  // Its place in its sender's group: only the first row shows the avatar, name and time.
  first: boolean
  last: boolean
  mine: boolean
  pendingTip: string
  mentioned: boolean
  divider: boolean
  flash: boolean
  canAct: boolean
  // A timeout of ours: the row can be deleted and its files downloaded, nothing more.
  timedOut?: boolean
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
  // The sender's name color, and the emoji and role name of their role icon.
  color?: string
  icon?: string
  iconRole?: string
}

// A sender's look as row props.
export const rowLook = (look: Look | undefined) => ({
  color: look?.color,
  icon: look?.icon?.emoji,
  iconRole: look?.icon?.role,
})

export const P2pRow = memo(function P2pRow({
  p,
  m,
  first,
  last,
  mine,
  pendingTip,
  mentioned,
  divider,
  flash,
  canAct,
  timedOut = false,
  canDelete,
  editing,
  draftKey,
  threads,
  onMenu,
  onCopy,
  onJump,
  color,
  icon,
  iconRole,
}: RowProps) {
  const identity = useP2pApp()!
  const { p2pDm, p2pThread } = identity

  const acct = useAccount()
  const vouchedAtts = useVouchedFiles(m.forward?.p2p)

  const actions: ToolbarAction[] = []
  // From the old copy: read-only here.
  const act = canAct && !p.archived
  const held = useContext(ChannelCanContext)
  const write = act && !timedOut
  const can = messageActs(p, write, mine)
  const thread = threads ? peerChat.forIdentity(identity).threadAct(p, write && held.threads) : null
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
      onClick: e => peerChat.forIdentity(identity).confirmDelete(p.id, e.shiftKey, acct),
    })
  const status = mine ? (
    p.failed ? (
      <Row as="span" data-failed gap="xs" place="shrink-0">
        <CircleAlert size={12} aria-hidden className="text-error" />
        <span className="text-xs text-error">Not sent</span>
        {canAct && (
          <>
            {!timedOut && (
              <button
                onClick={() => void p2pDm.retry(p.id)}
                className="text-xs font-medium text-error hover:underline"
              >
                Retry
              </button>
            )}
            <button
              onClick={e => peerChat.forIdentity(identity).confirmDelete(p.id, e.shiftKey, acct)}
              className="text-xs font-medium text-error hover:underline"
            >
              Delete
            </button>
          </>
        )}
      </Row>
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
  const name = <Masked text={m.author.display_name} by={m.author.username} />
  const body = (
    <>
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
      <AttachmentList
        att={vouchedAtts ?? p.fwd?.att ?? p.att}
        canFetch={canAct}
        own={!p.fwd && mine}
        message={p.id}
      />
      <ReactionBar m={m} canReact={write && held.react} canRemove={write} />
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
    </>
  )
  return (
    <div data-row data-mid={m.id} data-event={p.id}>
      {divider && <UnreadDivider />}
      <div
        {...longPress((x, y) => onMenu(p, m, x, y))}
        data-flash={flash ? '' : undefined}
        data-mentioned={mentioned ? '' : undefined}
        className={`group relative px-4 ${groupPadCls(first, last)} ${mentioned ? mentionRowCls : 'hover:bg-surface-container-low'}`}
      >
        {m.reply_to && <ReplyPreview quote={m.reply_to} avatar={36} local onJump={onJump} />}
        {first ? (
          <Row gap="md" align="stretch">
            <div className="shrink-0 pt-0.5">
              <KeyAvatar
                ik={p.sender}
                size={36}
                kind={m.author.avatar_kind}
                bg={m.author.avatar_color}
              />
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="streamer min-w-0 truncate text-sm font-medium" style={{ color }}>
                  {name}
                </span>
                <RoleIcon emoji={icon} role={iconRole} />
                <MessageTime
                  ts={m.created_at}
                  className="shrink-0 text-xs text-on-surface-variant"
                />
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
              {body}
            </div>
          </Row>
        ) : (
          <GroupedRow
            name={name}
            ts={m.created_at}
            size={36}
            status={mine && p.pending && !p.failed ? status : undefined}
          >
            {body}
          </GroupedRow>
        )}
        <MessageToolbar
          m={m}
          react={canAct && !timedOut && held.react}
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
      {divider && <UnreadDivider />}
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
  return (
    <PinLine
      row={{ 'data-row': '', 'data-mid': m.id, 'data-event': p.id }}
      inner={{ 'data-system': 'pin' }}
      divider={divider && <UnreadDivider />}
      press={longPress((x, y) => onMenu(p, x, y))}
      name={
        <span className="streamer font-medium text-on-surface">
          <Masked text={m.author.display_name} by={m.author.username} />
        </span>
      }
      place={place}
      ts={m.created_at}
      target={p.system?.target ?? null}
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
  const identity = useP2pApp()!
  const { p2pDm } = identity

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

// In place of a message sent around the time its author was removed.
export function P2pHiddenRow({ m, divider }: { m: Message; divider: boolean }) {
  const [before, after] = hiddenRemovedText('\u0000').split('\u0000')
  return (
    <div data-row data-mid={m.id}>
      {divider && <UnreadDivider />}
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

// In place of our own message slow mode hides.
export function P2pSlowRow({ m, divider }: { m: Message; divider: boolean }) {
  return (
    <div data-row data-mid={m.id}>
      {divider && <UnreadDivider />}
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

function P2pComposerBody({
  draftKey: key,
  channelTextOnly = false,
  unstarted = false,
  scope,
  title,
  placeholder,
  nameOf,
  disabled,
}: {
  channelTextOnly?: boolean
  // A thread without replies: its first reply needs Start threads.
  unstarted?: boolean
  // Where the draft, files, reply and sends go (a conversation, channel or thread).
  draftKey: string
  scope: string
  title: string
  placeholder: string
  nameOf: (ik: string) => string
  disabled: ReactNode
}) {
  const identity = useP2pApp()!
  const { p2pDm, p2pFiles } = identity

  const account = useAccount()
  const { store } = account
  const text = useP2p(s => s.drafts[key] ?? '')
  const replying = useP2p(s => (s.replying?.room === key ? s.replying.id : null))
  const replyTo = useP2p(s => shownRow(s, replying))
  const forwardClip = useForwardClip()
  const suffix = useActorSuffix(usePeerActor())
  const streamer = useStore(s => s.streamer)
  const sheet = useMedia(SHEET_QUERY)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [focused, setFocused] = useState(false)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const files = useP2p(s => s.attaching[key]?.length ?? 0)
  // A thread's replies count in its channel's slow mode: the channel's countdown.
  const slowLeft = useCountdown(useP2p(s => s.slowUntil[key.split('#')[0]] ?? 0))
  const siteTextOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const held = useContext(ChannelCanContext)
  const noFiles = channelTextOnly || !held.attach
  const textOnly = noFiles || siteTextOnly
  const sel = useRef({ start: 0, end: 0 })
  const typedAt = useRef(0)
  const getText = () => identity.useP2p.getState().drafts[key] ?? ''
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
  const linkPrefs = useStore(s => s.linkPrefs)

  const typing = focused && text.trim() !== ''
  useEffect(() => {
    if (!typing) {
      if (typedAt.current) p2pDm.typing(key, false)
      typedAt.current = 0
      return
    }
    const now = Date.now()
    if (now - typedAt.current < p2pDm.typingEvery(key)) return
    typedAt.current = now
    p2pDm.typing(key, true)
  }, [typing, text, key])

  if (disabled) return <>{disabled}</>
  if (unstarted && !held.threads)
    return (
      <NoteBar data-no-send>
        <Row as="span" gap="sm">
          <Lock size={16} className="shrink-0" />
          <span>{NO_THREADS_TEXT}</span>
        </Row>
      </NoteBar>
    )

  const count = charCount(text)
  const tooLong = count > BODY_MAX || bodyTooLong(text)
  const send = () => {
    if ((noFiles && files > 0) || (!text.trim() && !files) || tooLong || slowLeft > 0) return
    const sent = text
    void p2pDm.send(key, outgoing(linkPrefs, sent)).then(ok => {
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
  ) : channelTextOnly && (forwardClip?.has_media || forwardClip?.has_poll) ? (
    <ComposerBar onClose={() => store.getState().clearForward()} closeLabel="Discard forward">
      This channel only accepts text.
    </ComposerBar>
  ) : forwardClip ? (
    <ForwardBar
      draftKey={scope}
      destination={p2pDestination(key)}
      onSend={showSource => {
        const s = store.getState()
        const clip = s.forwardClip
        if (clip !== forwardClip || !clipAllowed(s, clip, account)) return
        const names = clipSourceNames(account, clip)
        void p2pDm.forward(key, p2pForward(clip, fwdSource(clip.source, names, showSource))).then(
          identity.inIdentity(ok => {
            if (!ok) return
            if (store.getState().forwardClip === clip) store.getState().clearForward()
            identity.p2pHost.toast('Forwarded to', title)
          })
        )
      }}
    />
  ) : null

  return (
    <div className="shrink-0 px-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] keyboard:pb-3">
      <Stack gap="sm" align="start">
        <PeerCodeButton text={text} peer />
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
        {(!textOnly || files > 0) && <PendingFiles room={key} />}
        <Stack gap="2xs" place="w-full">
          {slowLeft > 0 && (
            <Row as="p" role="status" data-p2p-slow-left gap="2xs" justify="end">
              <Clock size={12} className="shrink-0 text-on-surface-variant" />
              <span className="text-xs text-on-surface-variant tabular-nums">
                Slow mode: {clock(slowLeft)}
              </span>
            </Row>
          )}
          <Stack gap="none">
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
                placeholder={streamer ? 'Send a P2P message' : placeholder + suffix}
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
                disabled={tooLong || slowLeft > 0 || (noFiles && files > 0)}
                className="shrink-0 rounded-full bg-primary p-2 text-on-primary hover:opacity-90 disabled:opacity-40"
              >
                <SendHorizontal size={16} />
              </button>
            </div>
          </Stack>
        </Stack>
      </Stack>
    </div>
  )
}

// The rows of a conversation, channel or thread for the shared message components: numbered
// messages, the reaction and mention source, the edit binding and the row menu.
export interface ListOpts {
  messages: P2pMessage[]
  nameOf: (ik: string) => string
  // Who a sender is here, when the place shows more than a name (a server's own looks).
  userOf?: (ik: string) => UserRef
  // The sender's own profile name, for forwards (never a petname or a masked name).
  ownName: (ik: string) => string
  people: Mentionable[]
  // The conversation or room the list is in, and the channel of a room.
  room: string
  ch: string | null
  draftKey: string
  scope: string
  canAct: boolean
  timedOut?: boolean
  mayPin: boolean
  mayDelete: (p: P2pMessage) => boolean
  forwardSkip: string | null
  // A server channel's own list: its messages can start threads.
  threads: boolean
  // What we hold in the list's channel, where its caller knows it (else the context's).
  can?: ChannelCan
}

export function useP2pList({
  messages,
  nameOf,
  userOf,
  ownName,
  people,
  room,
  ch,
  draftKey,
  scope,
  canAct,
  timedOut = false,
  mayPin,
  mayDelete,
  forwardSkip,
  threads,
  can,
}: ListOpts) {
  const identity = useP2pApp()!
  const { p2pUser, p2pDm } = identity
  const around = useContext(ChannelCanContext)
  const held = can ?? around

  const acct = useAccount()

  const me = useP2p(s => s.me)
  const editingState = useP2p(s => (s.editing?.room === draftKey ? s.editing : null))
  const [picker, setPicker] = useState<{ m: Message; anchor: HTMLElement | null } | null>(null)
  const user = useCallback(
    (ik: string) => userOf?.(ik) ?? p2pUser(ik, nameOf(ik)),
    [nameOf, userOf]
  )
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

  const place = useMemo(() => {
    const list: P2pList = {
      me,
      idOf,
      message: id => rows.find(r => r.p.id === id)?.p,
      user,
      name: nameOf,
      names,
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
      openPicker: (m, anchor) => setPicker({ m, anchor }),
    }
    return (ch === null ? P2pDm.open(identity, room) : P2pRoom.open(identity, room)).shownBy(list)
  }, [identity, room, ch, idOf, rows, user, nameOf, names, me, people])
  // The picker of this list reacts through its own place.
  const react = useCallback(
    (m: Message, emoji: string, note?: boolean) => {
      const here = featureAt(chatFeature, place)
      if (!isUnsupported(here)) here.toggleReaction(m, emoji, note)
    },
    [place]
  )

  const editing = useMemo<EditBinding | null>(
    () =>
      editingState
        ? {
            max: BODY_MAX,
            text: editingState.text,
            listKey: scope,
            focus: editingState.focus,
            getText: () => identity.useP2p.getState().editing?.text ?? '',
            setText: p2pDm.setEditText,
            save: () => void p2pDm.saveEdit(),
            cancel: () => p2pDm.cancelEdit(),
            ...(editingState.alt
              ? { alt: { text: editingState.alt.text, set: p2pDm.setEditAlt } }
              : {}),
          }
        : null,
    [editingState, scope]
  )

  const rowTarget = (p: P2pMessage, m: Message): Target => ({
    kind: 'p2p_message',
    p,
    m,
    chat: {
      draftKey,
      canAct,
      timedOut,
      can: held,
      mayPin,
      mayDelete,
      forwardSkip,
      threads,
      ownName,
    },
  })
  const menu = (p: P2pMessage, m: Message, x: number, y: number) => {
    if (p.system?.kind === 'pin')
      return openActionMenu(x, y, { kind: 'p2p_pin_line', p, m }, undefined, acct, identity)
    openActionMenu(
      x,
      y,
      rowTarget(p, m),
      canAct && !timedOut && held.react && !p.archived
        ? {
            header: (
              <PlaceProvider place={place}>
                <QuickReactions m={m} anchor={rowAt(x, y)} />
              </PlaceProvider>
            ),
          }
        : undefined,
      acct,
      identity
    )
  }
  const forward = (id: string) => {
    const row = rows.find(r => r.p.id === id)
    return row ? actionPress('p2p_message_forward', rowTarget(row.p, row.m), acct, identity) : null
  }
  const menuRef = useRef({ menu, forward })
  useEffect(() => {
    menuRef.current = { menu, forward }
  })
  const rowMenu = useCallback(
    (p: P2pMessage, m: Message, x: number, y: number) => menuRef.current.menu(p, m, x, y),
    []
  )
  // What the image viewer's Forward button runs for message `id`.
  const forwardRow = useCallback(
    (id: string | number) => (typeof id === 'string' ? menuRef.current.forward(id) : null),
    []
  )
  const copyRow = useCallback(
    (p: P2pMessage, m: Message) =>
      peerChat.forIdentity(identity).copyForP2p(p, m, ownName(p.sender), draftKey, acct),
    [ownName, draftKey, identity, acct]
  )
  return {
    me,
    user,
    rows,
    shared,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowMenu,
    forwardRow,
    copyRow,
    picker,
    setPicker,
  }
}

export interface ChatBodyProps {
  channelTextOnly?: boolean
  chat: P2pChat
  // The header row, and what goes between it and the list (call bars, the stage).
  header: ReactNode
  above?: ReactNode
  intro?: ReactNode
  // In place of the composer, with the reason; null when sending works.
  disabled: ReactNode
  canAct: boolean
  // A timeout of ours: messages can be deleted and files downloaded, nothing more.
  timedOut?: boolean
  // Display names, and who a message may mention.
  nameOf: (ik: string) => string
  userOf?: (ik: string) => UserRef
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
  dataAttr: Record<string, string>
  // How senders' names look, in a server.
  lookOf?: (ik: string) => Look
}

// The open conversation's first unread message when it isn't loaded, looked up in storage once
// per `key` (null: not needed).
function useFirstUnread(key: string | null) {
  const { p2pDm } = useP2pApp()!
  const [found, setFound] = useState<{ key: string; id: string; ts: number } | null>(null)
  useEffect(() => {
    if (key === null) return
    let live = true
    void p2pDm.firstUnread().then(r => {
      if (live && r) setFound({ key, ...r })
    })
    return () => {
      live = false
    }
  }, [key, p2pDm])
  return found && found.key === key ? found : null
}

function IdentityChatBody(props: ChatBodyProps) {
  const identity = useP2pApp()!
  const { profileName, p2pDm, p2pFiles } = identity

  const { chat, canAct, nameOf, people, mayDelete, mayPin, disabled, forwardSkip, typingNames } =
    props
  const timedOut = props.timedOut ?? false
  const key = chatKey(chat)
  const me = useP2p(s => s.me)
  const movingAt = useP2p(s => s.movingAt)
  const focus = useP2p(s => (s.focus && s.focus.room === s.chat?.room ? s.focus : null))
  const pulling = useP2p(s => s.pulling)
  const storageFull = useP2p(s => s.storageFull)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const siteTextOnly = useStore(s => !s.settings.asset_uploads && !s.settings.p2p_attachments)
  const held = useContext(ChannelCanContext)
  const textOnly = props.channelTextOnly || siteTextOnly || !held.attach
  const [dragging, setDragging] = useState(false)
  const dragDepth = useRef(0)

  const messages = chat.messages ?? EMPTY
  const list = messagesAt(
    chat.ch ? P2pRoom.open(identity, chat.room) : P2pDm.open(identity, chat.room)
  )
  const listState = useLive(list.state)
  const scope = identityScopeKey(identity.localId, chatScope(chat.room, chat.ch))
  const ownRoom = chat.ch ? chat.room : undefined
  const ownName = useCallback((ik: string) => profileName(ik, ownRoom), [ownRoom])
  const canDrop = canAct && !timedOut && !textOnly && movingAt === null

  const {
    rows,
    shared,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowMenu,
    forwardRow,
    copyRow,
    picker,
    setPicker,
  } = useP2pList({
    messages,
    nameOf,
    userOf: props.userOf,
    ownName,
    people,
    room: chat.room,
    ch: chat.ch ?? null,
    draftKey: key,
    scope,
    canAct,
    timedOut,
    mayPin,
    mayDelete,
    forwardSkip,
    threads: true,
  })

  const lastNum = shared[shared.length - 1]?.id
  const ownCount = useMemo(() => messages.filter(m => m.sender === me).length, [messages, me])
  // The conversation opens or syncs with nothing loaded yet.
  const first = chat.loading === true && messages.length === 0
  const scroll = useChatScroll({
    list: listRef,
    content: contentRef,
    scope,
    count: shared.length,
    lastId: lastNum,
    stale: first,
    focus: focus !== null,
    detached: false,
    outCount: ownCount,
    onBottom: () => {
      if (typeof document !== 'undefined' && document.visibilityState === 'visible')
        list.markRead(messages[messages.length - 1]?.id ?? '')
    },
  })
  const fresh = newSince(shared, scroll.leftAt, me ?? undefined)
  const flash = useP2pFlash(listRef, scope, focus, num, shared, scroll.settle)

  const start = useMemo(
    () => p2pUnreadStart(messages, chat.readSeq, me, chat.more),
    [messages, chat.readSeq, me, chat.more]
  )
  // Unread messages that aren't loaded (or may be older than the first loaded row).
  const above =
    (start.first < 0 || start.ambiguous) &&
    !start.sent &&
    !!chat.readSeq &&
    (chat.unread ?? 0) > 0 &&
    !chat.loading
  const firstUnread = useFirstUnread(above ? `${chat.room}:${chat.ch ?? ''}:${chat.readSeq}` : null)
  const divider = start.ambiguous
    ? firstUnread && firstUnread.id === messages[0]?.id
      ? 0
      : -1
    : start.first
  const places = useMemo(
    () => groupPlaces(messages.map(p2pCue), new Set([divider])),
    [messages, divider]
  )
  const days = useMemo(() => dayStarts(rows.map(r => r.m.created_at)), [rows])
  const unread = useMemo(
    () =>
      p2pUnread(
        messages,
        divider,
        !chat.newer,
        me,
        { count: chat.unread ?? 0, seq: chat.unreadSeq ?? 0 },
        firstUnread
      ),
    [messages, divider, chat.newer, me, chat.unread, chat.unreadSeq, firstUnread]
  )

  const rowJump = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) list.jump(id)
    },
    [idOf, list]
  )

  const gapNote = props.gap && !chat.more && (
    <Surface data-p2p-gap pad="lg" tone="plain" radius="none">
      <div className="flex flex-wrap items-center justify-center gap-2">
        <History size={14} className="text-on-surface-variant" />
        {props.online ? (
          <>
            <span className="text-xs text-on-surface-variant">
              Older messages are not on this device yet.
            </span>
            <button onClick={p2pDm.loadOlderHistory} disabled={pulling} className={textBtn}>
              {pulling ? 'Loading…' : 'Load older'}
            </button>
          </>
        ) : (
          <span className="text-xs text-on-surface-variant">{props.gapOffline}</span>
        )}
      </div>
    </Surface>
  )

  return (
    <PlaceProvider place={place}>
      <main
        {...props.dataAttr}
        className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
        data-share-drop-pane
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
        <MessageList
          list={list}
          state={listState}
          listRef={listRef}
          contentRef={contentRef}
          onScroll={scroll.onScroll}
          loading={first}
          positioned={scroll.positioned}
          ends={
            messages.length
              ? { first: messages[0].id, last: messages[messages.length - 1].id }
              : null
          }
          banner={
            divider >= 0 || above
              ? {
                  unread,
                  onJump: () => {
                    const id = divider >= 0 ? messages[divider].id : firstUnread?.id
                    if (id) list.jump(id)
                  },
                }
              : null
          }
          fresh={fresh}
          toBottom={scroll.toBottom}
          intro={props.intro}
          empty={
            !chat.loading &&
            messages.length === 0 && (
              <div className="h-full text-center text-on-surface-variant opacity-70">
                <Surface pad="xl" tone="plain" radius="none" place="h-full">
                  <Stack gap="2xs" align="center" justify="center" place="flex-1">
                    {props.empty}
                  </Stack>
                </Surface>
              </div>
            )
          }
          lightbox={{ rows: () => ({ ids: messages.map(p => p.id), places }), forward: forwardRow }}
          head={gapNote}
        >
          {rows.map(({ p, m }, i) => (
            <Fragment key={p.id}>
              {days.has(i) && <DateDivider at={m.created_at} />}
              {p.system?.kind === 'pin' ? (
                <P2pPinRow
                  p={p}
                  m={m}
                  divider={i === divider}
                  place={chat.ch ? 'channel' : 'conversation'}
                  onMenu={(row, x, y) => rowMenu(row, m, x, y)}
                />
              ) : p.system ? (
                <P2pSystemRow m={m} divider={i === divider} />
              ) : p.removed ? (
                <P2pHiddenRow m={m} divider={i === divider} />
              ) : p.slowHidden ? (
                <P2pSlowRow m={m} divider={i === divider} />
              ) : p.call ? (
                <P2pCallRow p={p} me={me} />
              ) : (
                <P2pRow
                  p={p}
                  m={m}
                  first={places[i]?.first ?? true}
                  last={places[i]?.last ?? true}
                  mine={p.sender === me}
                  pendingTip={props.peerFull ? 'Their storage is full' : props.pendingTip}
                  mentioned={pingsMe(p, me)}
                  divider={i === divider}
                  flash={flash === m.id}
                  canAct={canAct && !p.archived}
                  timedOut={timedOut}
                  canDelete={mayDelete(p)}
                  editing={editing && editingState?.id === p.id ? editing : null}
                  draftKey={key}
                  threads
                  onMenu={rowMenu}
                  onCopy={copyRow}
                  onJump={rowJump}
                  {...rowLook(props.lookOf?.(p.sender))}
                />
              )}
            </Fragment>
          ))}
        </MessageList>
        <div className="relative shrink-0">
          <TypingIndicator scope={null} bg="bg-surface" names={typingNames} />
          {!disabled && (storageFull || props.peerFull) && (
            <NoteBar data-p2p-full role="status">
              <CircleAlert size={16} className="shrink-0 text-error" aria-hidden />
              {storageFull ? STORAGE_FULL_TEXT : PEER_FULL_TEXT}
            </NoteBar>
          )}
          <P2pComposer
            draftKey={key}
            channelTextOnly={props.channelTextOnly}
            scope={scope}
            title={props.title}
            placeholder={props.placeholder}
            nameOf={nameOf}
            disabled={disabled}
          />
        </div>
        <PinsWindow canUnpin={canAct && !timedOut && mayPin} />
        <ThreadsWindow />
        {picker && (
          <EmojiPicker
            anchor={picker.anchor?.isConnected ? picker.anchor : null}
            side="top"
            align="end"
            label="Add reaction"
            onPick={e => react(picker.m, e, false)}
            onClose={() => setPicker(null)}
          />
        )}
        {dragging && (
          <div className="pointer-events-none absolute inset-2 z-10 flex items-center justify-center rounded-2xl border-2 border-dashed border-tertiary bg-surface/80 font-medium text-tertiary">
            Drop files to send peer-to-peer
          </div>
        )}
      </main>
    </PlaceProvider>
  )
}

export const P2pIntro = withP2pIdentity(P2pIntroBody)
export const P2pComposer = withP2pIdentity(P2pComposerBody)
export const P2pChatBody = withP2pIdentity(IdentityChatBody)
