import { create } from 'zustand'
import { home, writeLocal } from '../instances'
import { dbName, P2pStore, removeP2pDb } from './db'
import { fingerprint } from './keys'
import type { AddResult, Contact } from './contacts'
import { TabLeader } from './leader'
import { P2pNode, SQUATTED, type Presence, type Status, type Visibility } from './node'
import { PeerTransport } from './transport'

// The P2P view model. IndexedDB (through the node) is the source of truth; this store only
// mirrors what the UI shows. One node per signed-in account; guests never get one.

export type P2pDialog =
  | { kind: 'add'; tab?: 'scan' | 'paste' | 'mine' }
  | { kind: 'verify'; ik: string }
  | { kind: 'rename'; ik: string }
  | { kind: 'contact'; ik: string }
  | { kind: 'enable' }

export interface P2pState {
  account: string | null
  // P2P is turned on for this account on this browser.
  enabled: boolean
  loading: boolean
  status: Status | 'off'
  ik: string | null
  name: string
  fingerprint: string
  card: string | null
  contacts: Contact[]
  presence: Record<string, Presence>
  paused: boolean
  // The P2P home replaces the instance sidebar and pane while open.
  home: boolean
  // Another tab of this account runs P2P; this one only offers to take over.
  elsewhere: boolean
  // Message requests dropped to limit spam.
  dropped: number
  storage: { usage: number; quota: number } | null
  error: string | null
  dialog: P2pDialog | null
}

const initial: P2pState = {
  account: null,
  enabled: false,
  loading: false,
  status: 'off',
  ik: null,
  name: '',
  fingerprint: '',
  card: null,
  contacts: [],
  presence: {},
  paused: false,
  home: false,
  elsewhere: false,
  dropped: 0,
  storage: null,
  error: null,
  dialog: null,
}

export const useP2p = create<P2pState>()(() => initial)

// Stored per account: { v: 1, on }. Anything unreadable means off.
export const p2pKey = (username: string) => `rchat_p2p:${username}`

export const parseOn = (raw: string | null) => {
  try {
    const v = raw ? (JSON.parse(raw) as unknown) : null
    return typeof v === 'object' && v !== null && (v as { v?: unknown; on?: unknown }).v === 1
      ? (v as { on?: unknown }).on === true
      : false
  } catch {
    return false
  }
}

const readOn = (username: string) => {
  try {
    return parseOn(localStorage.getItem(home.scoped(p2pKey(username))))
  } catch {
    return false
  }
}

const writeOn = (username: string, on: boolean) =>
  writeLocal(home.scoped(p2pKey(username)), on ? JSON.stringify({ v: 1, on: true }) : null)

const pageVisibility: Visibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  onChange: fn => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  },
}

let node: P2pNode | null = null
let store: P2pStore | null = null
let leader: TabLeader | null = null
let unwatch: (() => void) | null = null
let gen = 0

// The open P2P home survives a reload of this tab.
const HOME_KEY = 'rchat_p2p_home'

const readHome = (username: string) => {
  try {
    return sessionStorage.getItem(home.scoped(HOME_KEY)) === username
  } catch {
    return false
  }
}

const writeHome = (username: string | null) => {
  try {
    if (username) sessionStorage.setItem(home.scoped(HOME_KEY), username)
    else sessionStorage.removeItem(home.scoped(HOME_KEY))
  } catch {
    // Private mode: the view just isn't kept.
  }
}

// Leaving the page says goodbye to every contact, so they see us go offline at once. A page
// restored from the back-forward cache starts again.
if (typeof window !== 'undefined') {
  window.addEventListener('pagehide', () => node?.stop())
  window.addEventListener('pageshow', e => {
    if (e.persisted && node) void node.start()
  })
}

const dbFor = (username: string) => dbName(home.host, username)

const mirror = async () => {
  const n = node
  if (!n) return
  const v = n.view()
  useP2p.setState({
    status: v.status,
    ik: v.ik,
    name: v.name,
    fingerprint: fingerprint(v.ik),
    contacts: v.contacts,
    presence: v.presence,
    paused: n.paused,
    dropped: v.dropped,
    elsewhere: false,
    error: v.status === 'squatted' ? SQUATTED : null,
  })
  const card = await n.myCard().catch(() => null)
  if (node === n) useP2p.setState({ card })
}

const stopNode = () => {
  unwatch?.()
  unwatch = null
  node?.stop()
  node = null
  store?.close()
  store = null
}

const shutdown = () => {
  const l = leader
  leader = null
  stopNode()
  void l?.stop()
}

// The view fields a node fills in; cleared when this tab hands P2P to another one.
const nodeless = () => {
  const { account, enabled, home: h, dialog } = useP2p.getState()
  return { ...initial, account, enabled, home: h, dialog }
}

// Runs P2P in this tab once it holds the account's lock; until then the tab shows a notice.
// `create` is the name for a new identity, when one should be made.
const run = (username: string, create: string | null) => {
  const mine = gen
  // Bumped on every resign, so a boot still in flight stops instead of starting a second node.
  let term = 0
  const l: TabLeader = new TabLeader(dbFor(username), {
    lead: (): Promise<void> => {
      const t = ++term
      return mine === gen
        ? boot(username, create, l, () => mine === gen && t === term)
        : Promise.resolve()
    },
    resign: async () => {
      term++
      stopNode()
      if (mine === gen) useP2p.setState(nodeless())
    },
    follow: () => {
      if (mine === gen) useP2p.setState({ ...nodeless(), elsewhere: true })
    },
  })
  leader = l
  useP2p.setState({ loading: true })
  l.start()
}

