'use client'

import { Name } from './name'
import { p2pName } from '../lib/names'
import { shownUser } from '../lib/people'
import { useAccount } from '../lib/client/react'
import { useEffect, useRef, useState } from 'react'
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
import { IconButton } from './controls'
import { Row, Stack, Surface } from './layout'
import { useOwn } from './ui'
import { Loaded, More, usePages } from './loaded'

function ThreadsToggle({ threads, narrowHidden }: { threads: Threads; narrowHidden: boolean }) {
  const open = useLive(threads.state).open !== null
  return (
    <IconButton
      icon={MessagesSquare}
      label={THREADS_TITLE}
      size="lg"
      tone={open ? 'primary' : 'inherit'}
      data-threads-button
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => (open ? threads.close() : threads.open())}
      place={narrowHidden ? '@max-sm:hidden' : undefined}
    />
  )
}

// The header button of the place around it.
export function ThreadsButton({ narrowHidden = false }: { narrowHidden?: boolean }) {
  const here = useFeature(threadsFeature)
  return isUnsupported(here) ? null : <ThreadsToggle threads={here} narrowHidden={narrowHidden} />
}

// The rows of a Threads list for `query`, a page at a time from `load`: a new query starts over
// after a short pause while typing.
export function useThreadPages(
  load: (query: string, cursor: string | null) => Promise<ThreadPage>
) {
  const [query, search] = useState('')
  const loadRef = useRef(load)
  useEffect(() => {
    loadRef.current = load
  })
  const [pages] = usePages<ThreadRow>(
    cursor => loadRef.current(query, cursor),
    r => r.key,
    [query],
    { delayMs: query.trim() ? 250 : 0 }
  )
  return { query, search, pages }
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
              <KeyAvatar person={shownUser(m.author, null)} size={24} />
            ) : (
              <ShownAvatar user={m.author} server={server} size={24} />
            )}
            {peer ? (
              <Name
                of={p2pName(m.author.display_name, own)}
                place="min-w-0"
                look="truncate text-sm font-medium text-on-surface"
              />
            ) : (
              <ShownName
                user={m.author}
                server={server}
                place="min-w-0"
                look="truncate text-sm font-medium text-on-surface"
              />
            )}
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
  const { query, search, pages } = list
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
        <Surface
          pad="md"
          inset="sides"
          gap="sm"
          row
          tone="plain"
          radius="full"
          look="focus-within:border-primary border border-outline"
        >
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
        </Surface>
      </Surface>
      <Surface
        pad="md"
        tone="plain"
        radius="none"
        border="top"
        place="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      >
        <Loaded
          load={pages}
          what="threads"
          empty={
            <Surface
              data-threads-empty
              pad="2xl"
              gap="sm"
              align="center"
              tone="plain"
              radius="none"
            >
              <MessagesSquare size={36} className="text-on-surface-variant opacity-70" />
              <p className="text-center text-base font-semibold text-on-surface">{empty.title}</p>
              <p className="text-center text-sm text-on-surface-variant">{empty.body}</p>
            </Surface>
          }
        >
          {found => (
            <>
              <Stack as="ul" gap="sm" aria-label={THREADS_TITLE}>
                {found.items.map(r => (
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
              <More pages={found} auto />
            </>
          )}
        </Loaded>
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
      list={{
        ...list,
        pages: list.pages.map(found => ({ ...found, items: state.shown(found.items) })),
      }}
      selfDm={state.selfDm}
      server={state.server}
      peer={state.byKey}
      onClose={threads.close}
      onOpen={threads.openThread}
      onJump={threads.jump}
    />
  )
}
