'use client'

import { Name } from './name'
import { personCalled, serverCalled } from '../lib/names'
import { PeerActorTag, ViewActorTag } from './view_actor'
import { useAccount, useStoreApi } from '../lib/client/react'
import { useCallback, useEffect, useRef, useState, type RefObject } from 'react'
import { FileText, Hash, Search } from 'lucide-react'
import { useMask } from '../lib/store'
import { dayEndTs, dayStartTs, endOfList } from '../lib/search'
import { Button, Chip } from './controls'
import { Inset, Row, Stack, Surface } from './layout'
import { fieldCls, Masked, PanelHeader, Sentinel, smallFieldCls, useEscape } from './ui'
import { MessageListSkeleton } from './skeletons'
import { ShownAvatar, ShownName } from './shown_user'
import { avatarTriggerCls } from './message_row'
import { MessageTime } from './timestamp'
import { plainStamps } from '../lib/timestamps'
import { profileTrigger } from './profile_card'
import { ForwardedTag, SpoilerLine } from './replies'
import { PreviewRow, PreviewFilename, RevealChannelPreview } from './preview_reveal'
import { spoilerParts } from '../lib/spoilers'
import { useForwardAccess } from '../lib/forward_access'
import { isUnsupported } from '../lib/place/feature'
import { useFeature, useLive } from '../lib/place/react'
import {
  accountSearch,
  search,
  type Search as SearchFeature,
  type SearchFilters,
  type SearchHit,
  type SearchState,
} from '../lib/place/search'
import type { Load } from '../lib/load'
import { Loaded, useLoad } from './loaded'
import { FailureNotice } from './notices'
import { MemberAvatar } from './p2p/p2p_badge'
import { time } from '../lib/platform/time'

function HitText({ r }: { r: SearchHit }) {
  const copy = useForwardAccess(r.copy?.message, { server: r.copy?.server })
  if (r.reveal)
    return (
      <p className="text-sm text-on-surface-variant">
        <RevealChannelPreview target={r.reveal} />
      </p>
    )
  if (copy.access !== 'open')
    return (
      <Row as="p" gap="2xs" wrap text="sm" ink="muted" place="min-w-0">
        <span className="italic">Forwarded message</span>
        {copy.target && <RevealChannelPreview target={copy.target} />}
      </Row>
    )
  if (!r.content && r.file === null) return null
  return (
    <Stack gap="3xs">
      {r.content && (
        <p className="line-clamp-2 text-sm break-words text-on-surface">
          <SpoilerLine parts={spoilerParts(plainStamps(r.content))} own={r.own && !r.forwarded} />
        </p>
      )}
      {r.file !== null && (
        <p className="text-xs text-on-surface-variant">
          <Row as="span" gap="2xs">
            <FileText size={12} />
            <PreviewFilename name={r.file} spoiler={r.fileSpoiler} own={r.own && !r.forwarded} />
          </Row>
        </p>
      )}
    </Stack>
  )
}

// Who wrote a hit, as its side shows people.
function HitAuthor({ r }: { r: SearchHit }) {
  const store = useStoreApi()
  const { author } = r
  if (author === null) return <>Open channel</>
  if (author.kind === 'key')
    return (
      <>
        <span className="shrink-0">
          <MemberAvatar members={author.of} ik={author.ik} size={20} />
        </span>
        <Name of={personCalled(author.name, null, r.own)} look="truncate text-sm font-medium" />
      </>
    )
  return (
    <>
      <span
        {...profileTrigger(store, author.user, author.server, false)}
        title="View profile"
        className={`shrink-0 ${avatarTriggerCls}`}
      >
        <ShownAvatar user={author.user} server={author.server} size={20} />
      </span>
      <ShownName
        user={author.user}
        server={author.server}
        link
        {...profileTrigger(store, author.user, author.server)}
        look="truncate text-sm font-medium"
      />
    </>
  )
}

