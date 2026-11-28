'use client'

import { Covered } from './covered'
import { ScheduledButton } from './scheduled'
import { personName, serverCalled, serverName, labelWith } from '../lib/names'
import { Name, useNameLabels } from './name'
import { ViewActorTag } from './view_actor'
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { AtSign, Bell, Check, CheckCheck, Hash, MessageSquare, UserPlus, X } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { useStore } from '../lib/store'
import { PreviewFilename, PreviewRow, RevealChannelPreview } from './preview_reveal'
import { SpoilerLine } from './replies'
import { totalInboxCount } from '../lib/client/account_counts'
import { allPings } from '../lib/selectors'
import {
  DEFAULT_VIEW,
  DM_PLACE,
  KIND_FILTERS,
  inboxAction,
  inboxPreview,
  refreshOnCount,
  type InboxAdapter,
  type InboxEntry,
  type InboxView,
} from '../lib/inbox'
import { useAccount, useStoreApi, useLiveSessions } from '../lib/client/react'
import { PingBadge, pingLabel } from './ping_badge'
import { UserAvatar } from './user_avatar'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { MessageTime } from './timestamp'
import { Button, Chip, IconButton, ListRow, Tab } from './controls'
import { Row, Stack, Surface, Inset } from './layout'
import { Masked, Sentinel, Sheet, useEscape, useOwnServer, smallFieldCls } from './ui'
import { RowsSkeleton } from './skeletons'
import { useShown } from './shown_user'
import { INSTANCE_INBOX } from '../lib/inbox_source'
import { longPress, useMedia } from './context_menu'
import { useStable } from '../lib/stable_key'
import { time } from '../lib/platform/time'
import { inboxLoads, type InboxLoads } from '../lib/inbox_list'
import { useLive } from '../lib/place/react'
import { Loaded, useLoad } from './loaded'
import { FailureNotice } from './notices'

// Notifications that badge, from the store and from sources that count their own (P2P).
export const useInboxCount = () => {
  const { subscribeCounts, adapterCounts } = useAccount().inbox
  return useStore(allPings) + useSyncExternalStore(subscribeCounts, adapterCounts, adapterCounts)
}

export function useTotalInboxCount() {
  const sessions = useLiveSessions()
  const subscribe = useCallback(
    (listener: () => void) => {
      const remove = sessions.map(s => s.counts.subscribe(listener))
      return () => remove.forEach(off => off())
    },
    [sessions]
  )
  const count = useCallback(() => totalInboxCount(sessions), [sessions])
  return useSyncExternalStore(subscribe, count, count)
}

// Loads the inbox for a view from every source, merged by time. When the badge count changes it
// fetches the first page again and merges it in front of what is loaded, so new and cleared
// notifications show up and deeper pages stay. A lower count right after this panel marked
// something read is skipped (`markedHere`): the list already shows it.
function useInbox(view: InboxView): InboxLoads {
  const { inbox } = useAccount()
  const adapters = useSyncExternalStore(
    inbox.subscribeAdapters,
    inbox.inboxAdapters,
    inbox.inboxAdapters
  )
  const loads = useMemo(
    () => inboxLoads(time(), adapters, view, () => inbox.inboxAdapters() === adapters),
    [inbox, adapters, view]
  )
  useEffect(() => loads.start(), [loads])
  const count = useInboxCount()
  const lastCount = useRef({ loads, count })
  useEffect(() => {
    const before = lastCount.current
    lastCount.current = { loads, count }
    if (
      before.loads !== loads ||
      !refreshOnCount(before.count, count, loads.markedUntil(), time().now())
    )
      return
    return time().after(400, () => loads.reload())
  }, [count, loads])
  return loads
}

