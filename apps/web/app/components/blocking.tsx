'use client'

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { UserX } from 'lucide-react'
import { useStore } from '../lib/store'
import { blockedLabel, blockedRuns, type BlockedRun } from '../lib/blocks'
import { dayLines } from '../lib/date_dividers'
import type { Message, UserRef } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { DateDivider } from './date_divider'
import { Button, LinkButton } from './controls'
import { fieldCls, FieldError, Masked, Sentinel } from './ui'

// Collapsed runs of blocked users' messages. A run opens with Show, or by itself when a jump
// targets one of its messages.
export function useBlockedRuns(messages: Message[], focusId: number | null) {
  const blocked = useStore(s => s.blocked)
  const runs = useMemo(() => blockedRuns(messages, blocked), [messages, blocked])
  const [shown, setShown] = useState<ReadonlySet<number>>(() => new Set())
  const focusRun = useMemo(() => {
    if (focusId === null) return null
    for (const run of runs.values()) if (run.ids.includes(focusId)) return run
    return null
  }, [runs, focusId])
  const toggle = useCallback((run: BlockedRun, open: boolean) => {
    setShown(cur => {
      const next = new Set(cur)
      for (const id of run.ids) {
        if (open) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])
  useEffect(() => {
    if (focusRun) toggle(focusRun, true)
  }, [focusRun, toggle])
  const isOpen = useCallback(
    (run: BlockedRun) => run === focusRun || run.ids.some(id => shown.has(id)),
    [shown, focusRun]
  )
  return { runs, isOpen, toggle }
}

export function BlockedRow({
  count,
  open,
  divider,
  onToggle,
}: {
  count: number
  open: boolean
  divider?: ReactNode
  onToggle: () => void
}) {
  return (
    <div data-blocked>
      {divider}
      <div className="flex items-center gap-2 px-4 py-1 text-sm text-on-surface-variant">
        <UserX size={14} aria-hidden className="shrink-0" />
        <span>{blockedLabel(count)}</span>
        <span aria-hidden>·</span>
        <LinkButton onClick={onToggle} aria-expanded={open}>
          {open ? 'Hide' : 'Show'}
        </LinkButton>
      </div>
    </div>
  )
}

// A quoted message (forward or message link) by someone you blocked, until Show opens it.
export function BlockedQuote({ onShow }: { onShow: () => void }) {
  return (
    <div
      data-blocked-quote
      className="flex min-w-0 items-center gap-1.5 text-sm text-on-surface-variant"
    >
      <UserX size={14} aria-hidden className="shrink-0" />
      <span className="truncate italic">Blocked message</span>
      <span aria-hidden>·</span>
      <LinkButton
        onClick={e => {
          e.stopPropagation()
          onShow()
        }}
      >
        Show
      </LinkButton>
    </div>
  )
}

// Renders `messages` with blocked users' runs collapsed. `row(m, i)` draws one message;
// `dividerAt` is the unread divider index, drawn on a collapsed row that hides it.
// A line with the date goes above each shown row on another day than the last line (from
// `dayAbove`, the time of what shows above the list); a folded run counts as its first row.
// `tail` draws what follows the list, given the time of the last row shown (or `dayAbove`).
export function BlockedList({
  messages,
  focusId,
  dividerAt = -1,
  divider,
  dayAbove = null,
  row,
  tail,
}: {
  messages: Message[]
  focusId: number | null
  dividerAt?: number
  divider?: ReactNode
  dayAbove?: number | null
  row: (m: Message, i: number) => ReactNode
  tail?: (lastShownAt: number | null) => ReactNode
}) {
  const { runs, isOpen, toggle } = useBlockedRuns(messages, focusId)
  const shown = useMemo(
    () =>
      messages.map((_, i) => {
        const run = runs.get(i)
        return !run || run.start === i || isOpen(run)
      }),
    [messages, runs, isOpen]
  )
  const lines = useMemo(
    () =>
      dayLines(
        messages.map(m => m.created_at),
        shown,
        dayAbove
      ),
    [messages, shown, dayAbove]
  )
  const last = shown.lastIndexOf(true)
  const dayLine = (i: number) => (lines.has(i) ? <DateDivider at={messages[i].created_at} /> : null)
  const items = messages.map((m, i) => {
    const run = runs.get(i)
    if (!run)
      return (
        <Fragment key={m.id}>
          {dayLine(i)}
          {row(m, i)}
        </Fragment>
      )
    const open = isOpen(run)
    const head =
      run.start === i ? (
        <BlockedRow
          count={run.ids.length}
          open={open}
          divider={
            !open && dividerAt >= run.start && dividerAt < run.start + run.ids.length
              ? divider
              : undefined
          }
          onToggle={() => toggle(run, !open)}
        />
      ) : null
    return (
      <Fragment key={m.id}>
        {(open || run.start === i) && dayLine(i)}
        {head}
        {open && row(m, i)}
      </Fragment>
    )
  })
  return (
    <>
      {items}
      {tail?.(last >= 0 ? messages[last].created_at : dayAbove)}
    </>
  )
}

// Replaces the composer in a DM with someone you blocked.
export function BlockedComposer({ user }: { user: UserRef }) {
  const unblockUser = useStore(s => s.unblockUser)
  return (
    <div className="flex items-center gap-3 border-t border-outline-variant px-4 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] text-sm text-on-surface-variant">
      <UserX size={16} aria-hidden className="shrink-0" />
      <span className="min-w-0 flex-1">You blocked this user.</span>
      <Button onClick={() => void unblockUser(user.username, user.display_name)}>Unblock</Button>
    </div>
  )
}

function BlockByName() {
  const blockUser = useStore(s => s.blockUser)
  const [name, setName] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    const username = name.trim().replace(/^@/, '')
    if (!username || busy) return
    setBusy(true)
    const err = await blockUser(username)
    setBusy(false)
    setError(err)
    if (!err) setName('')
  }
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        void submit()
      }}
    >
      <div className="flex gap-2">
        <input
          value={name}
          onChange={e => {
            setName(e.target.value)
            setError(null)
          }}
          placeholder="Username"
          aria-label="Username to block"
          aria-invalid={error !== null}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          className={fieldCls}
        />
        <Button type="submit" variant="filled" size="md" disabled={!name.trim() || busy}>
          Block
        </Button>
      </div>
      <FieldError message={error} />
    </form>
  )
}

