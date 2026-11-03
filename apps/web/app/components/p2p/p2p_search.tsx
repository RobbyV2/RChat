'use client'

import { useCallback, useMemo } from 'react'
import { useMask } from '../../lib/store'
import { memberName, p2pSearch, useP2p } from '../../lib/p2p/app'
import { SearchView, type SearchFilters, type SearchHitView } from '../search_panel'
import { Masked } from '../ui'
import { KeyAvatar } from './p2p_badge'

// Search over the P2P servers stored on this device, in the instance's search panel.

export function P2pSearchPanel() {
  const search = useP2p(s => s.search)
  const servers = useP2p(s => s.servers)
  const room = useP2p(s => s.server?.room ?? null)
  const channels = room ? servers[room]?.channels : undefined
  const mask = useMask()
  const hits = useMemo<SearchHitView[]>(
    () =>
      search.hits.map(h => {
        const v = servers[h.room]
        const name = memberName(h.room, h.m.sender)
        const att = h.m.fwd?.att ?? h.m.att
        return {
          key: h.m.id,
          channel: mask(v?.channels.find(c => c.id === h.ch)?.name ?? ''),
          server: mask(v?.name ?? 'P2P server'),
          avatar: (
            <span className="shrink-0">
              <KeyAvatar ik={h.m.sender} size={20} />
            </span>
          ),
          name: (
            <span className="streamer truncate text-sm font-medium">
              <Masked text={name} />
            </span>
          ),
          createdAt: Math.floor(h.m.ts / 1000),
          content: h.m.fwd ? h.m.fwd.body : h.m.body,
          forwarded: !!h.m.fwd,
          file: att.length ? (att[0].spoiler ? 'Spoiler' : att[0].name) : null,
          onOpen: () => void p2pSearch.openHit(h),
        }
      }),
    [search.hits, servers, mask]
  )
  const run = useCallback(
    (f: SearchFilters, fresh: boolean) =>
      void p2pSearch.run(
        {
          q: f.q,
          from: f.from,
          ch: f.channel || null,
          hasFile: f.hasFile,
          beforeTs: f.beforeTs,
          afterTs: f.afterTs,
        },
        fresh
      ),
    []
  )
  return (
    <div data-p2p-search className="contents">
      <SearchView
        channels={channels}
        hits={hits}
        loading={search.loading}
        hasMore={search.next !== null}
        pageKey={`${search.hits.length}:${search.next ?? ''}`}
        note={
          search.indexing
            ? 'Searches messages stored on this device. Still indexing, so some may be missing.'
            : 'Searches messages stored on this device'
        }
        onRun={run}
        onClose={p2pSearch.close}
      />
    </div>
  )
}
