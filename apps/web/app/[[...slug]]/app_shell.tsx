'use client'
import { confirmationHint } from '../lib/provider_confirmation'
import { watchPagePolicy } from '../lib/client/hosted_policy'
import { useP2pApp, useP2p } from '../lib/client/p2p_react'

import { Activity, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useStore } from '../lib/store'
import { AccountProvider, useAccount, useLiveSessions } from '../lib/client/react'
import { client } from '../lib/client/client'
import { accountHistoryState, selectPageAccount, routeOwnerFor } from '../lib/client/account_paths'
import { awaitingInstance, clientOnly } from '../lib/instances'
import { accountPath, parseAccountPath, viewKey } from '../lib/view'
import {
  loginHref,
  logoutForLogin,
  SignedOutAccount,
  UnavailableAccount,
} from '../login/account_login'
import type { AccountSession } from '../lib/client/session'
import type { RChatState } from '../lib/store_types'
import { historyKey } from '../lib/openapi'
import { notifications } from '../lib/platform'
import { useGuestPostingCheck } from '../components/use_guest_posting_check'
import { pollAccountCounts, startAccountCounts } from '../lib/client/account_counts'
import { restoreTheme, startApp } from '../lib/start'
import { THEME_KEY } from '../lib/theme/device'
import { shareLoginHref } from '../lib/client/share_target'
import { ContextMenu } from '../components/context_menu'
import { MediaLightbox } from '../components/media_lightbox'
import { ReactionPickerHost } from '../components/reactions'
import { ProfileCard } from '../components/profile_card'
import { ServerRail } from '../components/server_rail'
import { ChannelSidebar } from '../components/channel_sidebar'
import { MessagePane } from '../components/message_pane'
import { HomePage } from '../components/home'
import { ServerDialogs } from '../components/server_dialogs'
import { FolderDialog } from '../components/folder_dialog'
import { CategoryDialog } from '../components/category_dialog'
import MemberSidebar from '../components/member_sidebar'
import { AdminHost, AdminDialogHost } from '../components/admin/admin_host'
import ServerSettings, { ConfirmDialog } from '../components/server_settings'
import AuditLogDialog from '../components/audit_log'
import WebhooksDialog from '../components/webhooks_dialog'
import PermsDialog from '../components/perm_dialog'
import TimeoutDialog from '../components/timeout_dialog'
import ServerProfileDialog from '../components/server_profile_dialog'
import BanDialog from '../components/ban_dialog'
import ExternalLinkDialog from '../components/external_link_dialog'
import { AppPreview } from '../components/app_preview'
import { ViewingPrompt } from '../components/viewing_prompt'
import { RelayPrompt } from '../components/relay_settings'
import SettingsMenu from '../components/settings_menu'
import { TabTitle } from '../components/tab_title'
import ThreadPanel from '../components/thread_panel'
import SearchPanel from '../components/search_panel'
import FriendsPanel, { AddFriendsDialog } from '../components/friends'
import { InboxHost, useTotalInboxCount } from '../components/inbox'
import { PaletteHost } from '../components/palette'
import { usePaletteUi } from '../lib/palette_store'
import { PollVotersDialog } from '../components/poll_card'
import { CallBanner, ExpandedCallPane } from '../components/voice_grid'
import { AnnouncementBanner } from '../components/announcements'
import { Banners } from '../components/banners'
import { DrawerClose } from '../components/drawer'
import { InvitePage } from '../components/invite_card'
import { ConfigLinkPage } from '../components/config_sync'
import { useEscape } from '../components/ui'
import { Stack, Surface } from '../components/layout'
import { P2pDialogs, P2pHome } from '../components/p2p/p2p_home'
import { P2pDmPane } from '../components/p2p/p2p_dm_pane'
import { P2pChannelPane, P2pMemberList, P2pServerSidebar } from '../components/p2p/p2p_server_view'
import { P2pThreadPanel } from '../components/p2p/p2p_thread'
import { P2pSearchPanel } from '../components/p2p/p2p_search'

