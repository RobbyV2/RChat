'use client'
import { Name } from './name'
import { asAccount } from '../lib/people'
import { personName } from '../lib/names'
import { StoredLock } from './storage_settings'
import { ViewActorTag } from './view_actor'
import { useP2pApp } from '../lib/client/p2p_react'

import { useAccount, useStoreApi } from '../lib/client/react'

import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  Clock,
  Hash,
  Lock,
  Menu,
  MessagesSquare,
  NotebookPen,
  Search,
  Users,
  Volume2,
} from 'lucide-react'
import { newSince } from '../lib/lists'
import { SELF_DM_TEXT, SELF_DM_TITLE } from '../lib/dm_list'
import { dayStarts } from '../lib/date_dividers'
import { escapeMarksRead } from '../lib/follow'
import { mentionLookups } from '../lib/mentions'
import { useChannelCan } from '../lib/place/use_rights'
import { useHostedServer, useLive } from '../lib/place/react'
import { slowTitle } from '../lib/slowmode'
import { messageRights } from '../lib/actions/message'
import { actionPress, openActionMenu } from '../lib/actions/menu'
import { HeaderMore } from './header_more'
import {
  confirmDeleteMessage,
  useStore,
  viewKey,
  allPings,
  type ContextMenuOptions,
  type Outgoing,
} from '../lib/store'
import type { Message, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { UnreadDivider } from './unread_banner'
import { DateDivider } from './date_divider'
import { MarkdownMessage } from './markdown_message'
import { ShownName } from './shown_user'
import { TypingLine } from './typing_indicator'
import { Composer } from './composer'
import StatusClock from './status_clock'
import { InboxButton } from './inbox'
import { longPress, useMedia } from './context_menu'
import { profileTrigger } from './profile_card'
import { useCallShare, VoiceGrid } from './voice_grid'
import { ChannelTopic } from './channel_topic'
import { CallButtons } from './call_buttons'
import { useChatScroll, useFocusMessage, useScrollAnchor } from './viewport_height'
import { Masked, useEscape, useOwnServer } from './ui'
import { showsUsername } from '../lib/display_name'
import { PingBadge, pingLabel } from './ping_badge'
import { groupPadCls } from './grouped_row'
import { QuickReactions, rowAt } from './reactions'
import { ReplyPreview } from './replies'
import { ForwardCard } from './forwards'
import { MessageList, NewerOnSight } from './message_list'
import { AuthorRow, GroupedRow, type RowHandlers } from './message_row'
import { useFace } from '../lib/place/use_looks'
import { useRows } from '../lib/place/use_rows'
import { useMessages } from '../lib/place/use_messages'
import { PinsButton, PinsWindow, useCanPin } from './pins'
import { ListedRow, useRowFlags } from './listed_row'
import { ThreadsButton, ThreadsWindow } from './threads'
import { useMyTimeoutEnds } from './timeout_dialog'
import { isNotice } from '../lib/system_messages'
import { hostedDmSeal } from '../lib/sealing'
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
import { ChatWorkNotices } from './own_load'
import { Button, IconButton, LinkButton } from './controls'
import { playsOn } from '../lib/motion/play'

export { groupPadCls } from './grouped_row'

const EMPTY: Message[] = []

const EMPTY_OUT: Outgoing[] = []

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

export function useAuthorMembers(server: string | null, key: string) {
  const ensureMembers = useStore(s => s.ensureMembers)
  const cached = useStore(s => (server ? s.memberInfo[server] !== undefined : false))
  const trim = useStore(s => (server ? (s.memberInfoTrim[server] ?? 0) : 0))
  useEffect(() => {
    if (server && key) void ensureMembers(server, key.split('\n'))
  }, [server, key, cached, trim, ensureMembers])
}

const unreadDivider = <UnreadDivider />

// The new messages banner of a hosted list: counted from the loaded rows, or asked of the server
// while the first unread message or the newest one isn't loaded (`away`: the unread part is above
// or below what is loaded).

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
  const face = useFace(author)
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
          <LinkButton onClick={onRetry}>Retry</LinkButton>
          <LinkButton onClick={onCancel} tone="error">
            Delete
          </LinkButton>
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
          face={face}
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
          name={<ShownName user={author} server={server} look="sr-only" />}
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
  const list = useMessages()
  const listState = useLive(list.state)
  const { older, newer } = listState
  const stale = useStore(s => (s.view ? s.stale[viewKey(s.view)] === true : false))
  const focus = useStore(s => (s.view ? s.focus[viewKey(s.view)] : undefined))
  const menuPings = useStore(allPings)
  const memberServer = view?.kind === 'channel' ? view.server : null
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
  const { divider: dividerIndex, banner: unread } = useLive(list.unread)
  useEffect(() => list.watchUnread(), [list])
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
  const settings = useStore(s => s.settings)
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

  const flags = useRowFlags(useRows('main'))
  const timedOutEnds = useMyTimeoutEnds(view?.kind === 'channel' ? view.server : null)

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
  const rowJump = useCallback(
    (id: number) => {
      if (scope) void jumpTo(scope, id)
    },
    [scope, jumpTo]
  )
  const store = useStoreApi()
  const rowHandlers = useMemo<RowHandlers>(
    () => ({
      menu: rowMenu,
      jump: rowJump,
      edit: msg => editRef.current(msg),
      reply: msg => replyRef.current(msg),
      forward: msg => store.getState().copyForward(msg),
      thread: msg => void store.getState().openThread(msg),
      remove: (msg, skipConfirm) => confirmDeleteMessage(msg.id, skipConfirm),
    }),
    [rowMenu, rowJump, store, confirmDeleteMessage]
  )

  return (
    <main
      ref={playsOn('route', scope ?? '')}
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
          <Stack gap="none" rowFrom="md" rowGap="md" place="min-w-0 flex-1">
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
              <Row as="span" gap="md" align="stretch" place="min-w-0 md:flex-1">
                <span aria-hidden className="hidden w-px shrink-0 bg-outline-variant md:block" />
                <ChannelTopic channel={channel} />
              </Row>
            )}
          </Stack>
        )}
        {dm && (
          <Row
            as="span"
            {...longPress((x, y) =>
              openActionMenu(x, y, { kind: 'dm', dm, where: 'header' }, {}, acct)
            )}
            gap="sm"
            look="font-medium"
            place="min-w-0"
          >
            <DmPeer other={dm.other} />
            {hostedDmSeal(dm.seal, settings).on && <StoredLock />}
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
          {scope && <SelectButton scope={scope} narrowHidden />}
          {scope && <PinsButton narrowHidden />}
          {scope && <ThreadsButton narrowHidden />}
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
          <ChatWorkNotices server={view?.kind === 'channel' ? view.server : null} />
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
              unread
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
                  <ListedRow
                    m={m}
                    first={places[i]?.first ?? true}
                    last={places[i]?.last ?? true}
                    {...flags.of(m)}
                    divider={i === dividerIndex}
                    flash={flash === m.id}
                    editing={editingId === m.id}
                    on={rowHandlers}
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
            <TypingLine bg="bg-surface" />
            {selecting && !wide ? (
              <SelectionBar scope={scope} sheet />
            ) : dm && otherBlocked ? (
              <BlockedComposer user={dm.other} />
            ) : (
              <Composer />
            )}
          </div>
        </>
      )}
      {scope && <OpenPins />}
      {scope && <ThreadsWindow />}
      {dragging && (
        <div className="pointer-events-none absolute inset-2 z-raised flex items-center justify-center rounded-2xl border-2 border-dashed border-primary bg-surface/80 font-medium text-primary">
          Drop file to attach
        </div>
      )}
    </main>
  )
}
