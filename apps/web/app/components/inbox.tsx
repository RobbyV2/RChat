'use client'

import { ViewActorTag } from './view_actor'
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from 'react'
import { AtSign, Bell, Check, CheckCheck, Hash, MessageSquare, UserPlus, X } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { useMask, useStore } from '../lib/store'
import { PreviewFilename, PreviewRow, RevealChannelPreview } from './preview_reveal'
import { SpoilerLine } from './replies'
import { totalInboxCount } from '../lib/client/account_counts'
import { allPings } from '../lib/selectors'
import {
  DEFAULT_VIEW,
  DM_PLACE,
  KIND_FILTERS,
  OWN_MARK_MS,
  allRead,
  freshSource,
  hasMore,
  inboxAction,
  inboxPreview,
  markedRead,
  mergeEntries,
  refreshHead,
  refreshOnCount,
  sourcesToLoad,
  type InboxAdapter,
  type InboxEntry,
  type InboxView,
  type SourceState,
} from '../lib/inbox'
import { useAccount, useStoreApi, useLiveSessions } from '../lib/client/react'
import { PingBadge, pingLabel } from './ping_badge'
import { UserAvatar } from './user_avatar'
import { WebhookBadge } from './webhooks'
import { isWebhookAuthor } from '../lib/webhooks'
import { MessageTime } from './timestamp'
import { Button, Chip, IconButton, ListRow, Tab } from './controls'
import { Row, Stack, Surface } from './layout'
import { Masked, Sentinel, Sheet, useEscape, useOwnServer } from './ui'
import { RowsSkeleton } from './skeletons'
import { NameWithUsername } from './display_name'
import { useShown } from './shown_user'
import { INSTANCE_INBOX } from '../lib/inbox_source'
import { longPress, useMedia } from './context_menu'
import { useStable } from '../lib/stable_key'

