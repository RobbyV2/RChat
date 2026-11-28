import { ask, sendTo } from './asks'
import { orMissing } from './api_errors'
import type { Cancel } from './clock'
import type { AccountSession } from './client/session'
import { fromRequest, type Load } from './load'
import { persistently } from './own_loads'
import type { Live } from './place/live'
import { device } from './platform'
import { jsonObject, jsonOr } from './schema'

export interface Announcement {
  id: string
  message: string
  starts_at: number
  ends_at: number
}
export interface AnnouncementFeed {
  server_time: number
  next_change: number | null
  announcements: Announcement[]
}

export function activeOnArrival(feed: AnnouncementFeed, elapsedMs: number) {
  const at = feed.server_time + elapsedMs / 1000
  return feed.announcements.filter(a => a.ends_at > at)
}

export function refreshDelay(feed: AnnouncementFeed, elapsedMs = 0) {
  return Math.min(
    30000,
    Math.max(
      250,
      ((feed.next_change ?? feed.server_time + 30) - feed.server_time) * 1000 - elapsedMs
    )
  )
}

export function guestDismissals(raw: string | null, now: number): Record<string, number> {
  try {
    const parsed: unknown = jsonOr(raw, jsonObject, {})
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, end]) => typeof end === 'number' && end > now)
    )
  } catch {
    return {}
  }
}

// How often a feed that was refused is asked for again, after its quiet tries.
export const FEED_RETRY_MS = 60_000
const TIMER_MAX = 2147483647

// The announcements on screen, with the instance's time when they arrived and this device's.
export interface ShownFeed {
  announcements: Announcement[]
  serverTime: number
  received: number
}

export interface AnnouncementSource extends Live<Load<ShownFeed>> {
  // Asks again, keeping what is on screen.
  refresh(): void
  // Hides one announcement for this viewer: on the instance for an account, on this device for a
  // guest. Refused with what went wrong.
  dismiss(announcement: Announcement): Promise<void>
}

const never = new Promise<never>(() => {})

// The announcements of the account's instance. The feed asks again when the instance says the
// next change is due, drops each announcement when it ends, and after a failure tries again on
// its own: quietly a few times, then with the refusal on screen. An instance without
// announcements has none. `storageKey` holds a guest's dismissals on this device.
export const announcementSource = (
  account: AccountSession,
  guest: boolean,
  storageKey: string
): AnnouncementSource => {
  const time = account.time
  const mark = account.lifetime.sessionMark()
  const current = () => mark === account.lifetime.sessionMark()
  let again: Cancel | null = null
  let ending: Cancel | null = null
  let watchers = 0
  let serverTime = 0
  const later = (ms: number) => {
    again?.()
    again = time.after(Math.min(TIMER_MAX, ms), () => source.refresh())
  }
  const active = (feed: ShownFeed) => {
    const at = feed.serverTime + (time.elapsed() - feed.received) / 1000
    return feed.announcements.filter(a => a.ends_at > at)
  }
  // Drops what has ended when the next announcement ends.
  const watchEnds = (feed: ShownFeed) => {
    ending?.()
    ending = null
    if (!feed.announcements.length) return
    const next = Math.min(...feed.announcements.map(a => a.ends_at))
    const left = (next - feed.serverTime) * 1000 - (time.elapsed() - feed.received)
    ending = time.after(Math.max(0, Math.min(TIMER_MAX, left)), () =>
      source.change(shown => {
        const kept = { ...shown, announcements: active(shown) }
        watchEnds(kept)
        return kept
      })
    )
  }
  const fetchFeed = async (): Promise<ShownFeed> => {
    const received = time.elapsed()
    const data = await sendTo(account, ask.announcements()).catch(orMissing(null))
    if (!current()) return never
    if (data === null) return { announcements: [], serverTime: 0, received }
    const elapsed = time.elapsed() - received
    serverTime = data.server_time
    const hidden = guest ? guestDismissals(device().read(storageKey), data.server_time) : {}
    later(refreshDelay(data, elapsed))
    return {
      announcements: activeOnArrival(data, elapsed).filter(a => !Object.hasOwn(hidden, a.id)),
      serverTime: data.server_time,
      received,
    }
  }
  const source = fromRequest<ShownFeed>(
    time,
    () =>
      persistently(time, fetchFeed, { firstMs: 5000, live: current }).then(
        feed => {
          watchEnds(feed)
          return feed
        },
        (error: unknown) => {
          if (!current()) return never
          later(FEED_RETRY_MS)
          throw error
        }
      ),
    { empty: feed => feed.announcements.length === 0, deadlineMs: 60_000 }
  )
  return {
    get: source.get,
    subscribe: changed => {
      const stop = source.subscribe(changed)
      watchers += 1
      // A feed that is watched again after a pause holds what it had: ask for what changed.
      if (watchers === 1 && again === null && source.get().status !== 'loading') later(0)
      return () => {
        stop()
        watchers -= 1
        if (watchers > 0) return
        again?.()
        ending?.()
        again = ending = null
      }
    },
    refresh: source.refresh,
    dismiss: async announcement => {
      if (guest) {
        const hidden = guestDismissals(device().read(storageKey), serverTime)
        const saved = device().write(
          storageKey,
          JSON.stringify({ ...hidden, [announcement.id]: announcement.ends_at })
        )
        if (!saved) throw new Error('Could not save the dismissal.')
      } else await sendTo(account, ask.dismissAnnouncement(announcement.id))
      if (!current()) return
      source.change(shown => ({
        ...shown,
        announcements: shown.announcements.filter(a => a.id !== announcement.id),
      }))
    },
  }
}
