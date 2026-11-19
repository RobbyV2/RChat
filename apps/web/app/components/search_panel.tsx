'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { canView, instanceTarget, useViewing } from '../lib/viewing'
import { FileText, Hash, Search } from 'lucide-react'
import { useMask, useStore } from '../lib/store'
import { dayEndTs, dayStartTs, endOfList, shortSearch, type SearchArgs } from '../lib/search'
import { UserAvatar } from './user_avatar'
import { fieldCls, Masked, PanelHeader, Sentinel, useEscape } from './ui'
import { NameWithUsername } from './display_name'
import { avatarTriggerCls, nameTriggerCls } from './message_pane'
import { MessageTime } from './timestamp'
import { plainStamps } from '../lib/timestamps'
import { profileTrigger } from './profile_card'
import { ForwardedTag, SpoilerLine } from './replies'
import { PreviewRow, PreviewFilename, RevealChannelPreview } from './preview_reveal'
import { spoilerParts } from '../lib/spoilers'
import { useForwardAccess } from '../lib/forward_access'
import type { ViewingTarget } from '../lib/viewing'
import type { Message, SearchResult } from '../lib/types'

const chipCls = (on: boolean) =>
  `rounded-full border px-3 py-1 text-xs font-medium ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface-variant hover:bg-surface-container-high'
  }`

// What the search panel lists, whichever source found it (the instance, or P2P servers stored
// here): where it is, who wrote it (`avatar` and `name` as the source shows people), and what.
export interface SearchHitView {
  key: string
  channel: ReactNode
  server: ReactNode
  avatar: ReactNode
  name: ReactNode
  createdAt: number
  content: string
  // Your own message: its text and file name are never masked for you.
  own: boolean
  forwarded: boolean
  // The attachment's label, or null without one.
  file: string | null
  fileSpoiler?: boolean
  // A forwarded instance copy, shown only when its source room is open here.
  copy?: { message: Pick<Message, 'forward' | 'channel_id'>; server: string }
  // A hit from a room closed here: the room to ask about before showing it.
  reveal?: ViewingTarget
  onOpen: () => void
}

function HitText({ r }: { r: SearchHitView }) {
  const copy = useForwardAccess(r.copy?.message, { server: r.copy?.server })
  if (r.reveal)
    return (
      <p className="mt-0.5 text-sm text-on-surface-variant">
        <RevealChannelPreview target={r.reveal} />
      </p>
    )
  if (copy.access !== 'open')
    return (
      <p className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1 text-sm text-on-surface-variant">
        <span className="italic">Forwarded message</span>
        {copy.target && <RevealChannelPreview target={copy.target} />}
      </p>
    )
  return (
    <>
      {r.content && (
        <p className="mt-0.5 line-clamp-2 text-sm break-words text-on-surface">
          <SpoilerLine parts={spoilerParts(plainStamps(r.content))} own={r.own && !r.forwarded} />
        </p>
      )}
      {r.file !== null && (
        <p className="mt-0.5 flex items-center gap-1 text-xs text-on-surface-variant">
          <FileText size={12} />
          <PreviewFilename name={r.file} spoiler={r.fileSpoiler} own={r.own && !r.forwarded} />
        </p>
      )}
    </>
  )
}

// The filters as typed; `channel` is a channel id ('' for any).
export interface SearchFilters {
  q: string
  from: string
  channel: string
  hasFile: boolean
  beforeTs: number | null
  afterTs: number | null
}

