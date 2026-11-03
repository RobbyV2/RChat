'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { FileText, Hash, Search } from 'lucide-react'
import { useMask, useStore } from '../lib/store'
import { dayEndTs, dayStartTs, type SearchArgs } from '../lib/search'
import { UserAvatar } from './user_avatar'
import { fieldCls, Masked, PanelHeader, Sentinel, useEscape } from './ui'
import { avatarTriggerCls, nameTriggerCls } from './message_pane'
import { MessageTime } from './timestamp'
import { plainStamps } from '../lib/timestamps'
import { profileTrigger } from './profile_card'
import { ForwardedTag, SpoilerLine } from './replies'
import { spoilerParts } from '../lib/spoilers'
import type { MessageMedia, SearchResult } from '../lib/types'

const mediaLabel = (m: MessageMedia | null) =>
  m === null ? '' : m.spoiler ? 'Spoiler' : m.filename

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
  channel: string
  server: string
  avatar: ReactNode
  name: ReactNode
  createdAt: number
  content: string
  forwarded: boolean
  // The attachment's label, or null without one.
  file: string | null
  onOpen: () => void
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
  useEscape(onClose, 'panel')

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => runRef.current(argsRef.current, true), 300)
    return () => clearTimeout(t)
  }, [q, from, channelId, hasFile, before, after, active])

  const more = useCallback(() => runRef.current(argsRef.current, false), [])

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
      <div className="flex-1 overflow-y-auto p-2">
        {!active && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">
            Type a query or pick a filter to search.
          </p>
        )}
        {active && !loading && hits.length === 0 && !hasMore && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">No results.</p>
        )}
        {hits.map(r => (
          <button
            key={r.key}
            onClick={r.onOpen}
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
            <p className="mt-0.5 line-clamp-2 text-sm break-words text-on-surface">
              {r.content ? <SpoilerLine parts={spoilerParts(plainStamps(r.content))} /> : r.file}
            </p>
            {r.file !== null && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-on-surface-variant">
                <FileText size={12} />
                {r.file}
              </p>
            )}
          </button>
        ))}
        {active && hasMore && <Sentinel key={pageKey} onVisible={more} />}
        {loading && (
          <p className="px-3 py-2 text-center text-xs text-on-surface-variant">Searching</p>
        )}
      </div>
    </div>
  )
}

const instanceHit = (r: SearchResult, open: (r: SearchResult) => void): SearchHitView => ({
  key: String(r.message.id),
  channel: r.channel_name,
  server: r.server,
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
      <Masked text={r.message.author.display_name} />
    </span>
  ),
  createdAt: r.message.created_at,
  content: r.message.content,
  forwarded: !!r.message.forward,
  file: r.message.media ? mediaLabel(r.message.media) : null,
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
  const hits = useMemo(
    () => search.results.map(r => instanceHit(r, x => void openResult(x))),
    [search.results, openResult]
  )
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
      onRun={run}
      onClose={closePanel}
    />
  )
}