function Place({ entry }: { entry: InboxEntry }) {
  const w = entry.where
  const own = useOwnServer(w.kind === 'channel' ? w.server : null)
  if (w.kind === 'dm')
    return (
      <Row as="span" gap="2xs">
        <MessageSquare size={12} className="shrink-0" />
        <span className="truncate">Direct message</span>
      </Row>
    )
  if (w.kind === 'friends')
    return (
      <Row as="span" gap="2xs">
        <UserPlus size={12} className="shrink-0" />
        <span className="truncate">Friends</span>
      </Row>
    )
  if (w.kind === 'other') return <span className="truncate">{w.label}</span>
  return (
    <Row as="span" gap="2xs">
      <Hash size={12} className="shrink-0" />
      <Covered what="channel" look="truncate">
        <Masked text={w.channel} own={own} />
        {w.thread ? ' (thread)' : ''}
      </Covered>
      <span className="shrink-0">·</span>
      <Name of={serverCalled(w.serverName, own)} look="truncate" />
    </Row>
  )
}

// The words after the actor's name; a role name is blurred in streamer mode like other names.
export function InboxAction({ entry }: { entry: Pick<InboxEntry, 'kind' | 'emoji' | 'role'> }) {
  if (entry.kind === 'role' && entry.role)
    return (
      <span className="text-on-surface-variant">
        mentioned @
        <Covered what="role">
          <Masked text={entry.role} />
        </Covered>
      </span>
    )
  return <span className="text-on-surface-variant">{inboxAction(entry)}</span>
}

// The hosted server an entry's actor acted in; null for DMs, friends and P2P entries.
const entryServer = (entry: InboxEntry) =>
  entry.adapter === INSTANCE_INBOX && entry.where.kind === 'channel' ? entry.where.server : null

// Asks once per server for the member rows of the actors listed, so rows show server names.
function EntryLooks({ entries }: { entries: readonly InboxEntry[] }) {
  const ensureMembers = useStore(s => s.ensureMembers)
  const key = useMemo(() => {
    const by = new Map<string, Set<string>>()
    for (const e of entries) {
      const server = entryServer(e)
      if (server === null || isWebhookAuthor(e.actor.username)) continue
      by.set(server, (by.get(server) ?? new Set()).add(e.actor.username))
    }
    return [...by].map(([server, names]): [string, string[]] => [server, [...names].sort()])
  }, [entries])
  const wanted = useStable(key)
  useEffect(() => {
    for (const [server, names] of wanted) void ensureMembers(server, names)
  }, [wanted, ensureMembers])
  return null
}

