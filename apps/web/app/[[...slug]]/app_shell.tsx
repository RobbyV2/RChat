'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '../lib/store'
import { AccountProvider } from '../lib/client/react'
import { client } from '../lib/client/client'
import { notifications } from '../lib/platform'
import { useGuestPostingCheck } from '../components/use_guest_posting_check'
import { startApp } from '../lib/start'
import { ContextMenu } from '../components/context_menu'
import { ReactionPickerHost } from '../components/reactions'
import { ProfileCard } from '../components/profile_card'
import { ServerRail } from '../components/server_rail'
import { ChannelSidebar } from '../components/channel_sidebar'
import { MessagePane } from '../components/message_pane'
import { HomePage } from '../components/home'
import { reloadHome, useHomeSync } from '../lib/home_store'
import { ServerDialogs } from '../components/server_dialogs'
import { FolderDialog } from '../components/folder_dialog'
import { CategoryDialog } from '../components/category_dialog'
import MemberSidebar from '../components/member_sidebar'
import { AdminHost } from '../components/admin/admin_host'
import ServerSettings, { ConfirmDialog } from '../components/server_settings'
import AuditLogDialog from '../components/audit_log'
import WebhooksDialog from '../components/webhooks_dialog'
import TimeoutDialog from '../components/timeout_dialog'
import { AppPreview } from '../components/app_preview'
import { ViewingPrompt } from '../components/viewing_prompt'
import { RelayPrompt } from '../components/relay_settings'
import SettingsMenu from '../components/settings_menu'
import ThreadPanel from '../components/thread_panel'
import SearchPanel from '../components/search_panel'
import FriendsPanel, { AddFriendsDialog } from '../components/friends'
import { InboxHost, useInboxCount } from '../components/inbox'
import { PaletteHost } from '../components/palette'
import { reloadPalettePrefs, usePaletteUi } from '../lib/palette_store'
import { PollVotersDialog } from '../components/poll_card'
import { CallBanner } from '../components/voice_grid'
import { AnnouncementBanner } from '../components/announcements'
import { Banners } from '../components/banners'
import { DrawerClose } from '../components/drawer'
import { InvitePage } from '../components/invite_card'
import { ConfigLinkPage } from '../components/config_sync'
import { useEscape } from '../components/ui'
import { P2pDialogs, P2pHome } from '../components/p2p/p2p_home'
import { P2pDmPane } from '../components/p2p/p2p_dm_pane'
import { P2pChannelPane, P2pMemberList, P2pServerSidebar } from '../components/p2p/p2p_server_view'
import { P2pThreadPanel } from '../components/p2p/p2p_thread'
import { P2pSearchPanel } from '../components/p2p/p2p_search'
import { p2p, p2pHost, useP2p } from '../lib/p2p/app'
import { addInboxAdapter } from '../lib/inbox_source'
import { p2pInbox, startP2pPings } from '../lib/p2p/inbox_source'
import { startP2pIndex } from '../lib/p2p/palette_source'

// P2P conversations notify through the same settings, toasts and read state as the rest.
p2pHost.prefs = () => useStore.getState().notifyPrefs
p2pHost.alert = a => useStore.getState().alertFrom(a)
p2pHost.following = scope => useStore.getState().atBottom[scope] === true
p2pHost.typingOn = () => useStore.getState().typingOn
p2pHost.toast = (text, name) => useStore.getState().showToast(text, name)
p2pHost.textOnly = () => {
  const s = useStore.getState().settings
  return !s.asset_uploads && !s.p2p_attachments
}
p2pHost.inCall = () => {
  const s = useStore.getState()
  return s.voice !== null || s.call !== null
}
p2pHost.leaveInstanceCalls = () => {
  const s = useStore.getState()
  if (s.voice) s.leaveVoice()
  if (s.call) {
    if (s.call.state === 'ringing' && s.call.from !== s.me?.username) s.declineCall()
    else s.hangupCall()
  }
}
p2pHost.muted = () => useStore.getState().selfAudio.muted
addInboxAdapter(p2pInbox)

