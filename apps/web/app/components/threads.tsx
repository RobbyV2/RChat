'use client'

import { useAccount } from '../lib/client/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { MessageSquareText, MessagesSquare, Search, X } from 'lucide-react'
import { openActionMenu } from '../lib/actions/menu'
import { useForwardAccess } from '../lib/forward_access'
import { snippetParts } from '../lib/replies'
import { useStore } from '../lib/store'
import { isUnsupported } from '../lib/place/feature'
import { useFeature, useLive } from '../lib/place/react'
import { threads as threadsFeature, type ThreadPage, type Threads } from '../lib/place/threads'
import {
  THREADS_SEARCH,
  THREADS_TITLE,
  mergeRows,
  repliesText,
  rootLine,
  threadsEmpty,
  type ThreadRow,
} from '../lib/thread_list'
import { plainStamps } from '../lib/timestamps'
import { longPress } from './context_menu'
import { HeaderPopover } from './pins'
import { PreviewRow, RevealChannelPreview } from './preview_reveal'
import { SpoilerLine } from './replies'
import { ShownAvatar, ShownName } from './shown_user'
import { MessageTime } from './timestamp'
import { KeyAvatar } from './p2p/p2p_badge'
import { Button, IconButton } from './controls'
import { Row, Stack, Surface } from './layout'
import { Masked, Sentinel, useOwn } from './ui'

function ThreadsToggle({ threads, className }: { threads: Threads; className: string }) {
  const open = useLive(threads.state).open !== null
  return (
    <button
      data-threads-button
      title={THREADS_TITLE}
      aria-label={THREADS_TITLE}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? threads.close() : threads.open())}
      className={`rounded-full p-1.5 hover:bg-surface-container-high ${
        open ? 'bg-surface-container-high text-primary' : ''
      } ${className}`}
    >
      <MessagesSquare size={20} />
    </button>
  )
}

// The header button of the place around it.
export function ThreadsButton({ className = '' }: { className?: string }) {
  const here = useFeature(threadsFeature)
  return isUnsupported(here) ? null : <ThreadsToggle threads={here} className={className} />
}

interface ListState {
  rows: ThreadRow[] | null
  next: string | null
  failed: boolean
}

const START: ListState = { rows: null, next: null, failed: false }

// The rows of a Threads list for `query`, a page at a time from `load`: a new query starts over
// after a short pause while typing.
export function useThreadPages(
  load: (query: string, cursor: string | null) => Promise<ThreadPage>
) {
  const [query, setQuery] = useState('')
  const [list, setList] = useState<ListState>(START)
  const [retries, setRetries] = useState(0)
  const loadRef = useRef(load)
  const gen = useRef(0)
  const busy = useRef(false)
  useEffect(() => {
    loadRef.current = load
  })
  useEffect(() => {
    const at = ++gen.current
    const t = setTimeout(
      () => {
        loadRef
          .current(query, null)
          .then(page => {
            if (gen.current === at) setList({ rows: page.items, next: page.next, failed: false })
          })
          .catch(() => {
            if (gen.current === at) setList({ ...START, failed: true })
          })
      },
      query.trim() ? 250 : 0
    )
    return () => clearTimeout(t)
  }, [query, retries])
  const more = useCallback(() => {
    const cursor = list.next
    if (busy.current || cursor === null || list.rows === null) return
    busy.current = true
    const at = gen.current
    loadRef
      .current(query, cursor)
      .then(page => {
        if (gen.current !== at) return
        setList(cur => ({ ...cur, rows: mergeRows(cur.rows ?? [], page.items), next: page.next }))
      })
      .catch(() => {
        if (gen.current === at) setList(cur => ({ ...cur, next: null }))
      })
      .finally(() => {
        busy.current = false
      })
  }, [list, query])
  const search = (q: string) => {
    gen.current += 1
    setList(cur => ({ ...cur, next: null }))
    setQuery(q)
  }
  const retry = () => {
    setList(START)
    setRetries(n => n + 1)
  }
  return { query, search, ...list, more, retry }
}