function EntryRow({
  adapter,
  entry,
  onOpen,
  onRead,
}: {
  adapter: InboxAdapter | undefined
  entry: InboxEntry
  onOpen: (e: InboxEntry) => void
  onRead: (e: InboxEntry) => void
}) {
  const acct = useAccount()

  const streamer = useStore(s => s.streamer)
  acct.viewing.useViewing(s => s.revision)
  useStore(s => s.servers)
  const actor = useShown(entry.actor, entryServer(entry))
  if (!adapter) return null
  if (adapter.canPreview?.(entry) === false) {
    const target = adapter.previewTarget?.(entry)
    return (
      <Row as="li" gap="2xs" wrap place="min-w-0">
        <ListRow
          onClick={() => onOpen(entry)}
          label={
            <>
              Open channel · <Place entry={entry} />
            </>
          }
          place="flex-1"
        />
        {target && <RevealChannelPreview target={target} />}
      </Row>
    )
  }
  const snippet = inboxPreview(entry, streamer)
  const menu = longPress((x, y) =>
    openActionMenu(
      x,
      y,
      {
        kind: 'inbox',
        entry,
        open: () => onOpen(entry),
        read: () => onRead(entry),
      },
      {},
      acct
    )
  )
  return (
    <li className="group relative">
      <PreviewRow
        {...menu}
        data-inbox-item={entry.key}
        data-unread={entry.unread ? 'true' : undefined}
        onOpen={() => onOpen(entry)}
        className="w-full rounded-xl text-left hover:bg-surface-container-high"
        contentClassName="flex"
      >
        <Inset row pad="md" inset="bar" gap="md" align="stretch">
          <span className="relative shrink-0">
            <UserAvatar person={actor} size={32} />
            {entry.unread && (
              <span
                aria-hidden
                className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full border-2 border-surface-container-low bg-danger"
              />
            )}
          </span>
          <Stack as="span" gap="3xs" place="min-w-0 flex-1">
            <Row as="span" gap="xs" align="baseline">
              <span className="min-w-0 truncate text-sm">
                <Name
                  of={personName(actor)}
                  withUsername
                  look={entry.unread ? 'font-semibold' : 'font-medium'}
                />{' '}
                {isWebhookAuthor(entry.actor.username) && (
                  <>
                    <WebhookBadge />{' '}
                  </>
                )}
                <InboxAction entry={entry} />
              </span>
              <MessageTime
                ts={entry.created_at}
                className="ml-auto shrink-0 text-xs text-on-surface-variant"
              />
            </Row>
            <span className="flex min-w-0 text-xs text-on-surface-variant">
              <Place entry={entry} />
            </span>
            {snippet && (
              <span className="line-clamp-2 text-sm break-words text-on-surface">
                {snippet.kind === 'text' ? (
                  <SpoilerLine parts={snippet.parts} />
                ) : (
                  <PreviewFilename name={snippet.name} spoiler={snippet.spoiler} />
                )}
              </span>
            )}
            {entry.unread && <span className="sr-only">Unread</span>}
          </Stack>
        </Inset>
      </PreviewRow>
      {entry.unread && (
        <IconButton
          icon={Check}
          label="Mark as read"
          size="sm"
          onClick={() => onRead(entry)}
          place="absolute top-2 right-2 md:opacity-0 md:group-hover:opacity-100 md:focus-visible:opacity-100 pointer-coarse:opacity-100"
        />
      )}
    </li>
  )
}

