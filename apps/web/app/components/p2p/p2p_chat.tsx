'use client'
import { Button, IconButton } from '../controls'
import { identityScopeKey } from '../../lib/p2p/app/host'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useAccount } from '../../lib/client/react'

import { Fragment, useEffect, useMemo, useRef, type ReactNode, type RefObject } from 'react'
import { CircleAlert, History, X } from 'lucide-react'
import { noticeOpen } from '../../lib/home'
import { useHome } from '../../lib/home_store'
import { chatKey, chatScope, type P2pChat } from '../../lib/p2p/app'
import { STORAGE_FULL_TEXT, PEER_FULL_TEXT } from '../../lib/p2p/dm'
import { newSince } from '../../lib/lists'
import type { Message } from '../../lib/types'
import { P2pDm, P2pRoom } from '../../lib/place/place'
import { shownOf } from '../../lib/place/shown'
import { PlaceProvider, useLive } from '../../lib/place/react'
import { messagesAt } from '../../lib/place/use_messages'
import { MessageList } from '../message_list'
import { Composer } from '../composer'
import { PinsWindow } from '../pins'
import { useGate } from '../composer_gate'
import { GateNote } from '../gate_note'
import { composeAt } from '../../lib/place/use_composer'
import { ListedRow } from '../listed_row'
import { ListReactPicker } from '../list_picker'
import { useRowHandlers } from '../row_handlers'
import { useFileDrop } from '../file_drop'
import { useRowFlags } from '../row_flags'
import { rowsAt } from '../../lib/place/use_rows'
import { ThreadsWindow } from '../threads'
import { TypingLine } from '../typing_indicator'
import { useChatScroll, useFocusMessage } from '../viewport_height'
import { groupPlaces, p2pCue } from '../../lib/message_groups'
import { dayStarts } from '../../lib/date_dividers'
import { DateDivider } from '../date_divider'
import { P2pBadge } from './p2p_badge'
import { Row, Stack, Surface } from '../layout'
import { playsOn } from '../../lib/motion/play'

// The message list and composer of a P2P conversation, shared by direct messages and P2P server
// channels: what differs (the header, who may do what, names, mentions) comes in as props.

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

export interface ChatBodyProps {
  chat: P2pChat
  // The header row, and what goes between it and the list (call bars, the stage).
  header: ReactNode
  above?: ReactNode
  intro?: ReactNode
  peerFull: boolean
  gap: boolean
  online: boolean
  // What the gap note says while nobody who has older history is online.
  gapOffline: ReactNode
  empty: ReactNode
  dataAttr: Record<string, string>
}

function IdentityChatBody(props: ChatBodyProps) {
  const identity = useP2pApp()!
  const { p2pDm } = identity

  const { chat } = props
  const key = chatKey(chat)
  const me = useP2p(s => s.me)
  const focus = useP2p(s => (s.focus && s.focus.room === s.chat?.room ? s.focus : null))
  const pulling = useP2p(s => s.pulling)
  const storageFull = useP2p(s => s.storageFull)
  const listRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  const list = messagesAt(
    chat.ch ? P2pRoom.open(identity, chat.room) : P2pDm.open(identity, chat.room)
  )
  const listState = useLive(list.state)
  const scope = identityScopeKey(identity.localId, chatScope(chat.room, chat.ch))
  const place = chat.ch ? P2pRoom.open(identity, chat.room) : P2pDm.open(identity, chat.room)
  const { messages, rows, num } = useLive(shownOf(place))
  const shared = useMemo(
    () => rows.filter(r => !r.p.system && !r.p.removed && !r.p.slowHidden).map(r => r.m),
    [rows]
  )
  const flags = useRowFlags(rowsAt(place, 'main'))
  const { on, forwardShown, editing } = useRowHandlers('main', place)
  const drop = useFileDrop({ place })

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
  const { shut } = useGate(composeAt(place, 'main'))
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
      <main
        ref={playsOn('route', key)}
        {...props.dataAttr}
        className="relative flex h-full min-w-0 flex-1 flex-col bg-surface"
        data-share-drop-pane
        {...drop.handlers}
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
            forward: forwardShown,
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
                editing={editing(m, p.id)}
                {...flags.of(m)}
                on={on}
              />
            </Fragment>
          ))}
        </MessageList>
        <div className="relative shrink-0">
          <TypingLine bg="bg-surface" />
          {!shut && (storageFull || props.peerFull) && (
            <GateNote data-p2p-full role="status">
              <CircleAlert size={16} className="shrink-0 text-error" aria-hidden />
              {storageFull ? STORAGE_FULL_TEXT : PEER_FULL_TEXT}
            </GateNote>
          )}
          <Composer />
        </div>
        <PinsWindow />
        <ThreadsWindow />
        <ListReactPicker />
        {drop.note}
      </main>
    </PlaceProvider>
  )
}

export const P2pIntro = withP2pIdentity(P2pIntroBody)
export const P2pChatBody = withP2pIdentity(IdentityChatBody)
