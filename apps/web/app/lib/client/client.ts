import { createSavedSession } from './saved_session'
import { allowsAccountOrigin, visibleBook, watchHostedPolicy } from './hosted_policy'
import { AccountManager } from './account_manager'
import { viewPath, type Nav } from '../view'
import { accountHistoryState, routeOwnerFor } from './account_paths'
import { createBookStore } from './book_store'
import { createPaletteControls } from './palette_ui'
import { CallGuard } from './calls'
import { createInstanceRegistry } from './instance_registry'
import { ownInstance, writeLocal } from '../instances'
import type { Theme } from '../types'
import type { AccountId, AccountSession } from './session'

const closed = {
  contextMenu: null,
  reactPicker: null,
  profile: null,
  activeDialog: null,
  confirm: null,
}
const overlays = Object.keys(closed) as (keyof typeof closed)[]

function loadHome(): AccountSession {
  // Load the store on first use when a caller only imports the client.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { getHomeSession } = require('../store') as typeof import('../store')
  return getHomeSession()
}

function createClient() {
  let foreground: AccountSession | null = null
  let noticeOwner: AccountSession | null = null
  let shownVersion = 0
  let pageBlocked = false
  let actorSelection = 0
  let nextKey = 0
  let live: readonly AccountSession[] = []
  const calls = new CallGuard()
  const books = createBookStore(visibleBook)
  const instances = createInstanceRegistry(books.book.getState())
  const listeners = new Set<() => void>()
  const subscriptions = new Map<AccountSession, () => void>()

  function publish(next: readonly AccountSession[]) {
    live = next
    for (const listener of listeners) listener()
  }

  const hasOverlay = (session: AccountSession) => {
    const state = session.store.getState()
    return overlays.some(key => state[key] !== null)
  }

  function claim(owner: AccountSession) {
    for (const other of live) {
      if (other !== owner && hasOverlay(other)) other.store.setState(closed)
    }
  }

  const device = {
    theme: 'dark' as Theme,
    streamer: false,
    setTheme(theme: Theme) {
      device.theme = theme
      writeLocal('rchat_theme', theme)
      if (typeof document !== 'undefined') {
        document.documentElement.dataset.theme = theme
        document
          .querySelector('meta[name="theme-color"]')
          ?.setAttribute('content', theme === 'dark' ? '#141218' : '#fef7ff')
      }
      for (const account of live) account.store.setState({ theme })
    },
    setStreamer(streamer: boolean) {
      device.streamer = streamer
      writeLocal('rchat_streamer', streamer ? '1' : '0')
      if (typeof document !== 'undefined') document.body.classList.toggle('streamer-mode', streamer)
      for (const account of live) account.store.setState({ streamer })
    },
  }

  const accounts = new AccountManager({
    book: books.book.getState,
    shown: (): AccountSession => client.shown(),
    live: () => live,
    protected: () => calls.current()?.account,
    protectedIdentity: () => calls.current()?.identity,
    watch: fn => {
      const off = books.book.subscribe(fn)
      const offCalls = calls.subscribe(fn)
      return () => {
        off()
        offCalls()
      }
    },
    publish: () => publish([...live]),
  })
  watchHostedPolicy(() => {
    books.refreshBook()
    const selected = foreground ?? live.find(a => a.isHome)
    if (selected && !allowsAccountOrigin(selected.conn.origin)) {
      pageBlocked = true
      foreground =
        live.find(a => allowsAccountOrigin(a.conn.origin)) ??
        createSavedSession(ownInstance()!.origin)
    }
    for (const account of [...live]) {
      if (allowsAccountOrigin(account.conn.origin)) continue
      account.store.setSocket(false)
      account.tabLock.stop()
      account.deliveryLock.stop()
      account.store.dispose()
    }
    if (!allowsAccountOrigin(instances.home.origin)) instances.setHome(ownInstance()!.origin, null)
    accounts.schedule()
    publish([...live])
  })
  return {
    ...books,
    accounts,
    calls,
    homeInstance: () => instances.home,
    selectHome: instances.selectHome.bind(instances),
    palette: createPaletteControls(),
    device,
    shown: loadHome,
    shownVersion: () => shownVersion,
    bindHome(home: () => AccountSession) {
      this.shown = () => foreground ?? home()
    },
    canWritePage(account: AccountSession) {
      return allowsAccountOrigin(account.conn.origin) && !pageBlocked && this.shown() === account
    },
    ownsHistoryEntry(account: AccountSession) {
      return this.canWritePage(account) && noticeOwner !== account
    },
    noticePending(account: AccountSession) {
      return noticeOwner === account
    },
    commitNotice(account: AccountSession) {
      if (noticeOwner !== account) return
      noticeOwner = null
      publish([...live])
    },
    actorSelectionMark: () => actorSelection,
    cancelActorSelection: () => ++actorSelection,
    blockPage() {
      actorSelection++
      noticeOwner?.store.cancelNavigation()
      noticeOwner = null
      pageBlocked = true
    },
    show(account: AccountSession, nav: Nav | 'notice' = 'push') {
      if (!allowsAccountOrigin(account.conn.origin) || !subscriptions.has(account)) return false
      actorSelection++
      const wasPending = noticeOwner !== null
      noticeOwner?.store.cancelNavigation()
      noticeOwner = nav === 'notice' ? account : null
      const changed = this.shown() !== account
      pageBlocked = false
      if (changed) shownVersion++
      foreground = account
      if (nav !== 'notice' && nav !== 'none' && typeof window !== 'undefined') {
        const path = viewPath(account.store.getState().view, routeOwnerFor(account))
        if (changed || wasPending || window.location.pathname !== path) {
          const state = accountHistoryState(account, null)
          if (nav === 'push') window.history.pushState(state, '', path)
          else window.history.replaceState(state, '', path)
        }
      }
      if (changed) accounts.reconcile()
      if (changed || wasPending) publish([...live])
      return true
    },
    live: () => live,
    overlayOwner: () => live.find(hasOverlay),
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
      }
    },
    nextSessionKey: (): number => ++nextKey,
    attach(account: AccountSession) {
      let origin = account.conn.origin
      subscriptions.set(
        account,
        account.store.subscribe((state, previous) => {
          if (
            state.me !== previous.me ||
            state.guest !== previous.guest ||
            state.token !== previous.token
          )
            accounts.schedule()
          if (origin !== account.conn.origin) {
            origin = account.conn.origin
            publish([...live])
          }
          if (overlays.some(key => state[key] !== null && state[key] !== previous[key]))
            claim(account)
        })
      )
      publish([...live, account])
      accounts.schedule()
    },
    detach(account: AccountSession) {
      if (!subscriptions.has(account)) return
      calls.end(account)
      subscriptions.get(account)?.()
      subscriptions.delete(account)
      if (noticeOwner === account) noticeOwner = null
      if (foreground === account) foreground = null
      publish(live.filter(session => session !== account))
      accounts.schedule()
    },
    claimOverlay(id: AccountId) {
      const owner = live.find(account => account.id === id)
      if (owner) claim(owner)
    },
  }
}

export const client = createClient()

export function shownMenu() {
  if (client.shown === loadHome)
    throw new Error('The store is not bound yet: import store.ts first')
  return client.shown().store.menu
}