// The inbox: Unread and All tabs, kind and place filters, newest first. Self-contained, so a
// page can embed it; `onClose` adds a close button and is called after jumping to an item
// (`jumped`).
export function InboxPanel({ onClose }: { onClose?: (jumped: boolean) => void }) {
  const [view, setView] = useState<InboxView>(DEFAULT_VIEW)
  const inbox = useInbox(view)
  const list = useLoad(inbox.list)
  const anyUnread = useLive(inbox.anyUnread)
  const ids = useId()
  const tabId = (unread: boolean) => `${ids}-${unread ? 'unread' : 'all'}`
  const panelId = `${ids}-list`
  const servers = useStore(s => s.me?.servers)
  const streamer = useStore(s => s.streamer)
  const say = useNameLabels()

  const set = (patch: Partial<InboxView>) => setView(v => ({ ...v, ...patch }))

  return (
    <Stack gap="none" place="h-full min-h-0 w-full">
      <Surface
        as="header"
        tone="plain"
        radius="none"
        border="bottom"
        pad="lg"
        inset="bar"
        place="shrink-0"
      >
        <Row gap="sm">
          <Bell size={18} className="text-on-surface-variant" />
          <span className="font-medium">Inbox</span>
          <ViewActorTag header />
          <IconButton
            icon={CheckCheck}
            label="Mark all as read"
            disabled={!anyUnread}
            onClick={inbox.readAll}
            place="ml-auto"
          />
          <ScheduledButton />
          {onClose && <IconButton icon={X} label="Close inbox" onClick={() => onClose(false)} />}
        </Row>
      </Surface>
      <Surface
        tone="plain"
        radius="none"
        border="bottom"
        pad="md"
        inset="bar"
        gap="sm"
        place="shrink-0"
      >
        <Row
          gap="2xs"
          role="tablist"
          aria-label="Inbox"
          onKeyDown={e => {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
            e.preventDefault()
            const unread = !view.unread
            set({ unread })
            document.getElementById(tabId(unread))?.focus()
          }}
        >
          {(
            [
              [true, 'Unread'],
              [false, 'All'],
            ] as const
          ).map(([unread, label]) => (
            <Tab
              key={label}
              id={tabId(unread)}
              selected={view.unread === unread}
              aria-controls={panelId}
              tabIndex={view.unread === unread ? 0 : -1}
              data-inbox-tab={view.unread === unread ? 'active' : undefined}
              onClick={() => set({ unread })}
            >
              {label}
            </Tab>
          ))}
        </Row>
        <Row
          role="group"
          aria-label="Filter by kind"
          gap="xs"
          align="stretch"
          place="overflow-x-auto"
        >
          {KIND_FILTERS.map(f => (
            <Chip
              key={f.label}
              on={view.kind === f.value}
              onClick={() => set({ kind: f.value })}
              place="shrink-0"
            >
              {f.label}
            </Chip>
          ))}
        </Row>
        {!streamer && (
          <select
            aria-label="Filter by place"
            value={view.place ?? ''}
            onChange={e => set({ place: e.target.value || null })}
            className={`${smallFieldCls} self-start text-on-surface-variant`}
          >
            <option value="">Everywhere</option>
            <option value={DM_PLACE}>Direct messages</option>
            {(servers ?? []).map(s => (
              <option key={s.name} value={s.name}>
                {say(serverName(s))}
              </option>
            ))}
          </select>
        )}
      </Surface>
      <Surface
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(view.unread)}
        tone="plain"
        radius="none"
        pad="xs"
        place="min-h-0 flex-1 overflow-y-auto"
      >
        <Loaded
          load={list}
          what="notifications"
          empty={
            <Surface tone="plain" radius="none" pad="2xl" gap="sm" align="center">
              <AtSign size={28} className="text-on-surface-variant" />
              <span className="text-center text-sm text-on-surface-variant">
                {view.unread ? "You're all caught up." : 'No notifications yet.'}
              </span>
            </Surface>
          }
        >
          {found => (
            <>
              <EntryLooks entries={found.entries} />
              <ul aria-label={view.unread ? 'Unread notifications' : 'All notifications'}>
                {found.entries.map(e => (
                  <EntryRow
                    key={e.key}
                    adapter={inbox.adapterOf(e.adapter)}
                    entry={e}
                    onOpen={entry => inbox.open(entry, onClose)}
                    onRead={inbox.read}
                  />
                ))}
              </ul>
              {found.failure !== null ? (
                <FailureNotice
                  error={found.failure}
                  lead="Could not load all notifications."
                  retry={inbox.reload}
                />
              ) : found.loadingMore ? (
                found.more && (
                  <Surface tone="plain" radius="none" pad="md" inset="bar">
                    <p className="text-center text-xs text-on-surface-variant">Loading</p>
                  </Surface>
                )
              ) : (
                found.more && <Sentinel key={found.entries.length} onVisible={inbox.loadMore} />
              )}
            </>
          )}
        </Loaded>
      </Surface>
    </Stack>
  )
}

// The newest unread notifications, for Home. Opens the full inbox for the rest.
export function InboxPreview({ max = 5, beforeOpen }: { max?: number; beforeOpen?: () => void }) {
  const inbox = useInbox(DEFAULT_VIEW)
  const list = useLoad(inbox.list)
  const setOpen = useStore(s => s.setInboxOpen)

  return (
    <Stack gap="none">
      <Loaded
        load={list}
        what="notifications"
        skeleton={<RowsSkeleton rows={2} label="Loading notifications" />}
        empty={
          <Surface tone="plain" radius="none" pad="md">
            <Row as="p" gap="sm">
              <AtSign size={16} className="shrink-0 text-on-surface-variant" />
              <span className="text-sm text-on-surface-variant">You&apos;re all caught up.</span>
            </Row>
          </Surface>
        }
      >
        {found => (
          <>
            <EntryLooks entries={found.entries} />
            <ul aria-label="Unread notifications">
              {found.entries.slice(0, max).map(e => (
                <EntryRow
                  key={e.key}
                  adapter={inbox.adapterOf(e.adapter)}
                  entry={e}
                  onOpen={entry => {
                    beforeOpen?.()
                    inbox.open(entry)
                  }}
                  onRead={inbox.read}
                />
              ))}
            </ul>
            {found.failure !== null && (
              <FailureNotice
                error={found.failure}
                lead="Could not load all notifications."
                retry={inbox.reload}
              />
            )}
          </>
        )}
      </Loaded>
      <Button
        onClick={() => {
          beforeOpen?.()
          setOpen(true)
        }}
        place="self-start"
      >
        Open inbox
      </Button>
    </Stack>
  )
}

