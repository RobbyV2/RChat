'use client'
import { Button, IconButton } from '../controls'
import { identityScopeKey } from '../../lib/p2p/app/host'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'
import { ChannelCanContext } from '../../lib/place/use_rights'
import { type ChannelCan } from '../../lib/channel_perms'

import {
  createContext,
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { CircleAlert, History, X } from 'lucide-react'
import { useStore } from '../../lib/store'
import { actionPress, openActionMenu } from '../../lib/actions/menu'
import type { Target } from '../../lib/actions/types'
import { peerChat } from '../../lib/actions/p2p_chat'
import { noticeOpen } from '../../lib/home'
import { useHome } from '../../lib/home_store'
import { chatKey, chatScope, type P2pChat } from '../../lib/p2p/app'
import { STORAGE_FULL_TEXT, PEER_FULL_TEXT, type P2pMessage } from '../../lib/p2p/dm'
import { LIMITS as P2P_LIMITS } from '../../lib/p2p/content'
import { newSince } from '../../lib/lists'
import type { Message } from '../../lib/types'
import { isHosted, P2pDm, P2pRoom, type ListKind } from '../../lib/place/place'
import { reactPickOf, shownOf } from '../../lib/place/shown'
import { PlaceProvider, useLive, usePlace } from '../../lib/place/react'
import { messagesAt } from '../../lib/place/use_messages'
import { MessageList } from '../message_list'
import { Composer } from '../composer'
import { chat as chatFeature } from '../../lib/place/chat'
import { featureAt, isUnsupported } from '../../lib/place/feature'
import { type EditBinding } from '../message_editor'
import { QuickReactions, rowAt } from '../reactions'
import { useVouchedFiles } from '../forwards'
import { PinsWindow } from '../pins'
import { useGate } from '../composer_gate'
import { GateNote } from '../gate_note'
import { composeAt } from '../../lib/place/use_composer'
import { ListedRow, useRowFlags } from '../listed_row'
import { rowsAt } from '../../lib/place/use_rows'
import { ThreadsWindow } from '../threads'
import { TypingIndicator } from '../typing_indicator'
import { EmojiPicker } from '../emoji_picker'
import { useChatScroll, useFocusMessage } from '../viewport_height'
import { type RowHandlers } from '../message_row'
import { groupPlaces, p2pCue } from '../../lib/message_groups'
import { dayStarts } from '../../lib/date_dividers'
import { DateDivider } from '../date_divider'
import { P2pBadge } from './p2p_badge'
import { AttachmentList } from './p2p_files'
import { Row, Stack, Surface } from '../layout'
import { playsOn } from '../../lib/motion/play'

// The message list and composer of a P2P conversation, shared by direct messages and P2P server
// channels: what differs (the header, who may do what, names, mentions) comes in as props.

const BODY_MAX = P2P_LIMITS.body

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
            <IconButton
              icon={X}
              label="Dismiss"
              tone="inherit"
              size="sm"
              onClick={() => acct.home.hideTip(id)}
              place="shrink-0"
            />
          </Row>
        </Surface>
      </div>
    </Surface>
  )
}

// Whether the files of the rows around can be fetched.
export const CanFetchContext = createContext(false)

function ListFiles({ m, place }: { m: Message; place: P2pRoom | P2pDm }) {
  const shown = useLive(shownOf(place))
  const canFetch = useContext(CanFetchContext)
  const vouched = useVouchedFiles(m.forward?.p2p)
  const id = shown.idOf(m.id)
  const p = id === null ? undefined : shown.message(id)
  if (!p) return null
  return (
    <AttachmentList
      att={vouched ?? p.fwd?.att ?? p.att}
      canFetch={canFetch && (place.list === 'thread' || !p.archived)}
      own={!p.fwd && p.sender === shown.me}
      message={p.id}
    />
  )
}

// The files a P2P message carries, under its text.
export function RowFiles({ m }: { m: Message }) {
  const place = usePlace()
  return place && !isHosted(place) ? <ListFiles m={m} place={place} /> : null
}

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

// The rows of a conversation, channel or thread for the shared message components: numbered
// messages, the reaction and mention source, the edit binding and the row menu.
export interface ListOpts {
  // The sender's own profile name, for forwards (never a petname or a masked name).
  ownName: (ik: string) => string
  // The conversation or room the list is in, the channel of a room, and which of its lists.
  room: string
  ch: string | null
  list: ListKind
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
  ownName,
  room,
  ch,
  list,
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
  const { p2pDm } = identity
  const around = useContext(ChannelCanContext)
  const held = can ?? around

  const acct = useAccount()