function markEntry(account: AccountSession) {
  if (!client.ownsHistoryEntry(account)) return
  const previous = window.history.state
  const marked = accountHistoryState(account, previous)
  // Next strips the trailing slash from links whose final segment resembles a filename,
  // including account roots ending in a dotted host. Keep the local route canonical.
  const { pathname, search, hash } = window.location
  const owner = routeOwnerFor(account)
  if (owner && !pathname.startsWith('/@')) {
    window.history.replaceState(marked, '', accountPath(pathname + search + hash, owner))
    return
  }
  if (pathname.startsWith('/@') && !pathname.slice(1).includes('/')) {
    window.history.replaceState(marked, '', pathname + '/' + search + hash)
    return
  }
  if (
    marked &&
    typeof marked === 'object' &&
    'acct' in marked &&
    'rchatOrigin' in marked &&
    (marked.acct !== previous?.acct || marked.rchatOrigin !== previous?.rchatOrigin)
  )
    window.history.replaceState(marked, '')
}

export default function AppShell() {
  const sessions = useLiveSessions()
  const shown = client.shown()
  const pendingNotice = client.noticePending(shown)
  const router = useRouter()
  const started = useRef(new WeakSet<AccountSession>())
  const [route, setRoute] = useState<'pending' | 'chat' | 'login' | 'missing'>('pending')

  const start = useCallback(
    (account: AccountSession) => {
      if (started.current.has(account)) return
      started.current.add(account)
      void startApp(() => {
        if (!client.ownsHistoryEntry(account)) return
        const { pathname, search, hash } = window.location
        router.replace(
          shareLoginHref(loginHref(pathname + search + hash, routeOwnerFor(account)), search)
        )
      }, account)
    },
    [router]
  )

  useEffect(() => {
    const select = () => {
      const account = selectPageAccount(window.location.pathname, window.history.state)
      if (!account) {
        setRoute('missing')
        return
      }
      if (awaitingInstance(account.conn)) {
        setRoute('login')
        router.replace(shareLoginHref('/login/', window.location.search))
        return
      }
      if (clientOnly() && !parseAccountPath(window.location.pathname)?.owner) {
        const path = accountPath(
          window.location.pathname + window.location.search + window.location.hash,
          routeOwnerFor(account)
        )
        window.history.replaceState(accountHistoryState(account, window.history.state), '', path)
      }
      markEntry(account)
      const local = parseAccountPath(window.location.pathname)?.path
      if (local === '/login' || local === '/login/') {
        setRoute('login')
        router.replace(loginHref('/', parseAccountPath(window.location.pathname)?.owner))
        return
      }
      setRoute('chat')
      const state = account.store.getState()
      if (started.current.has(account)) {
        void state.syncFromUrl('none')
        return
      }
      start(account)
    }
    return watchPagePolicy(select)
  }, [router, start])

  useEffect(() => {
    if (route !== 'chat' || pendingNotice || !client.canWritePage(shown)) return
    start(shown)
    markEntry(shown)
    return shown.store.subscribe((state, before) => {
      if ((state.me !== before.me && state.me) || (state.guest && !before.guest)) markEntry(shown)
    })
  }, [route, shown, start, pendingNotice])

  const ready = route === 'chat'
  useEffect(() => {
    if (ready) return client.accounts.start(pollAccountCounts)
  }, [ready])

  if (route === 'missing') return <UnavailableAccount />
  if (route === 'login') return null
  return (
    <AccountProvider session={shown}>
      {ready ? <RecentChats shown={shown} sessions={sessions} /> : <div>Loading RChat</div>}
      <DeviceBadge />
      <TabTitle />
      <CallBanner />
      <ExpandedCallPane />
      {sessions.map(session => (
        <AccountProvider key={session.renderKey} session={session}>
          <SessionServices />
          <OverlayLayer />
          <RelayPrompt />
        </AccountProvider>
      ))}
      <ShellBanners multiple={sessions.length > 1} />
    </AccountProvider>
  )
}

function DeviceBadge() {
  const pings = useTotalInboxCount()
  useEffect(() => {
    notifications().setBadge(pings)
  }, [pings])
  return null
}

