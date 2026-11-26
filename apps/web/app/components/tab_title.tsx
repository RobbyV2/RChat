'use client'

import { useEffect } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useP2p } from '../lib/client/p2p_react'
import { displayName } from '../lib/p2p/contacts'
import { serverUnread as p2pServerUnread } from '../lib/p2p/alerts'
import { notifications } from '../lib/platform'
import { dmTile, serverNames, serverUnread } from '../lib/selectors'
import { useMask, useStore } from '../lib/store'
import { hostedPlace, p2pPlace, tabMark, tabTitle, type TabPlace } from '../lib/tab_title'
import { useTotalInboxCount } from './inbox'

// The page's own title before this changes it: the app's name when the instance sent none.
const opening = typeof document === 'undefined' ? '' : document.title

// Names on screen go through the display filter, except your own server and your own DM.
const masked = (place: TabPlace, mask: (text: string) => string): TabPlace => {
  if (place.kind === 'app' || place.own) return place
  if (place.kind === 'dm') return { ...place, name: mask(place.name) }
  if (place.kind === 'server') return { ...place, server: mask(place.server) }
  return { ...place, server: mask(place.server), channel: mask(place.channel) }
}

// Keeps the tab title and the favicon dot on what is open and what waits: unseen notifications
// of every account, unread messages of the shown one (instance and P2P). Unmounting (a sign-out,
// the login page) puts back the app's name and the plain icon.
export function TabTitle() {
  const mask = useMask()
  const hosted = useStore(useShallow(hostedPlace))
  const p2p = useP2p(
    useShallow(s =>
      p2pPlace(s, ik => {
        const c = s.contacts.find(x => x.ik === ik)
        return c ? displayName(c) : null
      })
    )
  )
  const place = masked(p2p ?? hosted, mask)
  const brand = useStore(s => s.brand?.app_name ?? null)
  const app = brand ?? opening
  const streamer = useStore(s => s.streamer)
  const pings = useTotalInboxCount()
  const rooms = useP2p(s => s.rooms)
  const contacts = useP2p(s => s.contacts)
  const prefs = useStore(s => s.notifyPrefs)
  const dmUnread = useStore(s => dmTile(s, { rooms, contacts }).unread)
  const serversUnread = useStore(s => serverNames(s).some(n => serverUnread(s, n)))
  const roomsUnread = useP2p(s =>
    Object.values(s.servers).some(v => v.me === 'join' && p2pServerUnread(v, prefs))
  )
  const unread = dmUnread || serversUnread || roomsUnread
  const title = tabTitle(place, app, streamer, pings, unread)
  const mark = tabMark(pings, unread)
  useEffect(() => {
    notifications().setTitle(title)
  }, [title])
  useEffect(() => {
    notifications().setMark(mark)
  }, [mark])
  useEffect(
    () => () => {
      notifications().setTitle(app)
      notifications().setMark('none')
    },
    [app]
  )
  return null
}