  const editingState = useP2p(s => (s.editing?.room === draftKey ? s.editing : null))
  const place = ch === null ? P2pDm.open(identity, room, list) : P2pRoom.open(identity, room, list)
  const { me, user, name, messages, rows, num, idOf } = useLive(shownOf(place))
  const picking = reactPickOf(place)
  const picker = useLive(picking)
  const setPicker = picking.set
  const shared = useMemo(
    () => rows.filter(r => !r.p.system && !r.p.removed && !r.p.slowHidden).map(r => r.m),
    [rows]
  )
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
            save: fine => void p2pDm.saveEdit(fine),
            cancel: fine => p2pDm.cancelEdit(fine),
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
  const live = shownOf(place)
  // What this list does for its rows, with `jump` showing the message a quote answers.
  const rowOn = useCallback(
    (jump: (num: number) => void): RowHandlers => {
      const stored = (m: Message) => {
        const list = live.get()
        const id = list.idOf(m.id)
        return id === null ? undefined : list.message(id)
      }
      const withStored = (m: Message, run: (p: P2pMessage) => void) => {
        const p = stored(m)
        if (p) run(p)
      }
      return {
        menu: (m, x, y) => withStored(m, p => menuRef.current.menu(p, m, x, y)),
        jump,
        edit: m => withStored(m, p => p2pDm.startEdit(draftKey, p.id)),
        reply: m => withStored(m, p => p2pDm.startReply(draftKey, p.id)),
        forward: m =>
          withStored(m, p =>
            peerChat.forIdentity(identity).copyForP2p(p, m, ownName(p.sender), draftKey, acct)
          ),
        thread: m => withStored(m, p => void identity.p2pThread.open(p.id)),
        remove: (m, skipConfirm) =>
          withStored(m, p => peerChat.forIdentity(identity).confirmDelete(p.id, skipConfirm, acct)),
        retry: m => withStored(m, p => void p2pDm.retry(p.id)),
      }
    },
    [live, draftKey, ownName, identity, acct, p2pDm]
  )
  return {
    me,
    user,
    name,
    messages,
    rows,
    shared,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowOn,
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
  canAct: boolean
  // A timeout of ours: messages can be deleted and files downloaded, nothing more.
  timedOut?: boolean
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
}

function IdentityChatBody(props: ChatBodyProps) {
  const identity = useP2pApp()!
  const { profileName, p2pDm, p2pFiles } = identity

  const { chat, canAct, mayDelete, mayPin, forwardSkip, typingNames } = props
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

  const list = messagesAt(
    chat.ch ? P2pRoom.open(identity, chat.room) : P2pDm.open(identity, chat.room)
  )
  const listState = useLive(list.state)
  const scope = identityScopeKey(identity.localId, chatScope(chat.room, chat.ch))
  const ownRoom = chat.ch ? chat.room : undefined
  const ownName = useCallback((ik: string) => profileName(ik, ownRoom), [ownRoom])
  const canDrop = canAct && !timedOut && !textOnly && movingAt === null

  const {
    messages,
    rows,
    shared,
    num,
    idOf,
    place,
    react,
    editing,
    editingState,
    rowOn,
    forwardRow,
    picker,
    setPicker,
  } = useP2pList({
    ownName,
    room: chat.room,
    ch: chat.ch ?? null,
    list: 'main',
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

  const { divider, banner } = useLive(list.unread)
  useEffect(() => list.watchUnread(), [list])
  const places = useMemo(
    () => groupPlaces(messages.map(p2pCue), new Set([divider])),
    [messages, divider]
  )
  const days = useMemo(() => dayStarts(rows.map(r => r.m.created_at)), [rows])
  const rowJump = useCallback(
    (n: number) => {
      const id = idOf(n)
      if (id) list.jump(id)
    },
    [idOf, list]
  )
  const on = useMemo(() => rowOn(rowJump), [rowOn, rowJump])
  const { shut } = useGate(composeAt(place, 'main'))
  const flags = useRowFlags(rowsAt(place, 'main'))

  const gapNote = props.gap && !chat.more && (
    <Surface data-p2p-gap pad="lg" tone="plain" radius="none">
      <Row gap="sm" justify="center" wrap>
        <History size={14} className="text-on-surface-variant" />
        {props.online ? (
          <>
            <span className="text-xs text-on-surface-variant">
              Older messages are not on this device yet.
            </span>
            <Button onClick={p2pDm.loadOlderHistory} disabled={pulling}>
              {pulling ? 'Loading…' : 'Load older'}
            </Button>
          </>
        ) : (
          <span className="text-xs text-on-surface-variant">{props.gapOffline}</span>
        )}
      </Row>
    </Surface>
  )

  return (
    <PlaceProvider place={place}>
      <CanFetchContext.Provider value={canAct}>
        <main
          ref={playsOn('route', key)}
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
            banner={banner ? { unread: banner, onJump: list.toUnread } : null}
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
            lightbox={{
              rows: () => ({ ids: messages.map(p => p.id), places }),
              forward: forwardRow,
            }}
            head={gapNote}
          >
            {rows.map(({ p, m }, i) => (
              <Fragment key={p.id}>
                {days.has(i) && <DateDivider at={m.created_at} />}
                <ListedRow
                  m={m}
                  first={places[i]?.first ?? true}
                  last={places[i]?.last ?? true}
                  divider={i === divider}
                  flash={flash === m.id}
                  editing={editing && editingState?.id === p.id ? editing : false}
                  {...flags.of(m)}
                  Files={RowFiles}
                  on={on}
                />
              </Fragment>
            ))}
          </MessageList>
          <div className="relative shrink-0">
            <TypingIndicator scope={null} bg="bg-surface" names={typingNames} />
            {!shut && (storageFull || props.peerFull) && (
              <GateNote data-p2p-full role="status">
                <CircleAlert size={16} className="shrink-0 text-error" aria-hidden />
                {storageFull ? STORAGE_FULL_TEXT : PEER_FULL_TEXT}
              </GateNote>
            )}
            <Composer />
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
            <div className="pointer-events-none absolute inset-2 z-raised flex items-center justify-center rounded-2xl border-2 border-dashed border-tertiary bg-surface/80 font-medium text-tertiary">
              Drop files to send peer-to-peer
            </div>
          )}
        </main>
      </CanFetchContext.Provider>
    </PlaceProvider>
  )
}

export const P2pIntro = withP2pIdentity(P2pIntroBody)
export const P2pChatBody = withP2pIdentity(IdentityChatBody)