const freshSources = (adapters: InboxAdapter[]): Record<string, SourceState> =>
  Object.fromEntries(adapters.map(a => [a.id, freshSource()]))

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
function useInbox(view: InboxView) {
  const { inbox } = useAccount()
  const adapters = useSyncExternalStore(
    inbox.subscribeAdapters,
    inbox.inboxAdapters,
    inbox.inboxAdapters
  )
  const [request, setRequest] = useState({ adapters, view })
  const active = useRef<typeof request | null>(null)
  const generation = useRef(0)
  const markedUntil = useRef(0)
  const [sources, setSources] = useState(() => freshSources(adapters))
  if (request.adapters !== adapters || request.view !== view) {
    setRequest({ adapters, view })
    setSources(freshSources(adapters))
  }
  // Invalidate old handlers as soon as a different provider, registry or view commits.
  useLayoutEffect(() => {
    active.current = request
    markedUntil.current = 0
    return () => {
      active.current = null
    }
  }, [request])
  const isCurrent = useCallback(
    () => active.current === request && inbox.inboxAdapters() === adapters,
    [request, inbox, adapters]
  )
  const live = useRef(sources)
  live.current = sources

  const fetchPage = useCallback(
    (id: string, cursor: string | null, at: number) => {
      const adapter = adapters.find(a => a.id === id)
      if (!adapter) return
      setSources(s => ({ ...s, [id]: { ...(s[id] ?? freshSource()), loading: true } }))
      adapter.load(view, cursor).then(
        page => {
          if (!isCurrent() || generation.current !== at) return
          setSources(s => {
            const prev = s[id] ?? freshSource()
            if (cursor === null) return { ...s, [id]: refreshHead(prev, page) }
            const seen = new Set(prev.entries.map(e => e.key))
            return {
              ...s,
              [id]: {
                entries: [...prev.entries, ...page.entries.filter(e => !seen.has(e.key))],
                next: page.next,
                done: page.next === null,
                loading: false,
                failed: false,
              },
            }
          })
        },
        () => {
          if (!isCurrent() || generation.current !== at) return
          setSources(s => ({
            ...s,
            [id]: { ...(s[id] ?? freshSource()), loading: false, failed: true },
          }))
        }
      )
    },
    [adapters, view, isCurrent]
  )

  const reload = useCallback(() => {
    if (!isCurrent()) return
    generation.current += 1
    for (const a of adapters) fetchPage(a.id, null, generation.current)
  }, [isCurrent, adapters, fetchPage])

  useEffect(reload, [reload])

  const markedHere = () => {
    markedUntil.current = Date.now() + OWN_MARK_MS
  }
  const count = useInboxCount()
  const lastCount = useRef({ request, count })
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    const before = lastCount.current
    lastCount.current = { request, count }
    if (
      before.request !== request ||
      !refreshOnCount(before.count, count, markedUntil.current, Date.now())
    )
      return
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      timer.current = null
      reload()
    }, 400)
  }, [count, reload, request])
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )

  const loadMore = useCallback(() => {
    if (!isCurrent()) return
    for (const id of sourcesToLoad(live.current)) {
      const cur = live.current[id]
      if (cur?.next) fetchPage(id, cur.next, generation.current)
    }
  }, [fetchPage, isCurrent])

  const entries = useMemo(() => mergeEntries(sources), [sources])
  useEntryLooks(entries)
  const more = hasMore(sources)
  const loading = Object.values(sources).some(s => s.loading)
  const failed = Object.values(sources).some(s => s.failed)

  const adapterOf = (id: string) => adapters.find(a => a.id === id)
  const open = (entry: InboxEntry, onClose?: (jumped: boolean) => void) => {
    const adapter = adapterOf(entry.adapter)
    if (!adapter || !isCurrent()) return
    if (entry.unread && adapter.canPreview?.(entry) !== false) {
      markedHere()
      void adapter.markRead(entry).catch(() => {})
    }
    onClose?.(true)
    void adapter.open(entry)
  }

  const read = (entry: InboxEntry) => {
    const adapter = adapterOf(entry.adapter)
    if (!adapter || !isCurrent()) return
    markedHere()
    setSources(s => markedRead(s, entry.key, view.unread))
    void adapter.markRead(entry).then(
      () => {},
      () => reload()
    )
  }

  const readAll = () => {
    if (!isCurrent()) return
    const shown = entries
    markedHere()
    setSources(s => allRead(s, view.unread))
    void Promise.allSettled(
      adapters.map(a =>
        a.markAll(
          view,
          shown.filter(e => e.adapter === a.id)
        )
      )
    ).then(reload)
  }

  return { adapterOf, open, read, readAll, entries, more, loading, failed, loadMore, reload }
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
      <span className="streamer truncate">
        <Masked text={w.channel} own={own} />
        {w.thread ? ' (thread)' : ''}
      </span>
      <span className="shrink-0">·</span>
      <span className="streamer truncate">
        <Masked text={w.serverName} own={own} />
      </span>
    </Row>
  )
}

// The words after the actor's name; a role name is blurred in streamer mode like other names.
export function InboxAction({ entry }: { entry: Pick<InboxEntry, 'kind' | 'emoji' | 'role'> }) {
  if (entry.kind === 'role' && entry.role)
    return (
      <span className="text-on-surface-variant">
        mentioned @
        <span className="streamer">
          <Masked text={entry.role} />
        </span>
      </span>
    )
  return <span className="text-on-surface-variant">{inboxAction(entry)}</span>
}

// The hosted server an entry's actor acted in; null for DMs, friends and P2P entries.
const entryServer = (entry: InboxEntry) =>
  entry.adapter === INSTANCE_INBOX && entry.where.kind === 'channel' ? entry.where.server : null