// The bell: opens the inbox. Its badge is the same count as the tab title.
export function InboxButton() {
  const count = useInboxCount()
  const open = useStore(s => s.inboxOpen)
  const setOpen = useStore(s => s.setInboxOpen)
  const label = count ? labelWith`Inbox, ${pingLabel(count)}` : 'Inbox'
  return (
    <IconButton
      icon={Bell}
      label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-inbox-button
      onClick={() => setOpen(!open)}
    >
      <PingBadge count={count} className="absolute -top-1 -right-1.5 border-2 border-surface" />
    </IconButton>
  )
}

const SHEET = '(max-width: 767px)'

const FOCUSABLE = 'button:not([disabled]), select, [href], [tabindex]:not([tabindex="-1"])'

const focusBell = () => {
  const bells = Array.from(document.querySelectorAll<HTMLElement>('[data-inbox-button]'))
  bells.find(b => b.offsetParent !== null)?.focus()
}

// The inbox as a popover under the top bar on desktop and a bottom sheet on mobile. Focus moves
// to the active tab on open and back to the bell when it is closed (not after a jump). The sheet
// is modal and keeps Tab inside; the popover closes on a press outside without swallowing it.
export function InboxHost() {
  const open = useStore(s => s.inboxOpen)
  const setOpen = useStore(s => s.setInboxOpen)
  const store = useStoreApi()
  const sheet = useMedia(SHEET)
  const ref = useRef<HTMLDivElement>(null)
  const close = useCallback(
    (jumped = false) => {
      setOpen(false)
      if (!jumped) focusBell()
    },
    [setOpen]
  )
  useEscape(() => {
    if (store.getState().inboxOpen) close()
  }, 'dialog')

  useEffect(() => {
    if (!open) return
    ref.current?.querySelector<HTMLElement>('[data-inbox-tab="active"]')?.focus()
  }, [open])

  useEffect(() => {
    if (!open || sheet) return
    const onDown = (e: PointerEvent) => {
      const t = e.target
      if (!(t instanceof Element)) return
      const s = store.getState()
      if (s.confirm || s.contextMenu || s.profile) return
      if (ref.current?.contains(t) || t.closest('[data-inbox-button], [aria-modal="true"]')) return
      setOpen(false)
    }
    document.addEventListener('pointerdown', onDown, true)
    return () => document.removeEventListener('pointerdown', onDown, true)
  }, [open, sheet, setOpen, store])

  if (!open) return null

  const trap = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!sheet || e.key !== 'Tab' || !ref.current) return
    const all = Array.from(ref.current.querySelectorAll<HTMLElement>(FOCUSABLE))
    const first = all[0]
    const last = all[all.length - 1]
    if (!first || !last) return
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }

  return (
    <Sheet
      sheet={sheet}
      float={{ place: 'header-end', backdrop: 'none' }}
      height="tall"
      surface="low"
      aria-label="Inbox"
      onClose={() => close()}
      ref={ref}
      onKeyDown={trap}
    >
      <InboxPanel onClose={close} />
    </Sheet>
  )
}