// `peer`: a P2P list, whose authors carry their identity key as `username` and show as P2P
// message rows show them.
function ThreadEntry({
  row,
  server,
  peer,
  onOpen,
  onJump,
}: {
  row: ThreadRow
  server: string | null
  peer: boolean
  onOpen: () => void
  onJump: () => void
}) {
  const acct = useAccount()
  const m = row.root
  const blocked = useStore(s => s.blocked[m.author.username] === true)
  const own = useOwn(m.webhook ? null : m.author.username)
  const { access, target } = useForwardAccess(m, { server: server ?? undefined, active: !peer })
  const line = rootLine(m, row.files)
  const closed = !!m.forward && !peer && access !== 'open'
  const menu = longPress((x, y) =>
    openActionMenu(x, y, { kind: 'thread', open: onOpen, jump: onJump }, {}, acct)
  )
  return (
    <li>
      <PreviewRow
        {...menu}
        data-thread-row={row.key}
        onOpen={onOpen}
        title="Open thread"
        className="rounded-xl border border-outline-variant bg-surface-container hover:bg-surface-container-highest"
      >
        <Surface pad="md" gap="2xs" tone="plain" radius="none">
          <Row as="span" gap="sm">
            {peer ? (
              <KeyAvatar
                ik={m.author.username}
                size={24}
                kind={m.author.avatar_kind}
                bg={m.author.avatar_color}
              />
            ) : (
              <ShownAvatar user={m.author} server={server} size={24} />
            )}
            <span className="streamer min-w-0 truncate text-sm font-medium text-on-surface">
              {peer ? (
                <Masked text={m.author.display_name} by={m.author.username} />
              ) : (
                <ShownName user={m.author} server={server} />
              )}
            </span>
            <MessageTime ts={m.created_at} className="shrink-0 text-xs text-on-surface-variant" />
            {row.pinged && (
              <span
                data-thread-pinged
                role="img"
                title="Unread mentions"
                aria-label="Unread mentions"
                className="ml-auto size-2.5 shrink-0 rounded-full bg-danger"
              />
            )}
          </Row>
          <span className="min-w-0 text-sm text-on-surface-variant">
            {blocked ? (
              <span className="italic">Blocked message</span>
            ) : closed ? (
              <Row as="span" gap="2xs" wrap place="min-w-0">
                <span className="italic">Forwarded message</span>
                {target && <RevealChannelPreview target={target} />}
              </Row>
            ) : line.label ? (
              <span className="italic">{line.label}</span>
            ) : (
              <span className="line-clamp-2 break-words">
                <SpoilerLine parts={snippetParts(plainStamps(line.text))} own={own} />
              </span>
            )}
          </span>
          <Row as="span" gap="xs">
            <MessageSquareText size={12} className="shrink-0 text-primary" />
            <span className="text-xs font-medium text-primary">{repliesText(row.replies)}</span>
            <span aria-hidden className="text-xs text-on-surface-variant">
              ·
            </span>
            <span className="truncate text-xs text-on-surface-variant">
              Last reply <MessageTime ts={row.lastAt} />
            </span>
          </Row>
        </Surface>
      </PreviewRow>
    </li>
  )
}

// The threads of one conversation, as a popover (a sheet on phones): a search box, the threads
// with the newest reply first and more as the list scrolls. Hosted and P2P lists both use it.
export function ThreadsPanel({
  list,
  selfDm = false,
  server,
  peer = false,
  onClose,
  onOpen,
  onJump,
}: {
  list: ReturnType<typeof useThreadPages>
  selfDm?: boolean
  server: string | null
  peer?: boolean
  onClose: () => void
  onOpen: (row: ThreadRow) => void
  onJump: (row: ThreadRow) => void
}) {
  const { query, search, rows, next, failed, more, retry } = list
  const empty = threadsEmpty(query.trim() !== '', selfDm)
  return (
    <HeaderPopover
      icon={MessagesSquare}
      title={THREADS_TITLE}
      button="[data-threads-button]"
      sheetClose
      onClose={onClose}
    >
      <Surface pad="md" tone="plain" radius="none" place="shrink-0">
        <div className="flex items-center gap-2 rounded-full border border-outline px-3 focus-within:border-primary">
          <Search size={16} className="shrink-0 text-on-surface-variant" />
          <input
            type="search"
            value={query}
            onChange={e => search(e.target.value)}
            placeholder={THREADS_SEARCH}
            aria-label={THREADS_SEARCH}
            maxLength={200}
            className="h-11 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-on-surface-variant md:h-9 md:text-sm [&::-webkit-search-cancel-button]:hidden"
          />
          {query !== '' && (
            <IconButton icon={X} label="Clear search" size="sm" onClick={() => search('')} />
          )}
        </div>
      </Surface>
      <Surface
        pad="md"
        tone="plain"
        radius="none"
        border="top"
        place="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        {rows === null && !failed && (
          <Surface pad="xl" tone="plain" radius="none">
            <p className="text-center text-sm text-on-surface-variant">Loading threads</p>
          </Surface>
        )}
        {rows === null && failed && (
          <Surface pad="xl" gap="sm" align="center" tone="plain" radius="none">
            <span className="text-sm text-on-surface-variant">Couldn&apos;t load threads.</span>
            <Button onClick={retry}>Retry</Button>
          </Surface>
        )}
        {rows !== null && rows.length === 0 && (
          <Surface data-threads-empty pad="2xl" gap="sm" align="center" tone="plain" radius="none">
            <MessagesSquare size={36} className="text-on-surface-variant opacity-70" />
            <p className="text-center text-base font-semibold text-on-surface">{empty.title}</p>
            <p className="text-center text-sm text-on-surface-variant">{empty.body}</p>
          </Surface>
        )}
        {rows !== null && rows.length > 0 && (
          <Stack as="ul" gap="sm" aria-label={THREADS_TITLE}>
            {rows.map(r => (
              <ThreadEntry
                key={r.key}
                row={r}
                server={server}
                peer={peer}
                onOpen={() => onOpen(r)}
                onJump={() => onJump(r)}
              />
            ))}
          </Stack>
        )}
        {rows !== null && next !== null && <Sentinel key={rows.length} onVisible={more} />}
      </Surface>
    </HeaderPopover>
  )
}

// The Threads list of the conversation on screen in the place around it, while it is open.
export function ThreadsWindow() {
  const here = useFeature(threadsFeature)
  return isUnsupported(here) ? null : <OpenThreads threads={here} />
}

function OpenThreads({ threads }: { threads: Threads }) {
  const key = useLive(threads.state).open
  return key === null ? null : <ThreadsList key={key} threads={threads} />
}

function ThreadsList({ threads }: { threads: Threads }) {
  const state = useLive(threads.state)
  const list = useThreadPages(threads.page)
  return (
    <ThreadsPanel
      list={{ ...list, rows: list.rows && state.shown(list.rows) }}
      selfDm={state.selfDm}
      server={state.server}
      peer={state.byKey}
      onClose={threads.close}
      onOpen={threads.openThread}
      onJump={threads.jump}
    />
  )
}
