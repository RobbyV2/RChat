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
    const parsed: unknown = JSON.parse(raw ?? '{}')
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).filter(([, end]) => typeof end === 'number' && end > now)
    )
  } catch {
    return {}
  }
}