const boot = async (username: string, create: string | null, l: TabLeader, live: () => boolean) => {
  useP2p.setState({ loading: true, elsewhere: false })
  try {
    const s = await P2pStore.open(dbFor(username), () => {
      // Another tab removed the data or upgraded the schema: start over from what is stored.
      if (store !== s) return
      gen++
      shutdown()
      useP2p.setState({ loading: false })
      void p2pAccount(useP2p.getState().account)
    })
    if (!live()) return s.close()
    const n = await P2pNode.open(
      { store: s, transport: new PeerTransport(), host: home.host, visibility: pageVisibility },
      create !== null ? { name: create } : undefined
    )
    if (!live()) {
      n?.stop()
      return s.close()
    }
    if (!n) {
      s.close()
      writeOn(username, false)
      if (leader === l) leader = null
      void l.stop()
      useP2p.setState({ ...initial, account: username })
      return
    }
    store = s
    node = n
    unwatch = n.onChange(() => void mirror())
    useP2p.setState({ enabled: true, loading: false })
    await mirror()
    if (node !== n) return
    await n.start()
  } catch {
    if (live())
      useP2p.setState({ loading: false, error: "Couldn't open P2P storage in this browser" })
  }
}

// Called on every sign in and out (null): one node per account, none for guests.
export const p2pAccount = async (username: string | null) => {
  const cur = useP2p.getState()
  if (username !== null && cur.account === username && (node || leader || cur.loading)) return
  gen++
  shutdown()
  const was = useP2p.getState()
  const keepHome =
    username !== null && ((was.account === username && was.home) || readHome(username))
  useP2p.setState({ ...initial, account: username, home: keepHome })
  if (username === null || !readOn(username)) return
  useP2p.setState({ enabled: true })
  run(username, null)
}

const withNode = async <T>(fn: (n: P2pNode) => Promise<T>): Promise<T | null> => {
  const n = node
  if (!n) return null
  try {
    return await fn(n)
  } catch (e) {
    useP2p.setState({ error: e instanceof Error ? e.message : String(e) })
    return null
  }
}

export const p2p = {
  // `name` is shown to contacts; empty means "P2P user", never the account name.
  async enable(name = '') {
    const username = useP2p.getState().account
    if (!username || node || leader) return
    writeOn(username, true)
    useP2p.setState({ enabled: true })
    try {
      await navigator.storage?.persist?.()
    } catch {
      // Best effort: the browser may still evict the data.
    }
    run(username, name)
    void p2p.refreshStorage()
  },

  // Deletes the identity, contacts and everything else P2P from this browser.
  async removeData() {
    const username = useP2p.getState().account
    if (!username) return
    gen++
    shutdown()
    writeOn(username, false)
    try {
      await removeP2pDb(dbFor(username))
    } catch {
      useP2p.setState({ error: "Couldn't remove P2P data" })
    }
    useP2p.setState({ ...initial, account: username })
  },

  setPaused: (on: boolean) => withNode(n => n.setPaused(on)),
  addContact: (text: string, intro = ''): Promise<AddResult | null> =>
    withNode(n => n.addContact(text, intro)),
  readCard: (text: string) => withNode(n => n.readCard(text)),
  accept: (ik: string) => withNode(n => n.accept(ik)),
  ignore: (ik: string) => withNode(n => n.ignore(ik)),
  block: (ik: string) => withNode(n => n.block(ik)),
  remove: (ik: string) => withNode(n => n.remove(ik)),
  rename: (ik: string, name: string) => withNode(n => n.rename(ik, name)),
  markVerified: (ik: string) => withNode(n => n.markVerified(ik)),
  verifyCode: (ik: string) => node?.verifyCodeFor(ik) ?? null,
  scanVerify: (ik: string, text: string) => withNode(n => n.scanVerifyCode(ik, text)),
  setName: (name: string) => withNode(n => n.setName(name)),
  resetIdentity: () => withNode(n => n.resetIdentity()),
  clearDropped: () => withNode(n => n.clearDropped()),
  // Moves P2P from the tab that runs it to this one.
  useHere: () => leader?.takeOver(),

  openHome: () => {
    writeHome(useP2p.getState().account)
    useP2p.setState({ home: true })
  },
  closeHome: () => {
    writeHome(null)
    useP2p.setState({ home: false })
  },
  clearError: () => useP2p.setState({ error: null }),
  openDialog: (dialog: P2pDialog) => useP2p.setState({ dialog }),
  closeDialog: () => useP2p.setState({ dialog: null }),

  async refreshStorage() {
    try {
      const e = await navigator.storage?.estimate?.()
      if (e) useP2p.setState({ storage: { usage: e.usage ?? 0, quota: e.quota ?? 0 } })
    } catch {
      useP2p.setState({ storage: null })
    }
  },
}