export function BlockedUsersSection() {
  const page = useStore(s => s.blockList)
  const loadBlockList = useStore(s => s.loadBlockList)
  const unblockUser = useStore(s => s.unblockUser)
  const [q, setQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => void loadBlockList(q, true), q ? 300 : 0)
    return () => clearTimeout(t)
  }, [q, loadBlockList])
  const more = useCallback(() => void loadBlockList(q), [q, loadBlockList])
  const empty = !page.loading && !page.hasMore && page.list.length === 0
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-on-surface-variant">
        Blocked users can&apos;t message, call or ping you, and their messages are hidden. They are
        not told.
      </p>
      <BlockByName />
      <input
        value={q}
        onChange={e => setQ(e.target.value)}
        placeholder="Search blocked users"
        aria-label="Search blocked users"
        className={fieldCls}
      />
      <div className="space-y-1">
        {page.list.map(({ user }) => (
          <div
            key={user.username}
            className="flex items-center gap-2 rounded-xl bg-surface-container px-2 py-1.5"
          >
            <UserAvatar
              username={user.username}
              avatarKind={user.avatar_kind}
              avatarColor={user.avatar_color}
              size={28}
            />
            <span className="min-w-0 flex-1 truncate text-sm">
              <span className="streamer">
                <Masked text={user.display_name} by={user.username} />
              </span>{' '}
              <span className="streamer text-on-surface-variant">@{user.username}</span>
            </span>
            <Button onClick={() => void unblockUser(user.username)}>Unblock</Button>
          </div>
        ))}
        {page.hasMore && <Sentinel key={page.list.length} onVisible={more} />}
        {empty && (
          <p className="py-2 text-sm text-on-surface-variant">
            {q.trim() ? 'No blocked users match.' : 'You have not blocked anyone.'}
          </p>
        )}
      </div>
    </div>
  )
}
