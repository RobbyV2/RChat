'use client'

import { useEffect, useRef, useState } from 'react'
import {
  ChartColumn,
  Check,
  ChevronDown,
  ChevronUp,
  EyeOff,
  Lock,
  LockOpen,
  Plus,
  Smile,
  Trophy,
  X,
} from 'lucide-react'
import { managesPoll } from '../lib/actions/message'
import { api } from '../lib/instances'
import {
  KIND_HINTS,
  KIND_LABELS,
  POLL_OPTIONS_MAX,
  POLL_OPTION_MAX,
  ballotBody,
  ballotReady,
  countOf,
  hiddenHint,
  moveRank,
  optionLabel,
  percent,
  pollClosed,
  runoffRows,
  sameBallot,
  timeLeft,
  toggleChoice,
  toggleRank,
  votersLabel,
  votersShown,
  writtenKind,
} from '../lib/polls'
import { useStore } from '../lib/store'
import type { Message, Poll, PollVoter } from '../lib/types'
import { EmojiPicker } from './emoji_picker'
import { Dialog, fieldCls, FieldError, filledBtn, Masked, Sentinel, textBtn } from './ui'
import { UserAvatar } from './user_avatar'
import { MessageTime } from './timestamp'

const nowSec = () => Math.floor(Date.now() / 1000)

// Seconds now, ticking every 30 seconds while `on`.
function useNow(on: boolean) {
  const [now, setNow] = useState(nowSec)
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(nowSec()), 30_000)
    return () => clearInterval(t)
  }, [on])
  return now
}

export const canManagePoll = (m: Message) => managesPoll(useStore.getState(), m)

const openVoters = (m: Message) =>
  useStore.getState().openDialog({ kind: 'poll_voters', message: m })

function Bar({ share, mine, lead }: { share: number; mine: boolean; lead: boolean }) {
  return (
    <span
      aria-hidden
      className={`absolute inset-y-0 left-0 rounded-xl transition-[width] duration-300 ${
        mine
          ? 'bg-primary-container'
          : lead
            ? 'bg-secondary-container'
            : 'bg-surface-container-highest'
      }`}
      style={{ width: `${share}%` }}
    />
  )
}

function Mark({ on, square }: { on: boolean; square: boolean }) {
  return (
    <span
      aria-hidden
      className={`relative flex size-4 shrink-0 items-center justify-center border-2 ${
        square ? 'rounded-sm' : 'rounded-full'
      } ${on ? 'border-primary bg-primary text-on-primary' : 'border-outline'}`}
    >
      {on && <Check size={11} strokeWidth={3} />}
    </span>
  )
}

function ChoiceList({
  poll,
  picked,
  onPick,
  live,
}: {
  poll: Poll
  picked: number[]
  onPick: ((id: number) => void) | null
  live: boolean
}) {
  const r = poll.results
  const total = poll.voters
  const winner = poll.closed ? (r?.winner ?? null) : null
  const ranked = poll.kind === 'ranked'
  return (
    <ul className="mt-2 flex flex-col gap-1.5">
      {poll.options.map(o => {
        const count = countOf(poll, o.id)
        const share = r ? percent(count, total) : 0
        const mine = !!poll.mine?.includes(o.id)
        const sel = picked.includes(o.id)
        const rank = ranked ? picked.indexOf(o.id) + 1 : 0
        const body = (
          <>
            {r && <Bar share={share} mine={mine} lead={winner === o.id} />}
            <span className="relative flex min-w-0 flex-1 items-center gap-2">
              {live &&
                (ranked ? (
                  <span
                    aria-hidden
                    className={`flex size-5 shrink-0 items-center justify-center rounded-full text-xs font-medium tabular-nums ${
                      rank ? 'bg-primary text-on-primary' : 'border-2 border-outline'
                    }`}
                  >
                    {rank || ''}
                  </span>
                ) : (
                  <Mark on={sel} square={poll.kind === 'multiple'} />
                ))}
              <span className="min-w-0 flex-1 break-words">
                <Masked text={optionLabel(o)} />
              </span>
              {winner === o.id && (
                <Trophy size={14} className="shrink-0 text-primary" aria-label="Winner" />
              )}
              {mine &&
                !live &&
                (ranked ? (
                  <span
                    className="shrink-0 text-xs font-medium text-primary tabular-nums"
                    aria-label={`Your choice ${(poll.mine?.indexOf(o.id) ?? 0) + 1}`}
                  >
                    #{(poll.mine?.indexOf(o.id) ?? 0) + 1}
                  </span>
                ) : (
                  <Check size={14} className="shrink-0 text-primary" aria-label="Your vote" />
                ))}
            </span>
            {r && (
              <span className="relative shrink-0 text-xs text-on-surface-variant tabular-nums">
                {ranked ? `${count} first` : `${share}% · ${count}`}
              </span>
            )}
          </>
        )
        const cls = `relative flex min-h-10 w-full items-center gap-2 overflow-hidden rounded-xl border px-3 py-2 text-left text-sm ${
          sel && live ? 'border-primary' : 'border-outline-variant'
        }`
        return (
          <li key={o.id} className="flex items-center gap-1">
            {onPick ? (
              <button
                type="button"
                data-poll-option={o.id}
                aria-pressed={sel}
                onClick={() => onPick(o.id)}
                className={`${cls} hover:border-outline`}
              >
                {body}
              </button>
            ) : (
              <div data-poll-option={o.id} className={cls}>
                {body}
              </div>
            )}
          </li>
        )
      })}
    </ul>
  )
}