function RecentChats({
  shown,
  sessions,
}: {
  shown: AccountSession
  sessions: readonly AccountSession[]
}) {
  const [recent, setRecent] = useState([shown])
  if (recent[0] !== shown)
    setRecent([shown, ...recent.filter(a => a !== shown && sessions.includes(a))].slice(0, 3))
  return recent
    .filter(a => sessions.includes(a))
    .map(account => (
      <Activity key={account.renderKey} mode={account === shown ? 'visible' : 'hidden'}>
        <AccountProvider session={account}>
          <AccountChat />
        </AccountProvider>
      </Activity>
    ))
}

function AccountChat() {
  const lastInput = useRef<HTMLElement | null>(null)
  useLayoutEffect(() => {
    if (document.activeElement === document.body && lastInput.current?.isConnected)
      lastInput.current.focus({ preventScroll: true })
  }, [])
  return (
    <div
      className="contents"
      onFocusCapture={event => {
        const target = event.target
        if (
          target instanceof HTMLElement &&
          target.matches('textarea, input, [contenteditable="true"]')
        )
          lastInput.current = target
      }}
    >
      <Chat />
    </div>
  )
}

function ShellBanners({ multiple }: { multiple: boolean }) {
  const ready = useStore(s => !!s.me || s.guest)
  return ready || multiple ? <Banners /> : null
}

export function SessionServices() {
  const account = useAccount()
  useEffect(() => {
    const stopCounts = startAccountCounts(account)
    const stopHome = account.home.startSync()
    const ownerOf = (s: RChatState) => s.me?.username ?? (s.guest ? 'guest' : null)
    const reloadHistory = () => account.apiDoc.loadApiHistory(ownerOf(account.store.getState()))
    reloadHistory()
    const stopHistory = account.store.subscribe((s, prev) => {
      if (s.instanceHost !== prev.instanceHost || ownerOf(s) !== ownerOf(prev)) reloadHistory()
    })
    const stopIndex = account.indexer.startIndexSync()
    const reload = (event: StorageEvent) => {
      const key = account.conn.scoped(historyKey(ownerOf(account.store.getState())))
      if (event.key === key || event.key === null) reloadHistory()
      if (event.key === THEME_KEY) restoreTheme(account)
      if (event.key?.startsWith('rchat_layout:')) account.store.getState().reloadLayout()
      if (event.key?.startsWith('rchat_emoji:')) account.store.getState().reloadEmoji()
      if (event.key?.startsWith('rchat_forward:')) account.store.getState().reloadForward()
      if (event.key?.startsWith('rchat_notify:')) account.store.getState().reloadNotify()
      if (event.key?.startsWith('rchat_typing:')) account.store.getState().reloadTyping()
      if (event.key?.startsWith('rchat_anim:')) account.store.getState().reloadAnim()
      if (event.key?.startsWith('rchat_home:')) account.home.reloadHome()
      if (event.key?.startsWith('rchat_palette:')) account.palettePrefs.reloadPalettePrefs()
    }
    const onWake = () => {
      if (document.visibilityState === 'visible') account.store.getState().pruneNotify()
    }
    window.addEventListener('focus', onWake)
    document.addEventListener('visibilitychange', onWake)
    window.addEventListener('storage', reload)
    return () => {
      window.removeEventListener('focus', onWake)
      document.removeEventListener('visibilitychange', onWake)
      window.removeEventListener('storage', reload)
      stopHistory()
      stopCounts()
      stopIndex()
      stopHome()
    }
  }, [account])
  return null
}

function OverlayLayer() {
  const ready = useStore(s => !!s.me || s.guest)
  if (!ready) return null
  return (
    <>
      <AdminDialogHost />
      <AppPreview />
      <ServerDialogs />
      <FolderDialog />
      <CategoryDialog />
      <AddFriendsDialog />
      <PollVotersDialog />
      <ServerSettings />
      <AuditLogDialog />
      <WebhooksDialog />
      <PermsDialog />
      <TimeoutDialog />
      <ServerProfileDialog />
      <BanDialog />
      <ExternalLinkDialog />
      <SettingsMenu />
      <MediaLightbox />
      <ConfirmDialog />
      <ProfileCard />
      <ContextMenu />
      <ReactionPickerHost />
    </>
  )
}

