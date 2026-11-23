'use client'
import { useAccount, useStoreApi, useConn } from '../lib/client/react'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { device } from '../lib/platform'
import { ApiError } from '../lib/api'
import {
  activeOnArrival,
  guestDismissals,
  refreshDelay,
  type Announcement,
  type AnnouncementFeed,
} from '../lib/announcements'
import { errorText, useStore } from '../lib/store'
import { SettingSwitch } from './settings_fields'

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
    const elapsed = performance.now() - feed.received
    const timer = setTimeout(
      () => {
        setFeed(current =>
          current === feed
            ? {
                ...feed,
                announcements: feed.announcements.filter(
                  a => a.ends_at > feed.server_time + (performance.now() - feed.received) / 1000
                ),
              }
            : current
        )
      },
      Math.max(0, Math.min(2147483647, (next - feed.server_time) * 1000 - elapsed))
    )
    return () => clearTimeout(timer)
  }, [feed])
  useEffect(() => {
    let generation = 0
    let timer: ReturnType<typeof setTimeout>
    const mark = ownerSession.lifetime.sessionMark()
    async function load() {
      const id = ++generation
      clearTimeout(timer)
      const current = () => id === generation && mark === ownerSession.lifetime.sessionMark()
      if (!current()) return
      try {
        const received = performance.now()
        const data = await ownerSession.api.announcements()
        const elapsed = performance.now() - received
        if (!current()) return
        const hidden = guest ? guestDismissals(device().read(storageKey), data.server_time) : {}
        setFeed({
          received,
          ...data,
          announcements: activeOnArrival(data, elapsed).filter(a => !Object.hasOwn(hidden, a.id)),
        })
        timer = setTimeout(load, refreshDelay(data, elapsed))
      } catch (error) {
        if (!current()) return
        if (error instanceof ApiError && error.status === 404) {
          setFeed(null)
          return
        }
        timer = setTimeout(load, 5000)
      }
    }
    void load()
    const stop = guest ? device().watch?.(storageKey, load) : undefined
    for (const event of [refresh, 'online', 'focus']) window.addEventListener(event, load)
    return () => {
      ++generation
      clearTimeout(timer)
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
      className="max-h-[25dvh] shrink-0 overflow-y-auto bg-secondary-container px-safe text-on-secondary-container"
    >
      {feed.announcements.map(a => (
        <div
          key={a.id}
          className="mx-auto flex max-w-5xl items-center justify-between gap-4 px-4 py-1 text-sm"
        >
          <span className="min-w-0 break-words">{a.message}</span>
          <button
            title="Dismiss announcement"
            aria-label="Dismiss announcement"
            onClick={() => void dismiss(a)}
            className="grid size-11 shrink-0 place-items-center rounded-full hover:bg-on-secondary-container/10"
          >
            <X size={18} />
          </button>
        </div>
      ))}
    </section>
  )
}