export default function AppShell() {
  return (
    <AccountProvider session={client.shown()}>
      <Chat />
    </AccountProvider>
  )
}

function Chat() {
  const router = useRouter()
  const me = useStore(s => s.me)
  const guest = useStore(s => s.guest)
  const view = useStore(s => s.view)
  const atHome = useStore(s => s.home)
  const invite = useStore(s => s.invite)
  const configLink = useStore(s => s.configLink)
  const dialog = useStore(s => s.activeDialog)
  const confirming = useStore(s => s.confirm !== null)
  const panel = useStore(s => s.panel)
  const server = view?.kind === 'channel' ? view.server : null
  const channel = view?.kind === 'channel' ? view.channelId : null
  const threadChannel = panel?.kind === 'thread' ? panel.root.channel_id : null
  useGuestPostingCheck(server, channel)
  useGuestPostingCheck(server, threadChannel !== channel ? threadChannel : null)
  const bootError = useStore(s => s.bootError)
  const pings = useInboxCount()
  const p2pHome = useP2p(s => s.home) && me !== null
  // A P2P conversation opened from the DM list shows beside it, not in the P2P home.
  const p2pBeside = useP2p(s => s.home && s.dmList && s.chat !== null) && me !== null
  const p2pRoom = useP2p(s => s.chat?.room ?? null)
  const p2pServer = useP2p(s => s.server !== null) && me !== null
  const p2pChannel = useP2p(s => (s.server ? `${s.server.room}/${s.server.ch}` : null))
  const p2pPanelKind = useP2p(s => (s.server ? s.panel : null))
  const p2pPanel = me !== null ? p2pPanelKind : null
  const booted = useRef(false)
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const closeLeft = useCallback(() => setLeftOpen(false), [])
  useHomeSync()
  useEffect(() => startP2pIndex(), [])
  useEffect(() => startP2pPings(), [])
  // The member list of a P2P server on wide screens (on by default, like instance servers).
  const [p2pMembers, setP2pMembers] = useState(true)

  useEscape(() => {
    setLeftOpen(false)
    setRightOpen(false)
  }, 'panel')

  useEffect(() => {
    if (booted.current) return
    booted.current = true
    void startApp(() => router.replace('/login'))
  }, [router])

  useEffect(() => {
    notifications().setBadge(pings)
  }, [pings])

  const appName = useStore(s => s.brand?.app_name ?? null)
  useEffect(() => {
    if (appName !== null) notifications().setTitle(appName)
  }, [appName])

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
      if (e.key?.startsWith('rchat_home:')) reloadHome()
      if (e.key?.startsWith('rchat_palette:')) reloadPalettePrefs()
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

  // The place the address restores on load keeps the P2P home open (it comes back from its
  // session key); a change of view after that closes it.
  const settled = useRef(false)
  useEffect(() => {
    setLeftOpen(false)
    setRightOpen(false)
    if (useStore.getState().panel?.kind === 'thread') useStore.getState().closePanel()
    if (settled.current) p2p.closeHome()
  }, [view])
  useEffect(() => {
    if (view !== null || atHome) settled.current = true
  }, [view, atHome])

  const friendsOpen = panel?.kind === 'friends'
  useEffect(() => {
    if (friendsOpen) setLeftOpen(false)
  }, [friendsOpen])

  useEffect(() => {
    setLeftOpen(false)
    setRightOpen(false)
  }, [p2pHome, p2pServer, p2pChannel, p2pRoom])

  // A P2P server's thread or search takes the panel's place.
  useEffect(() => {
    if (!p2pPanel) return
    const kind = useStore.getState().panel?.kind
    if (kind === 'thread' || kind === 'search') useStore.getState().closePanel()
  }, [p2pPanel])

  const paletteOpen = usePaletteUi(s => s.open)
  const adminOpen = useStore(s => s.adminPage !== null)
  useEffect(() => {
    if (dialog || confirming || paletteOpen || adminOpen) {
      setLeftOpen(false)
      setRightOpen(false)
    }
  }, [dialog, confirming, paletteOpen, adminOpen])

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
        <ViewingPrompt />
      </>
    )
  }

  const isChannel = view?.kind === 'channel'
  const openLeft = () => {
    setRightOpen(false)
    setLeftOpen(true)
  }

  return (
    <div className="flex h-app flex-col overflow-hidden">
      <AnnouncementBanner />
      <div className="flex min-h-0 flex-1 overflow-hidden px-safe">
        <div className="hidden h-full md:flex">
          <ServerRail />
          {p2pServer ? <P2pServerSidebar /> : (!p2pHome || p2pBeside) && <ChannelSidebar />}
        </div>
        {p2pServer ? (
          <P2pChannelPane
            onMenu={openLeft}
            onMembers={() => {
              if (window.matchMedia('(min-width: 64rem)').matches) setP2pMembers(o => !o)
              else {
                setLeftOpen(false)
                setRightOpen(o => !o)
              }
            }}
            membersOpen={p2pMembers}
          />
        ) : p2pBeside ? (
          <P2pDmPane onMenu={openLeft} />
        ) : p2pHome ? (
          <P2pHome onMenu={openLeft} />
        ) : view === null && atHome ? (
          <HomePage onMenu={openLeft} />
        ) : (
          <MessagePane
            onMenu={openLeft}
            onMembers={() => {
              setLeftOpen(false)
              setRightOpen(o => !o)
            }}
          />
        )}
        {isChannel && !panel && !p2pHome && !p2pServer && (
          <div className="hidden h-full lg:block">
            <MemberSidebar />
          </div>
        )}
        {p2pServer && p2pMembers && !p2pPanel && (
          <div className="hidden h-full lg:block">
            <P2pMemberList />
          </div>
        )}
        {p2pServer && p2pPanel && (
          <div className="fixed inset-x-0 top-app z-40 h-app bg-surface max-md:px-safe md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-outline-variant">
            {p2pPanel === 'thread' ? <P2pThreadPanel /> : <P2pSearchPanel />}
          </div>
        )}
        {panel && !(p2pServer && p2pPanel) && (
          <div className="fixed inset-x-0 top-app z-40 h-app bg-surface max-md:px-safe md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-outline-variant">
            {panel.kind === 'thread' ? (
              <ThreadPanel />
            ) : panel.kind === 'search' ? (
              <SearchPanel />
            ) : (
              <FriendsPanel />
            )}
          </div>
        )}
        {leftOpen && (
          <div data-drawer className="fixed inset-x-0 top-app z-40 flex h-app md:hidden">
            <div className="flex h-full bg-surface-container-lowest pl-[env(safe-area-inset-left)] shadow-elevation-3">
              <DrawerClose.Provider value={closeLeft}>
                <ServerRail />
                {p2pServer ? <P2pServerSidebar /> : (!p2pHome || p2pBeside) && <ChannelSidebar />}
              </DrawerClose.Provider>
            </div>
            <div className="flex-1 bg-scrim/50" onClick={() => setLeftOpen(false)} />
          </div>
        )}
        {rightOpen && (isChannel || p2pServer) && (
          <div
            data-drawer
            className="fixed inset-x-0 top-app z-40 flex h-app justify-end lg:hidden"
          >
            <div className="flex-1 bg-scrim/50" onClick={() => setRightOpen(false)} />
            <div className="h-full bg-surface-container-low pr-[env(safe-area-inset-right)] shadow-elevation-3">
              {p2pServer ? <P2pMemberList /> : <MemberSidebar />}
            </div>
          </div>
        )}
        <AdminHost />
        <ServerDialogs />
        <FolderDialog />
        <CategoryDialog />
        <AddFriendsDialog />
        <PollVotersDialog />
        <ServerSettings />
        <AuditLogDialog />
        <WebhooksDialog />
        <TimeoutDialog />
        <SettingsMenu />
        <ConfirmDialog />
        <InboxHost />
        <PaletteHost />
        <RelayPrompt />
        <ViewingPrompt />
        <AppPreview />
        <P2pDialogs />
        <ProfileCard />
        <ContextMenu />
        <ReactionPickerHost />
        <CallBanner />
        <Banners />
      </div>
      <InvitePage />
      <ConfigLinkPage />
    </div>
  )
}