// Asks once per server for the member rows of the actors listed, so rows show server names.
function useEntryLooks(entries: readonly InboxEntry[]) {
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
        className="w-full rounded-xl px-3 py-2.5 text-left hover:bg-surface-container-high"
        contentClassName="flex gap-3"
      >
        <span className="relative mt-0.5 shrink-0">
          <UserAvatar
            username={actor.username}
            avatarKind={actor.avatar_kind}
            avatarColor={actor.avatar_color}
            size={32}
          />
          {entry.unread && (
            <span
              aria-hidden
              className="absolute -top-0.5 -left-0.5 size-2.5 rounded-full border-2 border-surface-container-low bg-danger"
            />
          )}
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5 pr-8">
          <Row as="span" gap="xs" align="baseline">
            <span className="min-w-0 truncate text-sm">
              <span className={`streamer ${entry.unread ? 'font-semibold' : 'font-medium'}`}>
                <NameWithUsername user={actor} />
              </span>{' '}
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
        </span>
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
  const { adapterOf, open, read, readAll, entries, more, loading, failed, loadMore, reload } =
    useInbox(view)
  const ids = useId()
  const tabId = (unread: boolean) => `${ids}-${unread ? 'unread' : 'all'}`
  const panelId = `${ids}-list`
  const servers = useStore(s => s.me?.servers)
  const streamer = useStore(s => s.streamer)
  const mask = useMask()
  const anyUnread = entries.some(e => e.unread)

  const set = (patch: Partial<InboxView>) => setView(v => ({ ...v, ...patch }))
  const empty = !loading && !failed && entries.length === 0 && !more

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
            onClick={readAll}
            place="ml-auto"
          />
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
        <div
          role="group"
          aria-label="Filter by kind"
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
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
        </div>
        {!streamer && (
          <select
            aria-label="Filter by place"
            value={view.place ?? ''}
            onChange={e => set({ place: e.target.value || null })}
            className="self-start rounded-full border border-outline bg-transparent px-2 py-1 text-base text-on-surface-variant outline-none focus:border-primary md:text-xs"
          >
            <option value="">Everywhere</option>
            <option value={DM_PLACE}>Direct messages</option>
            {(servers ?? []).map(s => (
              <option key={s.name} value={s.name}>
                {mask(s.display_name)}
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
        {empty && (
          <Surface tone="plain" radius="none" pad="2xl" gap="sm" align="center">
            <AtSign size={28} className="text-on-surface-variant" />
            <span className="text-center text-sm text-on-surface-variant">
              {view.unread ? "You're all caught up." : 'No notifications yet.'}
            </span>
          </Surface>
        )}
        {failed && (
          <Surface tone="plain" radius="none" pad="xl" gap="sm" align="center">
            <span className="text-center text-sm text-on-surface-variant">
              Couldn&apos;t load notifications.
            </span>
            <Button onClick={reload}>Try again</Button>
          </Surface>
        )}
        <ul aria-label={view.unread ? 'Unread notifications' : 'All notifications'}>
          {entries.map(e => (
            <EntryRow
              key={e.key}
              adapter={adapterOf(e.adapter)}
              entry={e}
              onOpen={entry => open(entry, onClose)}
              onRead={read}
            />
          ))}
        </ul>
        {more && !failed && !loading && <Sentinel key={entries.length} onVisible={loadMore} />}
        {loading && (entries.length === 0 || more) && (
          <Surface tone="plain" radius="none" pad="md" inset="bar">
            <p className="text-center text-xs text-on-surface-variant">Loading</p>
          </Surface>
        )}
      </Surface>
    </Stack>
  )
}

// The newest unread notifications, for Home. Opens the full inbox for the rest.
export function InboxPreview({ max = 5, beforeOpen }: { max?: number; beforeOpen?: () => void }) {
  const { adapterOf, open, read, entries, more, loading, failed, reload } = useInbox(DEFAULT_VIEW)
  const setOpen = useStore(s => s.setInboxOpen)
  const shown = entries.slice(0, max)

  return (
    <Stack gap="none">
      {failed ? (
        <Surface tone="plain" radius="none" pad="md">
          <Row gap="sm">
            <span className="text-sm text-on-surface-variant">
              Couldn&apos;t load notifications.
            </span>
            <Button onClick={reload}>Try again</Button>
          </Row>
        </Surface>
      ) : (loading || more) && shown.length === 0 ? (
        <RowsSkeleton rows={2} label="Loading notifications" />
      ) : shown.length === 0 ? (
        <Surface tone="plain" radius="none" pad="md">
          <Row as="p" gap="sm">
            <AtSign size={16} className="shrink-0 text-on-surface-variant" />
            <span className="text-sm text-on-surface-variant">You&apos;re all caught up.</span>
          </Row>
        </Surface>
      ) : (
        <ul aria-label="Unread notifications">
          {shown.map(e => (
            <EntryRow
              key={e.key}
              adapter={adapterOf(e.adapter)}
              entry={e}
              onOpen={e => {
                beforeOpen?.()
                open(e)
              }}
              onRead={read}
            />
          ))}
        </ul>
      )}
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
  const label = count ? `Inbox, ${pingLabel(count)}` : 'Inbox'
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
      float={{
        at: 'top-[3.25rem] right-3 h-[min(40rem,calc(100%-4.5rem))] w-[26rem]',
        backdrop: 'none',
      }}
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