export function SearchView({
  channels,
  hits,
  loading,
  hasMore,
  pageKey,
  seed,
  note,
  scrollForMore,
  onRun,
  onClose,
}: {
  // The "in:" choices (the current server's channels), or none.
  channels: { id: string; name: string }[] | undefined
  hits: SearchHitView[]
  loading: boolean
  hasMore: boolean
  // Changes with every page, so the next one loads when the end shows again.
  pageKey: string
  // A query to start with; a new `n` puts its text in the field again.
  seed?: { q: string | null; n: number }
  // Shown under the filters (where the search looks).
  note?: ReactNode
  // Whether, for this text, the next page loads only when the member asks for it or scrolls to
  // the end of the list after the page arrived (one page a scroll), not as soon as the end
  // shows. Without it every page loads on sight.
  scrollForMore?: (q: string) => boolean
  // A first page (`fresh`) or the next one.
  onRun: (f: SearchFilters, fresh: boolean) => void
  onClose: () => void
}) {
  const mask = useMask()
  const [q, setQ] = useState(() => seed?.q ?? '')
  const [seedN, setSeedN] = useState(seed?.n ?? 0)
  if (seed && seed.n !== seedN) {
    setSeedN(seed.n)
    if (seed.q) setQ(seed.q)
  }
  const [from, setFrom] = useState('')
  const [channelId, setChannelId] = useState('')
  const [hasFile, setHasFile] = useState(false)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')

  const args: SearchFilters = {
    q: q.trim(),
    from: from.trim().toLowerCase(),
    channel: channelId,
    hasFile,
    beforeTs: dayStartTs(before),
    afterTs: dayEndTs(after),
  }
  const active =
    args.q !== '' ||
    args.from !== '' ||
    args.channel !== '' ||
    hasFile ||
    args.beforeTs !== null ||
    args.afterTs !== null
  const argsRef = useRef(args)
  argsRef.current = args
  const runRef = useRef(onRun)
  runRef.current = onRun
  const stepped = active && (scrollForMore?.(args.q) ?? false)
  const steppedRef = useRef(stepped)
  steppedRef.current = stepped
  const pageRef = useRef(pageKey)
  pageRef.current = pageKey
  const listRef = useRef<HTMLDivElement>(null)
  const [end] = useState(endOfList)
  useEscape(onClose, 'panel')

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => runRef.current(argsRef.current, true), 300)
    return () => clearTimeout(t)
  }, [args.q, args.from, channelId, hasFile, args.beforeTs, args.afterTs, active])

  const more = useCallback(() => runRef.current(argsRef.current, false), [])
  const endShown = useCallback(() => {
    if (end.sight(true, pageRef.current, steppedRef.current)) more()
  }, [end, more])
  const endHidden = useCallback(() => {
    end.sight(false, pageRef.current, steppedRef.current)
  }, [end])
  const scrolled = useCallback(() => {
    const top = listRef.current?.scrollTop ?? 0
    if (end.scroll(top, pageRef.current, steppedRef.current)) more()
  }, [end, more])

  const dateField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    max?: string
  ) => (
    <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
      {label}
      <input
        type="date"
        value={value}
        max={max}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-outline bg-transparent px-2 py-1 text-base outline-none focus:border-primary md:text-xs"
      />
    </label>
  )

  return (
    <div className="flex h-full w-full flex-col bg-surface-container-low">
      <PanelHeader icon={Search} title="Search" closeTitle="Close search" onClose={onClose} />
      <div className="flex shrink-0 flex-col gap-2 border-b border-outline-variant p-3">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search messages"
          autoFocus
          className={fieldCls}
        />
        <div className="flex flex-wrap items-center gap-2">
          <input
            value={from}
            onChange={e => setFrom(e.target.value)}
            placeholder="from: user"
            className="w-28 rounded-full border border-outline bg-transparent px-3 py-1 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-xs"
          />
          {channels && (
            <select
              value={channelId}
              onChange={e => setChannelId(e.target.value)}
              className="rounded-full border border-outline bg-transparent px-2 py-1 text-base text-on-surface-variant outline-none focus:border-primary md:text-xs"
            >
              <option value="">in: any channel</option>
              {channels.map(c => (
                <option key={c.id} value={c.id}>
                  in: #{mask(c.name)}
                </option>
              ))}
            </select>
          )}
          <button
            title="Only messages with a file"
            onClick={() => setHasFile(v => !v)}
            className={chipCls(hasFile)}
          >
            has:file
          </button>
          {dateField('before', before, setBefore)}
          {dateField('after', after, setAfter)}
        </div>
        {note && <p className="text-xs text-on-surface-variant">{note}</p>}
      </div>
      <div
        ref={listRef}
        onScroll={scrolled}
        className="flex-1 overflow-y-auto p-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] [overflow-anchor:none]"
      >
        {!active && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">
            Type a query or pick a filter to search.
          </p>
        )}
        {active && !loading && hits.length === 0 && !hasMore && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">No results.</p>
        )}
        {hits.map(r => (
          <PreviewRow
            key={r.key}
            onOpen={r.onOpen}
            className="block w-full rounded-xl px-3 py-2 text-left hover:bg-surface-container-high"
          >
            <p className="flex min-w-0 items-center gap-1 text-xs text-on-surface-variant">
              <Hash size={12} className="shrink-0" />
              <span className="truncate">{r.channel}</span>
              <span className="shrink-0">·</span>
              <span className="streamer truncate">{r.server}</span>
            </p>
            <div className="mt-1 flex min-w-0 items-center gap-2">
              {r.avatar}
              {r.name}
              <MessageTime ts={r.createdAt} className="shrink-0 text-xs text-on-surface-variant" />
              {r.forwarded && (
                <span className="text-xs">
                  <ForwardedTag />
                </span>
              )}
            </div>
            <HitText r={r} />
          </PreviewRow>
        ))}
        {active && hasMore && <Sentinel key={pageKey} onVisible={endShown} onHidden={endHidden} />}
        {stepped && (hasMore || loading) && (
          <div className="flex h-9 items-end justify-center">
            {loading ? (
              <p className="py-2 text-xs text-on-surface-variant">Searching</p>
            ) : (
              <button
                type="button"
                onClick={more}
                className="cursor-pointer rounded-full px-4 py-2 text-xs font-medium text-primary hover:bg-surface-container-high"
              >
                Search older messages
              </button>
            )}
          </div>
        )}
        {loading && !stepped && (
          <p className="px-3 py-2 text-center text-xs text-on-surface-variant">Searching</p>
        )}
      </div>
    </div>
  )
}

