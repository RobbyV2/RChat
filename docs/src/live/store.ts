import { create } from 'zustand'
import { createApi, type Api } from '../../../apps/web/app/lib/api'
import { parseBook } from '../../../apps/web/app/lib/client/book'
import { storedCredential } from '../../../apps/web/app/lib/client/credentials'
import { savedConnection } from '../../../apps/web/app/lib/client/saved_session'
import { siteSettings } from '../../../apps/web/app/lib/features'
import { readLocal, writeLocal, type InstanceConnection } from '../../../apps/web/app/lib/instances'
import {
  RUN_AS_KEY,
  liveAccounts,
  liveState,
  parseRunAs,
  pickAccount,
  runAsValue,
  type LiveAccount,
  type LiveState,
} from '../../../apps/web/app/lib/live_docs'
import { STREAMER_KEY, THEME_KEY } from '../../../apps/web/app/lib/theme/device'
import type { InstanceInfo } from '../../../apps/web/app/lib/types'
import { env } from './env'

// Where these pages run: served by an instance, carried by an app (the client build, the desktop
// and mobile apps), or on their own.
export type Place = 'instance' | 'app' | 'standalone'

// An instance the app on this origin holds, by address.
export interface HeldInstance {
  origin: string
  name: string
}

interface Live {
  place: Place | null
  instances: HeldInstance[]
  // The instance serving these pages, when one does.
  here: InstanceInfo | null
  // Off until the page knows the app on this origin holds accounts.
  dynamic: boolean
  accounts: LiveAccount[]
  // Each instance's interactive docs switch by origin; absent while it is being read.
  switches: Record<string, boolean>
  selected: string | null
  streamer: boolean
}

export const useLive = create<Live>(() => ({
  place: null,
  instances: [],
  here: null,
  dynamic: false,
  accounts: [],
  switches: {},
  selected: null,
  streamer: false,
}))

const connections = new Map<string, InstanceConnection>()

// The app's connection to `origin`, as the app makes it for a saved account.
export function connection(origin: string) {
  let conn = connections.get(origin)
  if (!conn) {
    conn = savedConnection(origin)
    connections.set(origin, conn)
  }
  return conn
}

const apis = new Map<string, Api>()

// The API client of one account: its instance's address and version, and its own token.
export function accountApi(a: LiveAccount) {
  let api = apis.get(a.key)
  if (!api) {
    const conn = connection(a.origin)
    api = createApi(conn.apiBase, 'omit')
    api.prefix = conn.api.prefix
    api.setToken(a.token)
    apis.set(a.key, api)
  }
  return api
}

export const stateOf = (s: Live, a: LiveAccount): LiveState => liveState(a, s.switches[a.origin])

export const selectedAccount = (s: Live) => s.accounts.find(a => a.key === s.selected) ?? null

export function select(key: string) {
  writeLocal(RUN_AS_KEY, runAsValue(key))
  useLive.setState({ selected: key })
}

export function setStreamer(on: boolean) {
  writeLocal(STREAMER_KEY, on ? '1' : '0')
  applyStreamer(on)
}

function applyStreamer(on: boolean) {
  document.body.classList.toggle('streamer-mode', on)
  useLive.setState({ streamer: on })
}

let served: Promise<InstanceInfo | null> | null = null

// The instance that serves these pages, from its discovery document; null when none does.
const servingInstance = () =>
  (served ??= createApi('/api', 'omit')
    .discovery()
    .catch(() => null))

async function readSwitch(a: LiveAccount) {
  try {
    const res = await accountApi(a).send('GET', '/settings', undefined, { timeoutMs: 5000 })
    return res.ok ? siteSettings(await res.json()).interactive_docs : false
  } catch {
    return false
  }
}

let started: Promise<void> | null = null

// Finds where these pages run, then reads the accounts the app on this origin holds and each
// instance's switch, and follows the app's streamer mode and account choice in other tabs.
// Static mode stays when the app holds none.
export const start = () => (started ??= begin())

async function begin() {
  applyStreamer(readLocal(STREAMER_KEY) === '1')
  window.addEventListener('storage', e => {
    if (e.key === STREAMER_KEY) applyStreamer(e.newValue === '1')
    if (e.key === RUN_AS_KEY) useLive.setState({ selected: parseRunAs(e.newValue) })
  })
  const here = await servingInstance()
  env.NEXT_PUBLIC_CLIENT_ONLY = here ? 'false' : 'true'
  const raw = readLocal('rchat_book')
  const book = raw ? parseBook(raw) : null
  const accounts = book
    ? liveAccounts(
        book,
        (origin, username) => storedCredential(connection(origin), book, username)?.token ?? null
      )
    : []
  const instances = book?.instances.map(i => ({ origin: i.origin, name: i.name })) ?? []
  const app = instances.length > 0 || readLocal(THEME_KEY) !== null
  useLive.setState({ here, instances, place: here ? 'instance' : app ? 'app' : 'standalone' })
  if (!accounts.length) return
  document.body.classList.add('live-dynamic')
  useLive.setState({
    dynamic: true,
    accounts,
    selected:
      pickAccount(accounts, parseRunAs(readLocal(RUN_AS_KEY)), a => a.token !== null)?.key ?? null,
  })
  const seen = new Set<string>()
  for (const a of accounts) {
    if (seen.has(a.origin) || a.token === null) continue
    seen.add(a.origin)
    void readSwitch(a).then(on =>
      useLive.setState(s => ({ switches: { ...s.switches, [a.origin]: on } }))
    )
  }
}
