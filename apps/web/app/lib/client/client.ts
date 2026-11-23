import { viewPath, type Nav } from '../view'
import { accountHistoryState, routeOwnerFor } from './account_paths'
import { createBookStore } from './book_store'
import { createPaletteControls } from './palette_ui'
import { CallGuard } from './calls'
import { createInstanceRegistry } from './instance_registry'
import { writeLocal } from '../instances'
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
  let pageBlocked = false
  let nextKey = 0
  let live: readonly AccountSession[] = []
  const calls = new CallGuard()
  const instances = createInstanceRegistry()
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

  return {
    ...createBookStore(),
    calls,
    homeInstance: () => instances.home,
    selectHome: instances.selectHome.bind(instances),
    palette: createPaletteControls(),
    device,
    shown: loadHome,
    bindHome(home: () => AccountSession) {
      this.shown = () => foreground ?? home()
    },
    canWritePage(account: AccountSession) {
      return !pageBlocked && this.shown() === account
    },
    blockPage() {
      pageBlocked = true
    },
    show(account: AccountSession, nav: Nav = 'push') {
      if (!subscriptions.has(account)) return false
      const changed = this.shown() !== account
      pageBlocked = false
      foreground = account
      if (nav !== 'none' && typeof window !== 'undefined') {
        const path = viewPath(account.store.getState().view, routeOwnerFor(account))
        if (changed || window.location.pathname !== path) {
          const state = accountHistoryState(account, null)
          if (nav === 'push') window.history.pushState(state, '', path)
          else window.history.replaceState(state, '', path)
        }
      }
      if (changed) publish([...live])
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
          if (origin !== account.conn.origin) {
            origin = account.conn.origin
            publish([...live])
          }
          if (overlays.some(key => state[key] !== null && state[key] !== previous[key]))
            claim(account)
        })
      )
      publish([...live, account])
    },
    detach(account: AccountSession) {
      if (!subscriptions.has(account)) return
      calls.end(account)
      subscriptions.get(account)?.()
      subscriptions.delete(account)
      if (foreground === account) foreground = null
      publish(live.filter(session => session !== account))
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
