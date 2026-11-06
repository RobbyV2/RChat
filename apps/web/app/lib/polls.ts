// Polls: drafts for the create dialog, ballots, counts and the merge rules for live updates.

import type { PollReq } from './api'
import { plural } from './bytes'
import type { Poll, PollKind, PollOption, ShowResults } from './types'

// The voter list is open: a live poll, not anonymous, with results you can see and votes.
export const votersShown = (p: Poll | null | undefined) =>
  !!p && !p.snapshot && !p.anonymous && p.results !== null && p.voters > 0

// Closed by hand or by its end time.
export const pollClosed = (p: Poll, nowSec = Date.now() / 1000) =>
  p.closed || (p.closes_at !== null && p.closes_at <= nowSec)

export const POLL_QUESTION_MAX = 300
export const POLL_OPTION_MAX = 100
export const POLL_OPTIONS_MIN = 2
export const POLL_OPTIONS_MAX = 20
export const POLL_DURATION_MIN = 60
export const POLL_DURATION_MAX = 30 * 86400

export const KIND_LABELS: Record<PollKind, string> = {
  single: 'Single choice',
  multiple: 'Multiple choice',
  ranked: 'Ranked choice',
  rating: 'Rating scale',
  yes_no: 'Yes / No',
}

export const KIND_HINTS: Record<PollKind, string> = {
  single: 'Pick one',
  multiple: 'Pick several',
  ranked: 'Rank in order',
  rating: 'Give a score',
  yes_no: 'Yes, No or Abstain',
}

export const RESULTS_LABELS: Record<ShowResults, string> = {
  always: 'Always',
  after_vote: 'After voting',
  after_close: 'When closed',
}

export const DURATION_PRESETS: { label: string; seconds: number | null }[] = [
  { label: '1 hour', seconds: 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '3 days', seconds: 3 * 86400 },
  { label: '1 week', seconds: 7 * 86400 },
  { label: 'None', seconds: null },
]

// The kinds whose options the author writes.
export const writtenKind = (kind: PollKind) =>
  kind === 'single' || kind === 'multiple' || kind === 'ranked'

export interface DraftOption {
  text: string
  emoji: string | null
}

export interface PollDraft {
  question: string
  kind: PollKind
  options: DraftOption[]
  anonymous: boolean
  showResults: ShowResults
  allowChange: boolean
  allowAdd: boolean
  minChoices: number
  // null: as many as there are options
  maxChoices: number | null
  scale: 5 | 10
  // seconds from posting; null for no deadline
  duration: number | null
}

export const emptyDraft = (): PollDraft => ({
  question: '',
  kind: 'single',
  options: [
    { text: '', emoji: null },
    { text: '', emoji: null },
  ],
  anonymous: false,
  showResults: 'always',
  allowChange: true,
  allowAdd: false,
  minChoices: 1,
  maxChoices: null,
  scale: 5,
  duration: 86400,
})

const filled = (d: PollDraft) => d.options.filter(o => o.text.trim())

// Why the draft can't be posted yet, or null.
export function draftError(d: PollDraft): string | null {
  const question = d.question.trim()
  if (!question) return 'Add a question'
  if ([...question].length > POLL_QUESTION_MAX)
    return `The question can be up to ${POLL_QUESTION_MAX} characters`
  if (writtenKind(d.kind)) {
    const options = filled(d)
    if (options.length < POLL_OPTIONS_MIN) return 'Add at least 2 options'
    if (options.length > POLL_OPTIONS_MAX) return `Up to ${POLL_OPTIONS_MAX} options`
    if (options.some(o => [...o.text.trim()].length > POLL_OPTION_MAX))
      return `Options can be up to ${POLL_OPTION_MAX} characters`
    const seen = new Set(options.map(o => o.text.trim().toLowerCase()))
    if (seen.size !== options.length) return 'Options must be different'
    if (d.kind === 'multiple') {
      const max = d.maxChoices ?? options.length
      if (d.minChoices < 1 || d.minChoices > options.length || max < d.minChoices)
        return 'Check the number of choices'
      if (max > options.length) return 'Check the number of choices'
    }
  }
  if (
    d.duration !== null &&
    (!Number.isFinite(d.duration) ||
      d.duration < POLL_DURATION_MIN ||
      d.duration > POLL_DURATION_MAX)
  )
    return 'The deadline can be 1 minute to 30 days away'
  return null
}