function RankOrder({
  poll,
  order,
  onMove,
}: {
  poll: Poll
  order: number[]
  onMove: (id: number, by: -1 | 1) => void
}) {
  if (order.length < 2) return null
  return (
    <ol className="mt-2 flex flex-col gap-1 rounded-xl bg-surface-container-high p-2 text-sm">
      {order.map((id, i) => {
        const o = poll.options.find(x => x.id === id)
        if (!o) return null
        return (
          <li key={id} className="flex items-center gap-2">
            <span className="w-5 shrink-0 text-center text-xs font-medium text-primary tabular-nums">
              {i + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">
              <Masked text={optionLabel(o)} />
            </span>
            <button
              type="button"
              title="Move up"
              aria-label={`Move ${o.text} up`}
              disabled={i === 0}
              onClick={() => onMove(id, -1)}
              className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-30 pointer-coarse:p-2"
            >
              <ChevronUp size={16} />
            </button>
            <button
              type="button"
              title="Move down"
              aria-label={`Move ${o.text} down`}
              disabled={i === order.length - 1}
              onClick={() => onMove(id, 1)}
              className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest disabled:opacity-30 pointer-coarse:p-2"
            >
              <ChevronDown size={16} />
            </button>
          </li>
        )
      })}
    </ol>
  )
}

function Rounds({ poll }: { poll: Poll }) {
  const rounds = runoffRows(poll)
  return (
    <div data-poll-rounds className="mt-2 flex flex-col gap-3">
      {rounds.map(round => (
        <div key={round.n}>
          <p className="text-xs font-medium text-on-surface-variant">
            Round {round.n}
            {round.exhausted > 0 && ` · ${round.exhausted} without a choice left`}
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {round.rows.map(row =>
              row.option ? (
                <li
                  key={row.option.id}
                  className={`relative flex items-center gap-2 overflow-hidden rounded-lg px-2 py-1 text-xs ${
                    round.eliminated === row.option.id ? 'text-on-surface-variant line-through' : ''
                  }`}
                >
                  <Bar
                    share={row.share}
                    mine={false}
                    lead={round.eliminated === null && poll.results?.winner === row.option.id}
                  />
                  <span className="relative min-w-0 flex-1 truncate">
                    <Masked text={optionLabel(row.option)} />
                  </span>
                  <span className="relative shrink-0 tabular-nums">
                    {row.count} · {row.share}%
                  </span>
                </li>
              ) : null
            )}
          </ul>
        </div>
      ))}
    </div>
  )
}

function RunoffSummary({ poll, closed }: { poll: Poll; closed: boolean }) {
  const r = poll.results
  const winner = poll.options.find(o => o.id === r?.winner)
  if (!r || !winner) return null
  const n = r.rounds.length
  return (
    <p className="mt-2 flex items-center gap-1.5 text-xs text-on-surface">
      <Trophy size={12} className="shrink-0 text-primary" />
      <span className="min-w-0 break-words">
        <span className="font-medium">
          <Masked text={optionLabel(winner)} />
        </span>{' '}
        {closed ? 'won' : 'leads'} after {n} {n === 1 ? 'round' : 'rounds'}
      </span>
    </p>
  )
}

function Rating({
  poll,
  picked,
  onPick,
}: {
  poll: Poll
  picked: number[]
  onPick: ((v: number) => void) | null
}) {
  const scale = poll.scale ?? 5
  const r = poll.results
  const top = Math.max(1, ...(r?.distribution ?? [0]))
  const scores = Array.from({ length: scale }, (_, i) => i + 1)
  return (
    <div className="mt-2">
      {onPick && (
        <div role="radiogroup" aria-label="Score" className="flex flex-wrap gap-1.5">
          {scores.map(v => {
            const on = picked[0] === v
            return (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={on}
                data-poll-score={v}
                onClick={() => onPick(v)}
                className={`min-w-9 rounded-full border px-2.5 py-1.5 text-sm font-medium tabular-nums ${
                  on
                    ? 'border-primary bg-primary text-on-primary'
                    : 'border-outline-variant hover:border-outline'
                }`}
              >
                {v}
              </button>
            )
          })}
        </div>
      )}
      {r && (
        <div className="mt-3 flex items-end gap-3">
          <div className="shrink-0">
            <p className="text-2xl font-medium tabular-nums" data-poll-average>
              {r.average === null ? '-' : r.average.toFixed(1)}
            </p>
            <p className="text-xs text-on-surface-variant">average of {scale}</p>
          </div>
          <div className="flex h-16 min-w-0 flex-1 items-end gap-1" aria-label="Scores">
            {r.distribution.map((n, i) => (
              <div key={i} className="flex min-w-0 flex-1 flex-col items-center gap-0.5">
                <div
                  title={`${i + 1}: ${n}`}
                  className={`w-full rounded-t-md ${
                    poll.mine?.[0] === i + 1 ? 'bg-primary' : 'bg-secondary-container'
                  }`}
                  style={{ height: `${Math.max(4, (n / top) * 48)}px` }}
                />
                <span className="text-[10px] text-on-surface-variant tabular-nums">{i + 1}</span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function AddOption({ id, onDone }: { id: number; onDone: () => void }) {
  const addPollOption = useStore(s => s.addPollOption)
  const [text, setText] = useState('')
  const [emoji, setEmoji] = useState<string | null>(null)
  const [picker, setPicker] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const emojiRef = useRef<HTMLButtonElement>(null)
  const submit = async () => {
    if (!text.trim() || busy) return
    setBusy(true)
    const err = await addPollOption(id, text.trim(), emoji)
    setBusy(false)
    if (err) setError(err)
    else onDone()
  }
  return (
    <div className="mt-2">
      <div className="flex items-center gap-1.5">
        <button
          ref={emojiRef}
          type="button"
          title={emoji ? 'Change emoji' : 'Add an emoji'}
          aria-label={emoji ? 'Change emoji' : 'Add an emoji'}
          onClick={() => setPicker(true)}
          className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest"
        >
          {emoji ? <span className="text-base leading-none">{emoji}</span> : <Smile size={16} />}
        </button>
        <input
          autoFocus
          value={text}
          maxLength={POLL_OPTION_MAX}
          onChange={e => {
            setText(e.target.value)
            setError(null)
          }}
          onKeyDown={e => {
            if (e.key === 'Enter') void submit()
            if (e.key === 'Escape') onDone()
          }}
          placeholder="New option"
          aria-label="New option"
          className={`${fieldCls} py-1.5`}
        />
        <button
          type="button"
          onClick={() => void submit()}
          disabled={!text.trim() || busy}
          className={`${textBtn} disabled:opacity-40`}
        >
          Add
        </button>
        <button
          type="button"
          title="Cancel"
          aria-label="Cancel"
          onClick={onDone}
          className="shrink-0 rounded-full p-2 text-on-surface-variant hover:bg-surface-container-highest"
        >
          <X size={16} />
        </button>
      </div>
      <FieldError message={error} />
      {picker && (
        <EmojiPicker
          anchor={emojiRef.current}
          onPick={e => {
            setEmoji(e)
            setPicker(false)
          }}
          onClose={() => setPicker(false)}
        />
      )}
    </div>
  )
}

export function PollVotersDialog() {
  const m = useStore(s => (s.activeDialog?.kind === 'poll_voters' ? s.activeDialog.message : null))
  const closeDialog = useStore(s => s.closeDialog)
  if (!m) return null
  return <PollVoters key={m.id} m={m} onClose={closeDialog} />
}

function VoterList({ id, option }: { id: number; option: number | null }) {
  const [list, setList] = useState<PollVoter[]>([])
  const [next, setNext] = useState<string | null>(null)
  const [more, setMore] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const loading = useRef(false)
  const load = async () => {
    if (loading.current || !more) return
    loading.current = true
    try {
      const page = await api.pollVoters(id, option, next)
      setList(cur => [
        ...cur,
        ...page.items.filter(v => !cur.some(c => c.user.username === v.user.username)),
      ])
      setNext(page.next)
      setMore(page.next !== null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      loading.current = false
    }
  }
  return (
    <>
      <FieldError message={error} />
      <ul data-poll-voters className="mt-3 flex flex-col">
        {list.map(v => (
          <li key={v.user.username} className="flex items-center gap-3 py-1.5">
            <UserAvatar
              username={v.user.username}
              avatarKind={v.user.avatar_kind}
              avatarColor={v.user.avatar_color}
              size={28}
            />
            <span className="streamer min-w-0 flex-1 truncate text-sm">
              <Masked text={v.user.display_name} />
            </span>
            <MessageTime ts={v.voted_at} className="shrink-0 text-xs text-on-surface-variant" />
          </li>
        ))}
      </ul>
      {!error && !more && list.length === 0 && (
        <p className="py-4 text-center text-sm text-on-surface-variant">No votes yet</p>
      )}
      {more && !error && <Sentinel onVisible={() => void load()} />}
    </>
  )
}

function PollVoters({ m, onClose }: { m: Message; onClose: () => void }) {
  const poll = m.poll
  const [option, setOption] = useState<number | null>(null)
  if (!poll) return null
  const scores =
    poll.kind === 'rating' ? Array.from({ length: poll.scale ?? 5 }, (_, i) => i + 1) : []
  const chips: { key: number | null; label: string }[] = [
    { key: null, label: 'All' },
    ...(poll.kind === 'rating'
      ? scores.map(v => ({ key: v, label: String(v) }))
      : poll.options.map(o => ({ key: o.id, label: optionLabel(o) }))),
  ]
  return (
    <Dialog title="Votes" onClose={onClose} full>
      <p className="text-sm break-words text-on-surface-variant">
        <Masked text={poll.question} />
      </p>
      <div className="mt-3 flex flex-wrap gap-1.5" role="tablist" aria-label="Filter by option">
        {chips.map(c => (
          <button
            key={c.key ?? 'all'}
            role="tab"
            aria-selected={option === c.key}
            onClick={() => setOption(c.key)}
            className={`max-w-full truncate rounded-full border px-3 py-1 text-xs font-medium ${
              option === c.key
                ? 'border-transparent bg-secondary-container text-on-secondary-container'
                : 'border-outline-variant text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            <Masked text={c.label} />
          </button>
        ))}
      </div>
      {poll.kind === 'ranked' && option !== null && (
        <p className="mt-2 text-xs text-on-surface-variant">Voters who ranked it first</p>
      )}
      <VoterList key={option ?? 'all'} id={m.id} option={option} />
    </Dialog>
  )
}

// The poll of a poll message, or the frozen copy on a forward. `canVote` is the right to react
// there; the server decides again.
export function PollCard({ m, canVote = false }: { m: Message; canVote?: boolean }) {
  const poll = m.poll
  const me = useStore(s => s.me?.username)
  const votePoll = useStore(s => s.votePoll)
  const retractVote = useStore(s => s.retractVote)
  const closePoll = useStore(s => s.closePoll)
  const reopenPoll = useStore(s => s.reopenPoll)
  const manage = useStore(() => canManagePoll(m))
  const [picked, setPicked] = useState<number[]>(poll?.mine ?? [])
  const [editing, setEditing] = useState(false)
  const [adding, setAdding] = useState(false)
  const [rounds, setRounds] = useState(false)
  const [busy, setBusy] = useState(false)
  const mineKey = poll?.mine?.join(',') ?? ''
  const [seenMine, setSeenMine] = useState(mineKey)
  if (seenMine !== mineKey) {
    setSeenMine(mineKey)
    setPicked(poll?.mine ?? [])
    setEditing(false)
  }
  const now = useNow(!!poll && !poll.closed && poll.closes_at !== null)
  if (!poll) return null
  const static_ = !!poll.snapshot
  const closed = pollClosed(poll, now)
  const voted = !!poll.mine?.length
  const live =
    !static_ &&
    !closed &&
    canVote &&
    (!voted || editing || (poll.kind === 'rating' && poll.allow_change))
  const choosing = live && poll.kind !== 'rating'
  const left = closed ? null : timeLeft(poll.closes_at, now)
  const ready = ballotReady(poll, picked) && !sameBallot(poll.mine, picked)
  const submit = async (ballot = picked) => {
    if (busy) return
    setBusy(true)
    await votePoll(m.id, ballotBody(poll, ballot))
    setBusy(false)
    setEditing(false)
  }
  const pick = (id: number) =>
    setPicked(cur => (poll.kind === 'ranked' ? toggleRank(cur, id) : toggleChoice(cur, id, poll)))
  const hint =
    poll.kind === 'multiple'
      ? poll.min_choices === poll.max_choices
        ? `Pick ${poll.min_choices}`
        : `Pick ${poll.min_choices} to ${poll.max_choices}`
      : KIND_HINTS[poll.kind]
  const canAdd =
    !static_ &&
    !closed &&
    canVote &&
    writtenKind(poll.kind) &&
    poll.options.length < POLL_OPTIONS_MAX &&
    (poll.allow_add || m.author.username === me)
  return (
    <div
      data-poll={m.id}
      className="mt-1 max-w-120 min-w-0 rounded-2xl border border-outline-variant bg-surface-container p-3"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-on-surface-variant">
        <span className="flex items-center gap-1 font-medium text-primary">
          <ChartColumn size={14} />
          {KIND_LABELS[poll.kind]}
        </span>
        {poll.anonymous && (
          <span className="flex items-center gap-1">
            <EyeOff size={12} />
            Anonymous
          </span>
        )}
        {static_ && <span>Snapshot</span>}
        <span className="ml-auto" data-poll-status>
          {closed ? 'Closed' : static_ ? null : (left ?? 'Open')}
        </span>
      </div>
      <p className="mt-1.5 text-base font-medium break-words text-on-surface">
        <Masked text={poll.question} />
      </p>
      {live && <p className="text-xs text-on-surface-variant">{hint}</p>}
      {poll.kind === 'rating' ? (
        <Rating
          poll={poll}
          picked={picked}
          onPick={
            live
              ? v => {
                  setPicked([v])
                  void submit([v])
                }
              : null
          }
        />
      ) : (
        <ChoiceList poll={poll} picked={picked} onPick={choosing ? pick : null} live={choosing} />
      )}
      {choosing && poll.kind === 'ranked' && (
        <RankOrder
          poll={poll}
          order={picked}
          onMove={(id, by) => setPicked(cur => moveRank(cur, id, by))}
        />
      )}
      {poll.results === null && (
        <p className="mt-2 flex items-center gap-1.5 text-xs text-on-surface-variant">
          <EyeOff size={12} />
          {hiddenHint(poll)}
        </p>
      )}
      {poll.kind === 'ranked' && poll.results && poll.results.rounds.length > 0 && (
        <>
          <RunoffSummary poll={poll} closed={closed} />
          <button
            type="button"
            aria-expanded={rounds}
            onClick={() => setRounds(r => !r)}
            className="mt-2 flex items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {rounds ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
            {rounds ? 'Hide rounds' : `Show ${poll.results.rounds.length} rounds`}
          </button>
          {rounds && <Rounds poll={poll} />}
        </>
      )}
      {adding && <AddOption id={m.id} onDone={() => setAdding(false)} />}
      <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-on-surface-variant">
        <span data-poll-voters-count className="tabular-nums">
          {votersLabel(poll.voters)}
        </span>
        {votersShown(poll) && (
          <button
            type="button"
            onClick={() => openVoters(m)}
            className="font-medium text-primary hover:underline pointer-coarse:min-h-8"
          >
            View votes
          </button>
        )}
        {!static_ && !closed && canVote && voted && poll.allow_change && poll.kind !== 'rating' && (
          <button
            type="button"
            onClick={() => setEditing(e => !e)}
            className="font-medium text-primary hover:underline pointer-coarse:min-h-8"
          >
            {editing ? 'Cancel' : 'Change vote'}
          </button>
        )}
        {!static_ && !closed && canVote && voted && poll.allow_change && (
          <button
            type="button"
            onClick={() => void retractVote(m.id)}
            className="font-medium text-primary hover:underline pointer-coarse:min-h-8"
          >
            Remove vote
          </button>
        )}
        {canAdd && !adding && (
          <button
            type="button"
            onClick={() => setAdding(true)}
            className="flex items-center gap-0.5 font-medium text-primary hover:underline pointer-coarse:min-h-8"
          >
            <Plus size={12} />
            Add option
          </button>
        )}
        {manage && !static_ && (
          <button
            type="button"
            onClick={() => void (closed ? reopenPoll(m.id) : closePoll(m.id))}
            className="flex items-center gap-1 font-medium text-primary hover:underline pointer-coarse:min-h-8"
          >
            {closed ? <LockOpen size={12} /> : <Lock size={12} />}
            {closed ? 'Reopen' : 'Close poll'}
          </button>
        )}
        {choosing && (
          <button
            type="button"
            data-poll-submit
            disabled={!ready || busy}
            onClick={() => void submit()}
            className={`${filledBtn} ml-auto px-4 py-1.5`}
          >
            {voted ? 'Update vote' : 'Vote'}
          </button>
        )}
      </div>
    </div>
  )
}
