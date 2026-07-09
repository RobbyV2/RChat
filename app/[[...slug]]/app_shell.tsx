'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '../lib/store'
import { ContextMenu } from '../components/context_menu'
import { ServerRail } from '../components/server_rail'
import { ChannelSidebar } from '../components/channel_sidebar'
import { MessagePane } from '../components/message_pane'
import { ServerDialogs } from '../components/server_dialogs'
import MemberSidebar from '../components/member_sidebar'
import AdminPanel from '../components/admin_panel'
import ServerSettings from '../components/server_settings'
import SettingsMenu from '../components/settings_menu'
import ThreadPanel from '../components/thread_panel'
import SearchPanel from '../components/search_panel'
import { CallBanner } from '../components/voice_grid'

export default function AppShell() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const dialog = useStore(s => s.activeDialog)
  const panel = useStore(s => s.panel)
  const notices = useStore(s => s.notices)
  const dismissNotice = useStore(s => s.dismissNotice)
  const error = useStore(s => s.error)
  const bootstrap = useStore(s => s.bootstrap)
  const booted = useRef(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    useStore.getState().setStreamer(localStorage.getItem('rchat_streamer') === '1')
    const authed = localStorage.getItem('rchat_token') || localStorage.getItem('rchat_guest')
    if (!authed) {
      router.replace('/login')
      return
    }
    void bootstrap()
  }, [router, bootstrap])

  const guestBlocked = useStore(s => s.guest && !s.settings.guests_enabled)
  useEffect(() => {
    if (!guestBlocked) return
    useStore.getState().logout()
    useStore.getState().setError('Guest access is disabled')
    router.replace('/login')
  }, [guestBlocked, router])

  useEffect(() => {
    const onPop = () => void useStore.getState().syncFromUrl('none')
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])

  useEffect(() => {
    setLeftOpen(false)
    setRightOpen(false)
    if (useStore.getState().panel?.kind === 'thread') useStore.getState().closePanel()
  }, [view])

  useEffect(() => {
    if (dialog) {
      setLeftOpen(false)
      setRightOpen(false)
    }
  }, [dialog])

  if (!me && !guest) {
    return (
      <div className="flex h-dvh items-center justify-center text-on-surface-variant">
        Loading RChat
      </div>
    )
  }

  const isChannel = view?.kind === 'channel'

  return (
    <div className="flex h-dvh overflow-hidden">
      <div className="hidden h-full md:flex">
        <ServerRail />
        <ChannelSidebar />
      </div>
      <MessagePane
        onMenu={() => {
          setRightOpen(false)
          setLeftOpen(true)
        }}
        onMembers={() => {
          setLeftOpen(false)
          setRightOpen(o => !o)
        }}
      />
      {isChannel && !panel && (
        <div className="hidden h-full lg:block">
          <MemberSidebar />
        </div>
      )}
      {panel && (
        <div className="fixed inset-0 z-40 bg-surface md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-outline-variant">
          {panel.kind === 'thread' ? <ThreadPanel /> : <SearchPanel />}
        </div>
      )}
      {leftOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden">
          <div className="flex h-full shadow-elevation-3">
            <ServerRail />
            <ChannelSidebar />
          </div>
          <div className="flex-1 bg-scrim/50" onClick={() => setLeftOpen(false)} />
        </div>
      )}
      {rightOpen && isChannel && (
        <div className="fixed inset-0 z-40 flex justify-end lg:hidden">
          <div className="flex-1 bg-scrim/50" onClick={() => setRightOpen(false)} />
          <div className="h-full shadow-elevation-3">
            <MemberSidebar />
          </div>
        </div>
      )}
      <ServerDialogs />
      <ServerSettings />
      <SettingsMenu />
      <AdminPanel />
      <ContextMenu />
      <CallBanner />
      {notices.length > 0 && (
        <div className="fixed top-16 right-4 z-50 flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
          {notices.map(n => (
            <button
              key={n.id}
              onClick={() => {
                dismissNotice(n.id)
                n.go()
              }}
              className="rounded-xl bg-surface-container-high p-3 text-left shadow-elevation-2 hover:bg-surface-container-highest"
            >
              <p className="truncate text-sm font-medium">{n.title}</p>
              <p className="truncate text-xs text-on-surface-variant">{n.body}</p>
            </button>
          ))}
        </div>
      )}
      {error && (
        <div className="fixed bottom-4 left-1/2 z-60 -translate-x-1/2 rounded-xl bg-error-container px-4 py-2 text-sm text-on-error-container shadow-elevation-2">
          {error}
        </div>
      )}
    </div>
  )
}
