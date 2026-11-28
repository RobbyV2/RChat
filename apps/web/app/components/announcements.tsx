'use client'
import { IconButton } from './controls'
import { Row, Surface } from './layout'
import { useAccount, useStoreApi, useConn } from '../lib/client/react'
import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { X } from 'lucide-react'
import { device } from '../lib/platform'
import { announcementSource, type Announcement } from '../lib/announcements'
import { Loaded, useLoad, useRefreshOn } from './loaded'
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
const FEED_EVENTS = [refresh, 'online']

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
  const account = useAccount()
  const brand = useStore(s => s.brand)
  const source = useMemo(
    () => announcementSource(account, guest, storageKey),
    [account, brand, guest, storageKey]
  )
  const load = useLoad(source)
  useRefreshOn(source, { front: true, events: FEED_EVENTS })
  useEffect(() => {
    if (guest) return device().watch?.(storageKey, () => source.refresh())
  }, [source, guest, storageKey])
  const dismiss = (a: Announcement) => {
    const mark = account.lifetime.sessionMark()
    source.dismiss(a).then(changed, (error: unknown) => {
      if (mark === account.lifetime.sessionMark())
        account.store.getState().setError(errorText(error))
    })
  }
  return (
    <Loaded load={load} skeleton={null} empty={null} what="announcements">
      {feed => (
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
                  onClick={() => dismiss(a)}
                />
              </Row>
            </Surface>
          ))}
        </section>
      )}
    </Loaded>
  )
}