const instanceHit = (
  r: SearchResult,
  me: string | null,
  owns: (server: string) => boolean,
  open: (r: SearchResult) => void
): SearchHitView => ({
  key: String(r.message.id),
  channel: <Masked text={r.channel_name} own={owns(r.server)} />,
  server: <Masked text={r.server} own={owns(r.server)} />,
  avatar: (
    <span
      {...profileTrigger(r.message.author, r.server, false)}
      title="View profile"
      className={`shrink-0 ${avatarTriggerCls}`}
    >
      <UserAvatar
        username={r.message.author.username}
        avatarKind={r.message.author.avatar_kind}
        avatarColor={r.message.author.avatar_color}
        size={20}
      />
    </span>
  ),
  name: (
    <span
      {...profileTrigger(r.message.author, r.server)}
      className={`streamer truncate text-sm font-medium ${nameTriggerCls}`}
    >
      <NameWithUsername user={r.message.author} />
    </span>
  ),
  createdAt: r.message.created_at,
  content: r.message.content,
  own: !r.message.webhook && r.message.author.username === me,
  forwarded: !!r.message.forward,
  file: r.message.media?.filename ?? null,
  fileSpoiler: r.message.media?.spoiler,
  ...(r.message.forward ? { copy: { message: r.message, server: r.server } } : {}),
  onOpen: () => open(r),
})

export default function SearchPanel() {
  const channels = useStore(s =>
    s.view?.kind === 'channel' ? s.servers[s.view.server]?.channels : undefined
  )
  const search = useStore(s => s.search)
  const searchRun = useStore(s => s.searchRun)
  const closePanel = useStore(s => s.closePanel)
  const openResult = useStore(s => s.openResult)
  const choices = useMemo(
    () => channels?.map(c => ({ id: String(c.id), name: c.name })),
    [channels]
  )
  const me = useStore(s => s.me?.username ?? null)
  const mine = useStore(s => s.me?.servers)
  const servers = useStore(s => s.servers)
  const revision = useViewing(s => s.revision)
  useEffect(() => {
    for (const name of new Set(search.results.map(r => r.server))) {
      if (!servers[name])
        void useStore
          .getState()
          .discoverChannels(name)
          .catch(() => {})
    }
  }, [search.results, servers])
  const hits = useMemo<SearchHitView[]>(() => {
    const owns = (server: string) =>
      me !== null && mine?.find(x => x.name === server)?.creator === me
    return search.results.map(r => {
      const t = instanceTarget(useStore.getState(), r.server, r.message.channel_id ?? -1)
      if (t && canView(t)) return instanceHit(r, me, owns, x => void openResult(x))
      return {
        key: String(r.message.id),
        channel: <Masked text={r.channel_name} />,
        server: <Masked text={r.server} />,
        avatar: null,
        name: 'Open channel',
        createdAt: r.message.created_at,
        content: '',
        own: false,
        forwarded: false,
        file: null,
        ...(t ? { reveal: t } : {}),
        onOpen: (): void => {
          void openResult(r)
        },
      }
    })
  }, [search.results, me, mine, openResult, servers, revision])
  const run = useCallback(
    (f: SearchFilters, fresh: boolean) =>
      void searchRun(
        {
          q: f.q,
          from: f.from,
          channelId: f.channel ? Number(f.channel) : null,
          hasFile: f.hasFile,
          beforeTs: f.beforeTs,
          afterTs: f.afterTs,
        } satisfies SearchArgs,
        fresh
      ),
    [searchRun]
  )
  return (
    <SearchView
      channels={choices}
      hits={hits}
      loading={search.loading}
      hasMore={search.hasMore}
      pageKey={`${search.results.length}:${search.cursor ?? ''}`}
      seed={{ q: search.seed ?? null, n: search.seedN ?? 0 }}
      scrollForMore={shortSearch}
      onRun={run}
      onClose={closePanel}
    />
  )
}