export function SearchView({
  peer = false,
  channels,
  results,
  seed,
  note,
  scrollForMore,
  onRun,
  onClose,
}: {
  peer?: boolean
  // The "in:" choices (the current server's channels), or none.
  channels: { id: string; name: string }[] | undefined
  results: Load<SearchState>
  // A query to start with; a new `n` puts its text in the field again.
  seed?: { q: string | null; n: number }
  // Shown under the filters (where the search looks).
  note?: string | null
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
  const listRef = useRef<HTMLDivElement>(null)
  useEscape(onClose, 'panel')

  useEffect(() => {
    if (!active) return
    const t = time().after(300, () => runRef.current(argsRef.current, true))
    return () => t()
  }, [args.q, args.from, channelId, hasFile, args.beforeTs, args.afterTs, active])

  const more = useCallback(() => runRef.current(argsRef.current, false), [])

  const dateField = (
    label: string,
    value: string,
    onChange: (value: string) => void,
    max?: string
  ) => (
    <label className="text-xs text-on-surface-variant">
      <Row as="span" gap="xs">
        {label}
        <input
          type="date"
          value={value}
          max={max}
          onChange={e => onChange(e.target.value)}
          className={smallFieldCls}
        />
      </Row>
    </label>
  )

  return (
    <div className="flex h-full w-full flex-col bg-surface-container-low">
      <PanelHeader
        actor={peer ? <PeerActorTag header /> : <ViewActorTag header />}
        icon={Search}
        title="Search"
        closeTitle="Close search"
        onClose={onClose}
      />
      <Surface pad="md" gap="sm" tone="plain" radius="none" border="bottom" place="shrink-0">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search messages"
          autoFocus
          className={fieldCls}
        />
        <Row gap="sm" wrap>
          <input
            value={from}
            onChange={e => setFrom(e.target.value)}
            placeholder="from: user"
            className={`${smallFieldCls} w-28`}
          />
          {channels && (
            <select
              value={channelId}
              onChange={e => setChannelId(e.target.value)}
              className={`${smallFieldCls} text-on-surface-variant`}
            >
              <option value="">in: any channel</option>
              {channels.map(c => (
                <option key={c.id} value={c.id}>
                  in: #{mask(c.name)}
                </option>
              ))}
            </select>
          )}
          <Chip on={hasFile} title="Only messages with a file" onClick={() => setHasFile(v => !v)}>
            has:file
          </Chip>
          {dateField('before', before, setBefore)}
          {dateField('after', after, setAfter)}
        </Row>
        {note && <p className="text-xs text-on-surface-variant">{note}</p>}
      </Surface>
      <div ref={listRef} className="anchor-none flex-1 overflow-y-auto">
        <Inset pad="sm" safe>
          {!active && (
            <Surface pad="xl" tone="plain" radius="none">
              <p className="text-center text-sm text-on-surface-variant">
                Type a query or pick a filter to search.
              </p>
            </Surface>
          )}
          {(active || results.status === 'ready') && (
            <Loaded
              load={results}
              what="results"
              skeleton={
                <MessageListSkeleton seed="search" variant="search" label="Loading results" />
              }
              empty={
                <Surface pad="xl" tone="plain" radius="none">
                  <p className="text-center text-sm text-on-surface-variant">No results.</p>
                </Surface>
              }
            >
              {found => (
                <Hits found={found} active={active} stepped={stepped} list={listRef} more={more} />
              )}
            </Loaded>
          )}
        </Inset>
      </div>
    </div>
  )
}

// The hits of a search, with the way to its next page: on sight, or (`stepped`) one page for each
// scroll to the end and a button. A page that failed says so under the hits.
function Hits({
  found,
  active,
  stepped,
  list,
  more,
}: {
  found: SearchState
  // Whether a search is typed: without one the hits of the last search stay, with no next page.
  active: boolean
  stepped: boolean
  list: RefObject<HTMLDivElement | null>
  more: () => void
}) {
  const { hits, loading, hasMore, pageKey, failure } = found
  const steppedRef = useRef(stepped)
  steppedRef.current = stepped
  const pageRef = useRef(pageKey)
  pageRef.current = pageKey
  const [end] = useState(endOfList)
  const endShown = useCallback(() => {
    if (end.sight(true, pageRef.current, steppedRef.current)) more()
  }, [end, more])
  const endHidden = useCallback(() => {
    end.sight(false, pageRef.current, steppedRef.current)
  }, [end])
  useEffect(() => {
    const el = list.current
    if (!el) return
    const scrolled = () => {
      if (end.scroll(el.scrollTop, pageRef.current, steppedRef.current)) more()
    }
    el.addEventListener('scroll', scrolled, { passive: true })
    return () => el.removeEventListener('scroll', scrolled)
  }, [list, end, more])
  return (
    <>
      {hits.map(r => (
        <PreviewRow
          key={r.key}
          onOpen={r.onOpen}
          className="block w-full rounded-xl text-left hover:bg-surface-container-high"
        >
          <Surface pad="md" gap="2xs" tone="plain" radius="none">
            <p className="text-xs text-on-surface-variant">
              <Row as="span" gap="2xs">
                <Hash size={12} className="shrink-0" />
                <span className="truncate">
                  <Masked text={r.channel} own={r.ownPlace} />
                </span>
                <span className="shrink-0">·</span>
                <Name of={serverCalled(r.server, r.ownPlace)} look="truncate" />
              </Row>
            </p>
            <Row gap="sm">
              <HitAuthor r={r} />
              <MessageTime ts={r.createdAt} className="shrink-0 text-xs text-on-surface-variant" />
              {r.forwarded && (
                <span className="text-xs">
                  <ForwardedTag />
                </span>
              )}
            </Row>
            <HitText r={r} />
          </Surface>
        </PreviewRow>
      ))}
      {!active ? null : failure !== null ? (
        <FailureNotice error={failure} lead="Could not load more results." retry={more} />
      ) : (
        <>
          {hasMore && <Sentinel key={pageKey} onVisible={endShown} onHidden={endHidden} />}
          {stepped && (hasMore || loading) && (
            <div className="flex min-h-9 items-center justify-center">
              {loading ? (
                <p className="text-xs text-on-surface-variant">Searching</p>
              ) : (
                <Button onClick={more}>Search older messages</Button>
              )}
            </div>
          )}
          {loading && !stepped && (
            <Surface pad="md" tone="plain" radius="none">
              <p className="text-center text-xs text-on-surface-variant">Searching</p>
            </Surface>
          )}
        </>
      )}
    </>
  )
}

// The search panel of a hosted server or DM, or of a P2P room or conversation.
export default function SearchPanel() {
  const account = useAccount()
  const here = useFeature(search)
  return <SearchOf of={isUnsupported(here) ? accountSearch(account) : here} />
}

function SearchOf({ of }: { of: SearchFeature }) {
  const state = useLive(of.state)
  const results = useLoad(of.results)
  useEffect(() => of.watch(), [of])
  return (
    <SearchView
      peer={state.byIdentity}
      channels={state.channels}
      results={results}
      seed={state.seed ?? undefined}
      note={state.note}
      scrollForMore={of.steps}
      onRun={of.run}
      onClose={of.close}
    />
  )
}