function Chat() {
  const identity = useP2pApp()
  const p2p = identity?.p2p

  const account = useAccount()
  const { store } = account
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
  const signedOut = useStore(s => s.signedOut)
  const p2pHome = useP2p(s => s.home) && me !== null
  // A P2P conversation opened from the DM list shows beside it, not in the P2P home.
  const p2pBeside = useP2p(s => s.home && s.dmList && s.chat !== null) && me !== null
  const p2pRoom = useP2p(s => s.chat?.room ?? null)
  const p2pServer = useP2p(s => s.server !== null) && me !== null
  const p2pChannel = useP2p(s => (s.server ? `${s.server.room}/${s.server.ch}` : null))
  // A P2P server channel's thread or search, or the thread of a P2P conversation.
  const p2pPanelKind = useP2p(s =>
    s.server ? s.panel : s.home && s.chat && !s.chat.ch && s.panel === 'thread' ? s.panel : null
  )
  const p2pPanel = me !== null ? p2pPanelKind : null
  const [leftOpen, setLeftOpen] = useState(false)
  const [rightOpen, setRightOpen] = useState(false)
  const closeLeft = useCallback(() => setLeftOpen(false), [])
  // The member list of a P2P server on wide screens (on by default, like instance servers).
  const [p2pMembers, setP2pMembers] = useState(true)

  useEscape(() => {
    setLeftOpen(false)
    setRightOpen(false)
  }, 'panel')

  const guestBlocked = useStore(s => s.guest && !s.settings.guests_enabled)
  useEffect(() => {
    if (!guestBlocked) return
    logoutForLogin(account)
    store.getState().setError('Guest access is disabled')
    if (client.ownsHistoryEntry(account)) router.replace('/login')
  }, [account, guestBlocked, router, store])

  const authExpired = useStore(s => s.authExpired)
  useEffect(() => {
    if (!authExpired) return
    store.setState({ authExpired: false })
    store.getState().setError('Your session has ended. Please sign in again.')
    if (client.ownsHistoryEntry(account)) {
      const { pathname, search, hash } = window.location
      const hint = confirmationHint(account)
      router.replace(
        loginHref(
          pathname + search + hash,
          hint ? { username: hint.username, host: account.conn.host } : routeOwnerFor(account)
        )
      )
    }
  }, [account, authExpired, router, store])

  // The place the address restores on load keeps the P2P home open (it comes back from its
  // session key); a change of view after that closes it.
  const settled = useRef(false)
  const place = view ? viewKey(view) : null
  const lastView = useRef(place)
  useEffect(() => {
    if (lastView.current === place) return
    lastView.current = place
    setLeftOpen(false)
    setRightOpen(false)
    if (store.getState().panel?.kind === 'thread') store.getState().closePanel()
    if (settled.current) p2p?.closeHome()
  }, [place, store])
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
    const kind = store.getState().panel?.kind
    if (kind === 'thread' || kind === 'search') store.getState().closePanel()
  }, [p2pPanel, store])

  const paletteOpen = usePaletteUi(s => s.open)
  const adminOpen = useStore(s => s.adminPage !== null)
  useEffect(() => {
    if (dialog || confirming || paletteOpen || adminOpen) {
      setLeftOpen(false)
      setRightOpen(false)
    }
  }, [dialog, confirming, paletteOpen, adminOpen])

  if (!me && !guest) {
    if (signedOut) return <SignedOutAccount account={account} />
    return (
      <>
        {!invite && !configLink && (
          <Stack gap="none" justify="center" place="h-app">
            <Surface tone="plain" radius="none" pad="xl" gap="2xs" align="center">
              <span className="text-center text-on-surface-variant">Loading RChat</span>
              {bootError && (
                <span className="text-center text-sm text-on-surface-variant">
                  {bootError}. Retrying…
                </span>
              )}
            </Surface>
          </Stack>
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
        {p2pPanel && (
          <div className="fixed inset-x-0 top-app z-40 h-app bg-surface max-md:px-safe md:static md:z-auto md:w-80 md:shrink-0 md:border-l md:border-outline-variant">
            {p2pPanel === 'thread' ? <P2pThreadPanel /> : <P2pSearchPanel />}
          </div>
        )}
        {panel && !p2pPanel && (
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
        <InboxHost />
        <PaletteHost />
        <ViewingPrompt />
        <P2pDialogs />
      </div>
      <InvitePage />
      <ConfigLinkPage />
    </div>
  )
}
