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
import {
  Masked,
  Sentinel,
  SheetGrip,
  SkeletonRows,
  textBtn as textBtnCls,
  useEscape,
  useOwnServer,
} from './ui'
import { NameWithUsername } from './display_name'
import { useShown } from './shown_user'
import { INSTANCE_INBOX } from '../lib/inbox_source'
import { longPress, useMedia } from './context_menu'

const chipCls = (on: boolean) =>
  `shrink-0 rounded-full border px-3 py-1 text-xs font-medium ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface-variant hover:bg-surface-container-high'
  }`

const tabCls = (on: boolean) =>
  `rounded-full px-3 py-1.5 text-sm font-medium ${
    on
      ? 'bg-secondary-container text-on-secondary-container'
      : 'text-on-surface-variant hover:bg-surface-container-high'
  }`

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
      <span className="flex min-w-0 items-center gap-1">
        <MessageSquare size={12} className="shrink-0" />
        <span className="truncate">Direct message</span>
      </span>
    )
  if (w.kind === 'friends')
    return (
      <span className="flex min-w-0 items-center gap-1">
        <UserPlus size={12} className="shrink-0" />
        <span className="truncate">Friends</span>
      </span>
    )
  if (w.kind === 'other') return <span className="truncate">{w.label}</span>
  return (
    <span className="flex min-w-0 items-center gap-1">
      <Hash size={12} className="shrink-0" />
      <span className="streamer truncate">
        <Masked text={w.channel} own={own} />
        {w.thread ? ' (thread)' : ''}
      </span>
      <span className="shrink-0">·</span>
      <span className="streamer truncate">
        <Masked text={w.serverName} own={own} />
      </span>
    </span>
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
    return JSON.stringify([...by].map(([server, names]) => [server, [...names].sort()]))
  }, [entries])
  useEffect(() => {
    for (const [server, names] of JSON.parse(key) as [string, string[]][])
      void ensureMembers(server, names)
  }, [key, ensureMembers])
}

