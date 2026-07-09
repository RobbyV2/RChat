'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { FileText, Hash, Search, X } from 'lucide-react'
import { useStore, type SearchArgs } from '../lib/store'
import { UserAvatar } from './user_avatar'
import { Sentinel, fieldCls } from './server_settings'
import { fmtTime } from './message_pane'

const chipCls = (on: boolean) =>
  `rounded-full border px-3 py-1 text-xs font-medium ${
    on
      ? 'border-primary bg-primary-container text-on-primary-container'
      : 'border-outline text-on-surface-variant hover:bg-surface-container-high'
  }`

export default function SearchPanel() {
  const channels = useStore(s =>
    s.view?.kind === 'channel' ? s.servers[s.view.server]?.channels : undefined
  )
  const search = useStore(s => s.search)
  const searchRun = useStore(s => s.searchRun)
  const closePanel = useStore(s => s.closePanel)
  const openServer = useStore(s => s.openServer)
  const [q, setQ] = useState('')
  const [from, setFrom] = useState('')
  const [channelId, setChannelId] = useState('')
  const [hasFile, setHasFile] = useState(false)
  const [before, setBefore] = useState('')
  const [after, setAfter] = useState('')

  const args: SearchArgs = {
    q: q.trim(),
    from: from.trim().toLowerCase(),
    channelId: channelId ? Number(channelId) : null,
    hasFile,
    beforeTs: before ? Date.parse(before) / 1000 : null,
    afterTs: after ? Date.parse(after) / 1000 + 86400 : null,
  }
  const active =
    args.q !== '' ||
    args.from !== '' ||
    args.channelId !== null ||
    hasFile ||
    args.beforeTs !== null ||
    args.afterTs !== null
  const argsRef = useRef(args)
  argsRef.current = args

  useEffect(() => {
    if (!active) return
    const t = setTimeout(() => void searchRun(argsRef.current, true), 300)
    return () => clearTimeout(t)
  }, [q, from, channelId, hasFile, before, after, active, searchRun])

  const more = useCallback(() => void searchRun(argsRef.current, false), [searchRun])

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
        className="rounded-lg border border-outline bg-transparent px-2 py-1 text-xs outline-none focus:border-primary"
      />
    </label>
  )

  return (
    <div className="flex h-full w-full flex-col bg-surface-container-low">
      <header className="flex h-14 shrink-0 items-center gap-2 border-b border-outline-variant px-4">
        <Search size={18} className="text-on-surface-variant" />
        <span className="font-medium">Search</span>
        <button
          title="Close search"
          onClick={closePanel}
          className="ml-auto rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-high"
        >
          <X size={18} />
        </button>
      </header>
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
            className="w-28 rounded-full border border-outline bg-transparent px-3 py-1 text-xs outline-none placeholder:text-on-surface-variant focus:border-primary"
          />
          {channels && (
            <select
              value={channelId}
              onChange={e => setChannelId(e.target.value)}
              className="rounded-full border border-outline bg-transparent px-2 py-1 text-xs text-on-surface-variant outline-none focus:border-primary"
            >
              <option value="">in: any channel</option>
              {channels.map(c => (
                <option key={c.id} value={c.id}>
                  in: #{c.name}
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
      </div>
      <div className="flex-1 overflow-y-auto p-2">
        {!active && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">
            Type a query or pick a filter to search.
          </p>
        )}
        {active && !search.loading && search.results.length === 0 && !search.hasMore && (
          <p className="px-3 py-6 text-center text-sm text-on-surface-variant">No results.</p>
        )}
        {search.results.map(r => (
          <button
            key={r.message.id}
            onClick={() => {
              const { channel_id } = r.message
              if (channel_id !== null) void openServer(r.server, channel_id)
              closePanel()
            }}
            className="block w-full rounded-xl px-3 py-2 text-left hover:bg-surface-container-high"
          >
            <p className="flex items-center gap-1 text-xs text-on-surface-variant">
              <Hash size={12} />
              {r.channel_name} · {r.server}
            </p>
            <div className="mt-1 flex items-center gap-2">
              <UserAvatar
                username={r.message.author.username}
                avatarKind={r.message.author.avatar_kind}
                avatarColor={r.message.author.avatar_color}
                size={20}
              />
              <span className="truncate text-sm font-medium">{r.message.author.display_name}</span>
              <span className="shrink-0 text-xs text-on-surface-variant">
                {fmtTime(r.message.created_at)}
              </span>
            </div>
            <p className="mt-0.5 line-clamp-2 text-sm break-words text-on-surface">
              {r.message.content || r.message.media?.filename}
            </p>
            {r.message.media && (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-on-surface-variant">
                <FileText size={12} />
                {r.message.media.filename}
              </p>
            )}
          </button>
        ))}
        {active && search.hasMore && <Sentinel key={search.results.length} onVisible={more} />}
        {search.loading && (
          <p className="px-3 py-2 text-center text-xs text-on-surface-variant">Searching</p>
        )}
      </div>
    </div>
  )
}