export function draftRequest(d: PollDraft): PollReq {
  const written = writtenKind(d.kind)
  const options = written
    ? filled(d).map(o => ({ text: o.text.trim(), ...(o.emoji ? { emoji: o.emoji } : {}) }))
    : []
  return {
    question: d.question.trim(),
    kind: d.kind,
    options,
    anonymous: d.anonymous,
    show_results: d.showResults,
    allow_change: d.allowChange,
    allow_add: written && d.allowAdd,
    ...(d.kind === 'multiple'
      ? { min_choices: d.minChoices, max_choices: d.maxChoices ?? options.length }
      : {}),
    ...(d.kind === 'rating' ? { scale: d.scale } : {}),
    duration_seconds: d.duration,
  }
}

export const percent = (count: number, total: number) =>
  total > 0 ? Math.round((count * 100) / total) : 0

// "3 hours left" style text for an open poll with a deadline; null without one.
export function timeLeft(closesAt: number | null, now: number): string | null {
  if (closesAt === null) return null
  const left = closesAt - now
  if (left <= 0) return 'Closing'
  if (left < 60) return 'Less than a minute left'
  if (left < 3600) return `${plural(Math.floor(left / 60), 'minute')} left`
  if (left < 86400) return `${plural(Math.floor(left / 3600), 'hour')} left`
  return `${plural(Math.floor(left / 86400), 'day')} left`
}

export const votersLabel = (n: number) => plural(n, 'vote')

// The hint shown while counts are hidden.
export function hiddenHint(poll: Poll): string {
  if (poll.show_results === 'after_close') return 'Results show when the poll closes'
  return poll.mine ? 'Results are loading' : 'Vote to see the results'
}

// A newer copy of a poll the store holds (a live update or a replaced message): keep the
// viewer's own vote and, when the copy hides counts the viewer may see (they voted on an
// after-vote poll), the counts they had.
export function mergePoll(local: Poll | null | undefined, incoming: Poll): Poll {
  if (!local || local.snapshot || incoming.snapshot) return incoming
  const keep = incoming.results === null && keepsCounts(local, incoming)
  return {
    ...incoming,
    mine: local.mine,
    results: keep ? local.results : incoming.results,
  }
}

// Whether a copy leaves out counts this viewer may see (the server sends them to voters in
// their own events and responses, so the ones held stay valid until then).
export const keepsCounts = (local: Poll | null | undefined, incoming: Poll) =>
  incoming.results === null &&
  !incoming.closed &&
  incoming.show_results === 'after_vote' &&
  !!local?.mine?.length

// Selecting an option in a single or multiple choice ballot.
export function toggleChoice(picked: number[], id: number, poll: Poll): number[] {
  if (poll.kind !== 'multiple') return [id]
  if (picked.includes(id)) return picked.filter(x => x !== id)
  if (picked.length >= poll.max_choices) return picked
  return [...picked, id]
}

// Ranking: tapping an unranked option gives it the next rank, tapping a ranked one unranks it.
export const toggleRank = (order: number[], id: number) =>
  order.includes(id) ? order.filter(x => x !== id) : [...order, id]

export function moveRank(order: number[], id: number, by: -1 | 1): number[] {
  const i = order.indexOf(id)
  const j = i + by
  if (i === -1 || j < 0 || j >= order.length) return order
  const next = [...order]
  next[i] = order[j]
  next[j] = id
  return next
}

// Whether `picked` is a ballot the server takes.
export function ballotReady(poll: Poll, picked: number[]): boolean {
  switch (poll.kind) {
    case 'single':
    case 'yes_no':
      return picked.length === 1
    case 'multiple':
      return picked.length >= poll.min_choices && picked.length <= poll.max_choices
    case 'ranked':
      return picked.length >= 1
    case 'rating':
      return picked.length === 1 && picked[0] >= 1 && picked[0] <= (poll.scale ?? 5)
  }
}

export const sameBallot = (a: number[] | null, b: number[]) =>
  !!a && a.length === b.length && a.every((x, i) => x === b[i])

export const ballotBody = (poll: Poll, picked: number[]) =>
  poll.kind === 'rating' ? { value: picked[0] } : { options: picked }

export const countOf = (poll: Poll, id: number) =>
  poll.results?.counts.find(c => c.option_id === id)?.count ?? 0

export const optionLabel = (o: PollOption) => (o.emoji ? `${o.emoji} ${o.text}` : o.text)

// The ranked-choice rounds as rows: every option with its tally (null once out).
export function runoffRows(poll: Poll) {
  const rounds = poll.results?.rounds ?? []
  return rounds.map((round, i) => {
    const counted = round.counts.reduce((n, c) => n + c.count, 0)
    return {
      n: i + 1,
      counted,
      exhausted: round.exhausted,
      eliminated: round.eliminated,
      rows: round.counts.map(c => ({
        option: poll.options.find(o => o.id === c.option_id),
        count: c.count,
        share: percent(c.count, counted),
      })),
    }
  })
}