function Row({
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
      <li className="flex min-w-0 flex-wrap items-center gap-x-1 rounded-xl hover:bg-surface-container-high">
        <button
          className="min-h-11 min-w-0 flex-1 cursor-pointer rounded-xl px-3 py-2 text-left"
          onClick={() => onOpen(entry)}
        >
          Open channel · <Place entry={entry} />
        </button>
        {target && <RevealChannelPreview target={target} />}
      </li>
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
          <span className="flex min-w-0 items-baseline gap-1.5 text-sm">
            <span className="min-w-0 truncate">
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
          </span>
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
        <button
          type="button"
          title="Mark as read"
          aria-label="Mark as read"
          onClick={() => onRead(entry)}
          className="absolute top-2 right-2 rounded-full p-1.5 text-on-surface-variant opacity-100 hover:bg-surface-container-highest hover:text-on-surface focus-visible:opacity-100 md:opacity-0 md:group-hover:opacity-100"
        >
          <Check size={16} />
        </button>
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
    <div className="flex h-full min-h-0 w-full flex-col">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
        <Bell size={18} className="text-on-surface-variant" />
        <span className="font-medium">Inbox</span>
        <ViewActorTag header />
        <button
          type="button"
          title="Mark all as read"
          aria-label="Mark all as read"
          disabled={!anyUnread}
          onClick={readAll}
          className="ml-auto rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high disabled:opacity-40 disabled:hover:bg-transparent"
        >
          <CheckCheck size={18} />
        </button>
        {onClose && (
          <button
            type="button"
            title="Close inbox"
            aria-label="Close inbox"
            onClick={() => onClose(false)}
            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
          >
            <X size={18} />
          </button>
        )}
      </header>
      <div className="flex shrink-0 flex-col gap-2 border-b border-outline-variant px-3 py-2">
        <div
          role="tablist"
          aria-label="Inbox"
          className="flex gap-1"
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
            <button
              key={label}
              id={tabId(unread)}
              type="button"
              role="tab"
              aria-selected={view.unread === unread}
              aria-controls={panelId}
              tabIndex={view.unread === unread ? 0 : -1}
              data-inbox-tab={view.unread === unread ? 'active' : undefined}
              onClick={() => set({ unread })}
              className={tabCls(view.unread === unread)}
            >
              {label}
            </button>
          ))}
        </div>
        <div
          role="group"
          aria-label="Filter by kind"
          className="-mx-1 flex gap-1.5 overflow-x-auto px-1 pb-0.5"
        >
          {KIND_FILTERS.map(f => (
            <button
              key={f.label}
              type="button"
              aria-pressed={view.kind === f.value}
              onClick={() => set({ kind: f.value })}
              className={chipCls(view.kind === f.value)}
            >
              {f.label}
            </button>
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
      </div>
      <div
        id={panelId}
        role="tabpanel"
        aria-labelledby={tabId(view.unread)}
        className="min-h-0 flex-1 overflow-y-auto p-1.5"
      >
        {empty && (
          <div className="flex flex-col items-center gap-2 px-6 py-10 text-center text-on-surface-variant">
            <AtSign size={28} />
            <span className="text-sm">
              {view.unread ? "You're all caught up." : 'No notifications yet.'}
            </span>
          </div>
        )}
        {failed && (
          <div className="flex flex-col items-center gap-2 px-6 py-6 text-center text-sm text-on-surface-variant">
            <span>Couldn&apos;t load notifications.</span>
            <button
              type="button"
              onClick={reload}
              className="rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest"
            >
              Try again
            </button>
          </div>
        )}
        <ul aria-label={view.unread ? 'Unread notifications' : 'All notifications'}>
          {entries.map(e => (
            <Row
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
          <p className="px-3 py-2 text-center text-xs text-on-surface-variant">Loading</p>
        )}
      </div>
    </div>
  )
}

// The newest unread notifications, for Home. Opens the full inbox for the rest.
export function InboxPreview({ max = 5, beforeOpen }: { max?: number; beforeOpen?: () => void }) {
  const { adapterOf, open, read, entries, more, loading, failed, reload } = useInbox(DEFAULT_VIEW)
  const setOpen = useStore(s => s.setInboxOpen)
  const shown = entries.slice(0, max)

  return (
    <div className="flex flex-col">
      {failed ? (
        <div className="flex items-center gap-2 px-2 py-3 text-sm text-on-surface-variant">
          <span>Couldn&apos;t load notifications.</span>
          <button type="button" onClick={reload} className={textBtnCls}>
            Try again
          </button>
        </div>
      ) : (loading || more) && shown.length === 0 ? (
        <SkeletonRows rows={2} label="Loading notifications" />
      ) : shown.length === 0 ? (
        <p className="flex items-center gap-2 px-2 py-3 text-sm text-on-surface-variant">
          <AtSign size={16} className="shrink-0" />
          You&apos;re all caught up.
        </p>
      ) : (
        <ul aria-label="Unread notifications">
          {shown.map(e => (
            <Row
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
      <button
        type="button"
        onClick={() => {
          beforeOpen?.()
          setOpen(true)
        }}
        className={`${textBtnCls} self-start`}
      >
        Open inbox
      </button>
    </div>
  )
}

// The bell: opens the inbox. Its badge is the same count as the tab title.
export function InboxButton({ className = '' }: { className?: string }) {
  const count = useInboxCount()
  const open = useStore(s => s.inboxOpen)
  const setOpen = useStore(s => s.setInboxOpen)
  const label = count ? `Inbox, ${pingLabel(count)}` : 'Inbox'
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-expanded={open}
      aria-haspopup="dialog"
      data-inbox-button
      onClick={() => setOpen(!open)}
      className={`relative rounded-full p-1.5 hover:bg-surface-container-high ${
        open ? 'bg-surface-container-high' : ''
      } ${className}`}
    >
      <Bell size={20} />
      <PingBadge count={count} className="absolute -top-1 -right-1.5 border-2 border-surface" />
    </button>
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
    <div className={sheet ? 'fixed inset-0 z-50' : ''}>
      {sheet && (
        <div data-inbox-scrim className="absolute inset-0 bg-scrim/50" onClick={() => close()} />
      )}
      <div
        ref={ref}
        role="dialog"
        aria-label="Inbox"
        aria-modal={sheet ? 'true' : undefined}
        onKeyDown={trap}
        className={
          sheet
            ? 'absolute inset-x-0 bottom-0 flex h-[85dvh] flex-col rounded-t-3xl bg-surface-container-low pt-2 pb-[env(safe-area-inset-bottom)] shadow-elevation-3'
            : 'fixed top-[calc(var(--safe-top)+3.25rem)] right-3 z-50 flex h-[min(40rem,calc(100dvh-var(--safe-top)-4.5rem))] w-[26rem] flex-col rounded-2xl border border-outline-variant bg-surface-container-low shadow-elevation-3'
        }
      >
        {sheet && <SheetGrip />}
        <InboxPanel onClose={close} />
      </div>
    </div>
  )
}
