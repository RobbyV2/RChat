import { previewText } from './invite'
import type { UserRef } from './types'

// In-app toasts. Alerts from one conversation (`key`) stack into one toast that counts them and
// shows the newest. Each toast lives NOTICE_MS from its latest alert; the timer pauses while the
// user hovers or focuses the toasts.

export const NOTICE_MS = 5000
export const NOTICES_MAX = 3

// `since` is when the timer last started running, null while paused.
export interface NoticeTimer {
  left: number
  since: number | null
}

export interface AlertInput {
  key: string
  actor: UserRef | null
  // What the actor did, after their name ("mentioned you"); empty for a plain message.
  action: string
  // Raw message text; spoilers and markdown are masked when shown.
  body: string
  // Display names; `channel` without the #. Both null for a DM.
  server: string | null
  channel: string | null
  dm: boolean
  // Reactions are counted as notifications, everything else as messages.
  message: boolean
  // System notices ("You were removed from") put `lead` before `name` and never stack.
  lead?: string
  name: string
  // Desktop title in streamer mode.
  generic: string
  go: () => void
}

export interface Notice extends AlertInput {
  id: number
  count: number
  authors: string[]
  messages: boolean
  // Bumped when a new alert restarts the toast, so its progress bar starts over.
  gen: number
  timer: NoticeTimer
}

export const timeLeft = (t: NoticeTimer, now: number) =>
  t.since === null ? t.left : Math.max(0, t.left - (now - t.since))

export const pauseTimer = (t: NoticeTimer, now: number): NoticeTimer =>
  t.since === null ? t : { left: timeLeft(t, now), since: null }

export const resumeTimer = (t: NoticeTimer, now: number): NoticeTimer =>
  t.since === null ? { left: t.left, since: now } : t

const freshTimer = (now: number, paused: boolean): NoticeTimer => ({
  left: NOTICE_MS,
  since: paused ? null : now,
})

// Adds an alert: it joins the toast for its conversation (moved to the newest place, timer
// restarted) or becomes a new toast; only the newest NOTICES_MAX stay.
export const addNotice = (
  list: Notice[],
  alert: AlertInput,
  id: number,
  now: number,
  paused: boolean
): Notice[] => {
  const author = alert.actor?.username
  const prev = alert.lead === undefined ? list.find(n => n.key === alert.key) : undefined
  const next: Notice = prev
    ? {
        ...alert,
        id: prev.id,
        count: prev.count + 1,
        authors:
          author && !prev.authors.includes(author)
            ? [...prev.authors, author].slice(-5)
            : prev.authors,
        messages: prev.messages && alert.message,
        gen: prev.gen + 1,
        timer: freshTimer(now, paused),
      }
    : {
        ...alert,
        id,
        count: 1,
        authors: author ? [author] : [],
        messages: alert.message,
        gen: 0,
        timer: freshTimer(now, paused),
      }
  return [...list.filter(n => n !== prev), next].slice(-NOTICES_MAX)
}

export const pauseNotices = (list: Notice[], paused: boolean, now: number) =>
  list.map(n => ({ ...n, timer: paused ? pauseTimer(n.timer, now) : resumeTimer(n.timer, now) }))

export const liveNotices = (list: Notice[], now: number) => {
  const kept = list.filter(n => timeLeft(n.timer, now) > 0)
  return kept.length === list.length ? list : kept
}

// Milliseconds until the next running toast ends; null when none is running.
export const nextNoticeEnd = (list: Notice[], now: number) =>
  list.reduce<number | null>((min, n) => {
    if (n.timer.since === null) return min
    const left = timeLeft(n.timer, now)
    return min === null || left < min ? left : min
  }, null)

// Text pieces; `blur` pieces are names and get the streamer class.
export interface Piece {
  text: string
  blur?: boolean
}

export const headline = (n: Notice): Piece[] => {
  if (n.lead !== undefined) return [{ text: `${n.lead} ` }, { text: n.name, blur: true }]
  if (n.count === 1)
    return [{ text: n.name, blur: true }, ...(n.action ? [{ text: ` ${n.action}` }] : [])]
  const what = `${n.count} new ${n.messages ? 'messages' : 'notifications'}`
  if (n.authors.length <= 1) return [{ text: `${what} from ` }, { text: n.name, blur: true }]
  if (n.channel !== null) return [{ text: `${what} in ` }, { text: `#${n.channel}`, blur: true }]
  return [{ text: what }]
}

export const context = (n: Notice): Piece[] => {
  if (n.lead !== undefined) return []
  if (n.dm) return [{ text: 'Direct message' }]
  const out: Piece[] = []
  if (n.server !== null) out.push({ text: n.server, blur: true })
  if (n.channel !== null) {
    if (out.length) out.push({ text: ' · ' })
    out.push({ text: `#${n.channel}`, blur: true })
  }
  return out
}

const BLOCKS = (inner: string) => '█'.repeat(Math.min(8, Math.max(3, inner.trim().length)))

// Message text for a toast or system notification: markdown and spoilers masked, including a
// spoiler cut open by a short excerpt. Streamer mode shows no text at all.
export const alertBody = (body: string, streamer: boolean) => {
  if (streamer) return ''
  return previewText(body)
    .replace(/\|\|([\s\S]*)$/, (_, inner: string) => (inner.trim() ? BLOCKS(inner) : ''))
    .trim()
}

const plain = (pieces: Piece[]) => pieces.map(p => p.text).join('')

// The system notification for a toast, from the same pieces the toast shows.
export const desktopText = (n: Notice, streamer: boolean) => {
  if (streamer) return { title: n.generic, body: '' }
  const named = n.count > 1 && n.authors.length > 1
  const where = n.channel !== null && n.lead === undefined && !named ? ` in #${n.channel}` : ''
  return { title: `${plain(headline(n))}${where}`, body: alertBody(n.body, false) }
}
