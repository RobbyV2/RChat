'use client'

import { useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { allPings, useStore } from '../lib/store'
import { notifications } from '../lib/platform'
import { home } from '../lib/instances'
import { ContextMenu } from '../components/context_menu'
import { ReactionPickerHost } from '../components/reactions'
import { ProfileCard } from '../components/profile_card'
import { ServerRail } from '../components/server_rail'
import { ChannelSidebar } from '../components/channel_sidebar'
import { MessagePane } from '../components/message_pane'
import { ServerDialogs } from '../components/server_dialogs'
import { FolderDialog } from '../components/folder_dialog'
import { CategoryDialog } from '../components/category_dialog'
import MemberSidebar from '../components/member_sidebar'
import AdminPanel from '../components/admin_panel'
import ServerSettings, { ConfirmDialog } from '../components/server_settings'
import AuditLogDialog from '../components/audit_log'
import SettingsMenu from '../components/settings_menu'
import ThreadPanel from '../components/thread_panel'
import SearchPanel from '../components/search_panel'
import { CallBanner } from '../components/voice_grid'
import { NoticeStack } from '../components/notice_stack'
import { InvitePage } from '../components/invite_card'
import { ConfigLinkPage } from '../components/config_sync'
import { useEscape } from '../components/ui'

const bannerCls =
  'pointer-events-auto max-w-full self-center rounded-xl px-4 py-2 text-center text-sm shadow-elevation-2 sm:fixed sm:top-[calc(var(--safe-top)+4rem)] sm:left-1/2 sm:z-60 sm:w-max sm:max-w-[calc(100vw-2rem)] sm:-translate-x-1/2'

export default function AppShell() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const invite = useStore(s => s.invite)
  const configLink = useStore(s => s.configLink)
  const dialog = useStore(s => s.activeDialog)
  const confirming = useStore(s => s.confirm !== null)
  const panel = useStore(s => s.panel)
  const toast = useStore(s => s.toast)
  const error = useStore(s => s.error)
  const bootError = useStore(s => s.bootError)
  const bootstrap = useStore(s => s.bootstrap)
  const pings = useStore(allPings)
  const booted = useRef(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)

  useEscape(() => {
    setLeftOpen(false)
    setRightOpen(false)
  }, 'panel')

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    useStore.getState().setStreamer(localStorage.getItem('rchat_streamer') === '1')
    const authed =
      localStorage.getItem(home.scoped('rchat_token')) ||
      localStorage.getItem(home.scoped('rchat_guest'))
    if (!authed) {
      const { syncInvite, syncConfigLink, loadSettings } = useStore.getState()
      if (syncInvite() || syncConfigLink()) void loadSettings()
      else router.replace('/login')
      return
    }
    void bootstrap()
  }, [router, bootstrap])

  useEffect(() => {
    notifications().setBadge(pings)
  }, [pings])

  const guestBlocked = useStore(s => s.guest && !s.settings.guests_enabled)
  useEffect(() => {
    if (!guestBlocked) return
    useStore.getState().logout()
    useStore.getState().setError('Guest access is disabled')
    router.replace('/login')
  }, [guestBlocked, router])

  const authExpired = useStore(s => s.authExpired)
  useEffect(() => {
    if (!authExpired) return
    useStore.setState({ authExpired: false })
    useStore.getState().setError('Your session has ended. Please sign in again.')
    router.replace('/login')
  }, [authExpired, router])

  useEffect(() => {
    const onPop = () => void useStore.getState().syncFromUrl('none')
    const onStorage = (e: StorageEvent) => {
      if (e.key?.startsWith('rchat_layout:')) useStore.getState().reloadLayout()
      if (e.key?.startsWith('rchat_emoji:')) useStore.getState().reloadEmoji()
      if (e.key?.startsWith('rchat_forward:')) useStore.getState().reloadForward()
      if (e.key?.startsWith('rchat_notify:')) useStore.getState().reloadNotify()
      if (e.key?.startsWith('rchat_typing:')) useStore.getState().reloadTyping()
    }
    const onWake = () => {
      if (document.visibilityState === 'visible') useStore.getState().pruneNotify()
    }
    window.addEventListener('popstate', onPop)
    window.addEventListener('storage', onStorage)
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    return () => {
      window.removeEventListener('popstate', onPop)
      window.removeEventListener('storage', onStorage)
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
    }
  }, [])

  useEffect(() => {
    setLeftOpen(false)
    setRightOpen(false)
    if (useStore.getState().panel?.kind === 'thread') useStore.getState().closePanel()
  }, [view])

  useEffect(() => {
    if (dialog || confirming) {
      setLeftOpen(false)
      setRightOpen(false)
    }
  }, [dialog, confirming])

  if (!me && !guest) {
    return (
      <>
        {!invite && !configLink && (
          <div className="flex h-app flex-col items-center justify-center gap-1 px-6 text-center text-on-surface-variant">
            <span>Loading RChat</span>
            {bootError && <span className="text-sm">{bootError}. Retrying…</span>}
          </div>
        )}
        <InvitePage />
        <ConfigLinkPage />
      </>
    )
  }

  const isChannel = view?.kind === 'channel'

  return (
    <>
      <div className="flex h-app overflow-hidden px-safe">
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
          <div className="fixed inset-x-0 top-app z-40 h-app bg-surface max-md:px-safe md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-outline-variant">
            {panel.kind === 'thread' ? <ThreadPanel /> : <SearchPanel />}
          </div>
        )}
        {leftOpen && (
          <div data-drawer className="fixed inset-x-0 top-app z-40 flex h-app md:hidden">
            <div className="flex h-full bg-surface-container-lowest pl-[env(safe-area-inset-left)] shadow-elevation-3">
              <ServerRail />
              <ChannelSidebar />
            </div>
            <div className="flex-1 bg-scrim/50" onClick={() => setLeftOpen(false)} />
          </div>
        )}
        {rightOpen && isChannel && (
          <div
            data-drawer
            className="fixed inset-x-0 top-app z-40 flex h-app justify-end lg:hidden"
          >
            <div className="flex-1 bg-scrim/50" onClick={() => setRightOpen(false)} />
            <div className="h-full bg-surface-container-low pr-[env(safe-area-inset-right)] shadow-elevation-3">
              <MemberSidebar />
            </div>
          </div>
        )}
        <ServerDialogs />
        <FolderDialog />
        <CategoryDialog />
        <ServerSettings />
        <AuditLogDialog />
        <SettingsMenu />
        <AdminPanel />
        <ConfirmDialog />
        <ProfileCard />
        <ContextMenu />
        <ReactionPickerHost />
        <CallBanner />
        <div className="pointer-events-none fixed inset-x-4 top-[calc(var(--safe-top)+4rem)] z-60 flex flex-col gap-2 sm:contents">
          {error && (
            <div role="alert" className={`${bannerCls} bg-error-container text-on-error-container`}>
              {error}
            </div>
          )}
          {toast && !error && (
            <div
              role="status"
              className={`${bannerCls} bg-inverse-surface text-inverse-on-surface`}
            >
              {toast.text}
              {toast.name && (
                <>
                  {' '}
                  <span className="streamer font-medium">{toast.name}</span>
                </>
              )}
            </div>
          )}
          <NoticeStack />
        </div>
      </div>
      <InvitePage />
      <ConfigLinkPage />
    </>
  )
}
