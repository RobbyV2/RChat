'use client'
import { IconButton } from './controls'
import { Row, Surface } from './layout'
import { useAccount, useStoreApi, useConn } from '../lib/client/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { device } from '../lib/platform'
import { background, missing } from '../lib/api_errors'
import {
  activeOnArrival,
  guestDismissals,
  refreshDelay,
  type Announcement,
  type AnnouncementFeed,
} from '../lib/announcements'
import { errorText, useStore } from '../lib/store'
import { SettingSwitch } from './settings_fields'
import { time } from '../lib/platform/time'
import type { Cancel } from '../lib/clock'

const preference = 'rchat_announcements_off_v1'
const refresh = 'rchat-announcements'
const changed = () => window.dispatchEvent(new Event(refresh))
function subscribe(fn: () => void) {
  window.addEventListener(refresh, fn)
  const stop = device().watch?.(preference, fn)
  return () => {
    window.removeEventListener(refresh, fn)
    stop?.()
  }
}
const enabled = () => device().read(preference) !== '1'
const initial = () => true

export function AnnouncementSetting() {
  const store = useStoreApi()
  const on = useSyncExternalStore(subscribe, enabled, initial)
  return (
    <SettingSwitch
      label="Show instance announcements on this device"
      value={on}
      onChange={v => {
        if (!device().write(preference, v ? null : '1'))
          store.getState().setError('Could not save the setting.')
        changed()
      }}
    />
  )
}

export function AnnouncementBanner() {
  const conn = useConn()
  const on = useSyncExternalStore(subscribe, enabled, initial)
  const user = useStore(s => s.me?.username)
  const guest = useStore(s => s.guest && !s.token && !s.me)
  const origin = useStore(() => conn.origin)
  return on && (guest || user) ? (
    <Feed
      key={JSON.stringify([origin, user])}
      guest={guest}
      storageKey={conn.scoped('rchat_announcement_dismissals_v1')}
    />
  ) : null
}

function Feed({ guest, storageKey }: { guest: boolean; storageKey: string }) {
  const ownerSession = useAccount()
  const brand = useStore(s => s.brand)
  const [feed, setFeed] = useState<(AnnouncementFeed & { received: number }) | null>(null)
  useEffect(() => {
    if (!feed?.announcements.length) return
    const next = Math.min(...feed.announcements.map(a => a.ends_at))
    const elapsed = time().elapsed() - feed.received
    const timer = time().after(
      Math.max(0, Math.min(2147483647, (next - feed.server_time) * 1000 - elapsed)),
      () => {
        setFeed(current =>
          current === feed
            ? {
                ...feed,
                announcements: feed.announcements.filter(
                  a => a.ends_at > feed.server_time + (time().elapsed() - feed.received) / 1000
                ),
              }
            : current
        )
      }
    )
    return () => timer?.()
  }, [feed])
  useEffect(() => {
    let generation = 0
    let timer: Cancel
    const mark = ownerSession.lifetime.sessionMark()
    async function load() {
      const id = ++generation
      timer?.()
      const current = () => id === generation && mark === ownerSession.lifetime.sessionMark()
      if (!current()) return
      try {
        const received = time().elapsed()
        const data = await ownerSession.api.announcements()
        const elapsed = time().elapsed() - received
        if (!current()) return
        const hidden = guest ? guestDismissals(device().read(storageKey), data.server_time) : {}
        setFeed({
          received,
          ...data,
          announcements: activeOnArrival(data, elapsed).filter(a => !Object.hasOwn(hidden, a.id)),
        })
        timer = time().after(refreshDelay(data, elapsed), load)
      } catch (error) {
        if (!current()) return
        if (missing(error)) {
          setFeed(null)
          return
        }
        background('loading announcements failed')(error)
        timer = time().after(5000, load)
      }
    }
    void load()
    const stop = guest ? device().watch?.(storageKey, load) : undefined
    for (const event of [refresh, 'online', 'focus']) window.addEventListener(event, load)
    return () => {
      ++generation
      timer?.()
      stop?.()
      for (const event of [refresh, 'online', 'focus']) window.removeEventListener(event, load)
    }
  }, [ownerSession, brand, guest, storageKey])

  async function dismiss(a: Announcement) {
    const mark = ownerSession.lifetime.sessionMark()
    try {
      if (guest) {
        const hidden = guestDismissals(device().read(storageKey), feed?.server_time ?? 0)
        if (!device().write(storageKey, JSON.stringify({ ...hidden, [a.id]: a.ends_at })))
          throw new Error('Could not save the dismissal.')
      } else await ownerSession.api.dismissAnnouncement(a.id)
      if (mark !== ownerSession.lifetime.sessionMark()) return
      setFeed(f => f && { ...f, announcements: f.announcements.filter(item => item.id !== a.id) })
      changed()
    } catch (error) {
      if (mark === ownerSession.lifetime.sessionMark())
        ownerSession.store.getState().setError(errorText(error))
    }
  }
  if (!feed?.announcements.length) return null
  return (
    <section
      aria-label="Instance announcements"
      className="max-h-dvh-25 shrink-0 overflow-y-auto bg-secondary-container safe-x text-on-secondary-container"
    >
      {feed.announcements.map(a => (
        <Surface
          key={a.id}
          tone="plain"
          radius="none"
          pad="lg"
          inset="bar"
          place="mx-auto max-w-5xl"
        >
          <Row gap="lg" justify="between">
            <span className="min-w-0 break-words text-sm">{a.message}</span>
            <IconButton
              icon={X}
              label="Dismiss announcement"
              tone="inherit"
              size="lg"
              onClick={() => void dismiss(a)}
            />
          </Row>
        </Surface>
      ))}
    </section>
  )
}
