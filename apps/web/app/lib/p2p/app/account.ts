import { api, home, shareOrigin } from '../../instances'
import { dbName, P2pStore, removeP2pDb } from '../db'
import { BadgeKeeper, Badges, peersCanCheck, readSlots } from '../badge'
import { fingerprint, keyId } from '../keys'
import type { AddResult } from '../contacts'
import { dmRoomId, Dms } from '../dm'
import { PingLog } from '../ping_log'
import { freeSpace, storageSpace } from '../files'
import { pausesHidden } from '../../platform'
import { TabLeader, webLeaderDeps } from '../leader'
import { P2pNode, SQUATTED, type Visibility } from '../node'
import { PeerTransport } from '../transport'
import { hidesIp, relayBook } from '../../relays'
import { Calls, type PendingCall } from '../calls'
import { RELAY_DENIED_TEXT } from '../voice'
import { Servers } from '../server'
import { limitsFor, runtimeLimits } from '../user_limits'
import {
  servers,
  calls,
  node,
  useP2p,
  data,
  unwatch,
  put,
  pingLog,
  keeper,
  badges,
  dms,
  store,
  reader,
  leader,
  limits,
  initial,
  gen,
  writeOn,
  p2pHost,
  readAuto,
  readHome,
  readOn,
  writeHome,
  type P2pDialog,
} from './store'
import {
  tellBadge,
  mirrorBadges,
  checkBinding,
  scheduleBadges,
  badgeLocal,
  accountSub,
} from './badge'
import {
  elsewhereCall,
  callRtc,
  noteMissed,
  PENDING_CALL,
  publishCall,
  ringing,
  scheduleRefresh,
} from './calls'
import { refreshRoom, refreshRooms, loadChat, contactName, arrived } from './dms'
import { memberName, scheduleServer, serverArrived, refreshServers, p2pServer } from './servers'
import { pingLogged } from './inbox'
import { scheduleFile } from './attachments'
import { readLayout } from './rail'

const pageVisibility: Visibility = {
  visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
  pauses: () => pausesHidden(),
  onChange: fn => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', fn)
    return () => document.removeEventListener('visibilitychange', fn)
  },
}

// Leaving the page says goodbye to every contact, so they see us go offline at once. A page
// restored from the back-forward cache starts again.
if (typeof window !== 'undefined') {
  // Frames are sealed asynchronously and a page that unloads doesn't wait for that, so what
  // pagehide sends is best effort (a contact call's `end` usually doesn't get out). A voice
  // channel's leave goes out on beforeunload instead, while there is still time; a page that
  // stays after all says it is back as soon as it is used again.
  window.addEventListener('beforeunload', () => servers?.voice.goodbye())
  const back = () => servers?.voice.back()
  window.addEventListener('pointerdown', back, true)
  window.addEventListener('keydown', back, true)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') back()
  })
  window.addEventListener('pagehide', () => {
    // Session.close still sends what was queued first, when the page lives long enough.
    calls?.stop()
    servers?.voice.leave()
    node?.stop()
  })
  window.addEventListener('pageshow', e => {
    if (e.persisted && node) void node.start()
  })
}

export const dbFor = (username: string) => dbName(home.host, username)

// The node's view into the store; our own badge change is told to the reader tabs (`post`).
export const mirrorFrom = async (
  n: Pick<P2pNode, 'view' | 'paused' | 'myCard'>,
  post: (m: { badges: true }) => void
) => {
  const v = n.view()
  tellBadge(useP2p.getState().badge, v.badge, post)
  useP2p.setState({
    status: v.status,
    ik: v.ik,
    me: v.ik,
    name: v.name,
    fingerprint: fingerprint(v.ik),
    contacts: v.contacts,
    presence: v.presence,
    paused: n.paused,
    dropped: v.dropped,
    movedAt: v.movedAt,
    movingAt: v.movingAt,
    alertAt: v.alertAt,
    badge: v.badge,
    elsewhere: false,
    error: v.status === 'squatted' ? SQUATTED : null,
  })
  const card = await n.myCard().catch(() => null)
  if (node === n) useP2p.setState({ card })
}

const mirror = async () => {
  const n = node
  if (n) await mirrorFrom(n, m => data?.postMessage(m))
}

export const stopNode = () => {
  unwatch?.()
  put.unwatch(null)
  if (calls) {
    calls.stop()
    put.calls(null)
    data?.postMessage({ call: null })
  }
  if (useP2p.getState().call) useP2p.setState({ call: null, callQuiet: false })
  servers?.stop()
  if (useP2p.getState().voice) useP2p.setState({ voice: null })
  put.servers(null)
  pingLog?.stop()
  put.pingLog(null)
  keeper?.stop()
  put.keeper(null)
  badges?.stop()
  put.badges(null)
  dms?.stop()
  put.dms(null)
  node?.stop()
  put.node(null)
  store?.close()
  put.store(null)
  stopReader()
}

const stopReader = () => {
  reader?.store.close()
  put.reader(null)
  data?.close()
  put.data(null)
}

const dataChannel = (username: string) => webLeaderDeps().channel(`${dbFor(username)}:data`)

const shutdown = () => {
  const l = leader
  put.leader(null)
  stopNode()
  void l?.stop()
}

// The view fields a node fills in; cleared when this tab hands P2P to another one.
const nodeless = () => {
  const { account, enabled, home: h, dialog, chat, drafts, server, layout } = useP2p.getState()
  return {
    ...initial,
    account,
    enabled,
    home: h,
    dialog,
    drafts,
    server,
    layout,
    chat: chat && { ...chat, messages: [], loading: true },
  }
}

// Another tab runs P2P: this one opens the database to show what is stored, and reloads when
// the leader says something changed.
const read = async (username: string, live: () => boolean) => {
  try {
    const s = await P2pStore.open(dbFor(username), () => {
      if (reader?.store === s) stopReader()
    })
    const self = await s.self()
    if (!live() || !self) return s.close()
    stopReader()
    put.limits(limitsFor(username))
    put.reader({ store: s, me: keyId(self.ik.pk) })
    const ch = dataChannel(username)
    if (ch) {
      ch.onmessage = e => {
        const msg = e.data as {
          room?: unknown
          call?: unknown
          badges?: unknown
          inbox?: unknown
        } | null
        if (msg && 'call' in msg) return useP2p.setState({ callElsewhere: elsewhereCall(msg.call) })
        if (msg && 'inbox' in msg) return useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
        if (msg && 'badges' in msg)
          return void Promise.all([readSlots(s), s.self()]).then(
            ([slots, me]) => {
              if (reader?.store !== s) return
              mirrorBadges(Object.fromEntries(slots))
              // Our own badge changed in the leading tab too.
              if (me) useP2p.setState({ badge: me.badge ?? null })
            },
            () => {}
          )
        const room = msg?.room
        if (typeof room !== 'string') return
        void refreshRoom(room)
        void s.contacts().then(
          contacts => reader?.store === s && useP2p.setState({ contacts }),
          () => {}
        )
      }
      put.data(ch)
      ch.postMessage({ ask: 'call' })
    }
    const contacts = await s.contacts()
    useP2p.setState({
      reader: true,
      me: reader!.me,
      contacts,
      ik: reader!.me,
      name: self.profile.name,
      fingerprint: fingerprint(reader!.me),
      badge: self.badge ?? null,
    })
    mirrorBadges(Object.fromEntries(await readSlots(s)))
    await refreshRooms()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
  } catch {
    // The leader's copy is all there is; this tab just shows the notice.
  }
}

// Runs P2P in this tab once it holds the account's lock; until then the tab shows a notice.
// `create` is the name for a new identity, when one should be made.
export const run = (username: string, create: string | null) => {
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
      if (mine !== gen) return
      useP2p.setState({ ...nodeless(), elsewhere: true })
      void read(username, () => mine === gen && l.state !== 'leading')
    },
  })
  put.leader(l)
  useP2p.setState({ loading: true })
  l.start()
}

// What the node, the DMs and the servers of `username` start with, besides the store and each
// other: the account's limits and this page's hooks.
export const startDeps = (username: string) => {
  const lim = limitsFor(username)
  const rt = runtimeLimits(lim)
  return {
    limits: lim,
    node: { host: home.host, visibility: pageVisibility, ...rt.node },
    dms: {
      ...rt.dms,
      attachments: () => !p2pHost.textOnly(),
      room: freeSpace,
      space: storageSpace,
      autoMax: () => readAuto(username).dm,
      autoDaily: () => readAuto(username).daily,
    },
    servers: {
      ...rt.servers,
      autoMax: () => readAuto(username).server,
      attachments: () => !p2pHost.textOnly(),
    },
  }
}

export const boot = async (
  username: string,
  create: string | null,
  l: TabLeader,
  live: () => boolean
) => {
  useP2p.setState({ loading: true, elsewhere: false })
  try {
    const s = await P2pStore.open(dbFor(username), () => {
      // Another tab removed the data or upgraded the schema: start over from what is stored.
      if (store !== s) return
      put.gen(gen + 1)
      shutdown()
      useP2p.setState({ loading: false })
      void p2pAccount(useP2p.getState().account)
    })
    if (!live()) return s.close()
    const deps = startDeps(username)
    const n = await P2pNode.open(
      { ...deps.node, store: s, transport: new PeerTransport() },
      create !== null ? { name: create } : undefined
    )
    if (!live()) {
      n?.stop()
      return s.close()
    }
    if (!n) {
      s.close()
      writeOn(username, false)
      if (leader === l) put.leader(null)
      void l.stop()
      useP2p.setState({ ...initial, account: username })
      return
    }
    put.store(s)
    put.node(n)
    put.limits(deps.limits)
    stopReader()
    const d = new Dms({ ...deps.dms, node: n, store: s })
    put.dms(d)
    const sv = new Servers({ ...deps.servers, node: n, store: s, dms: d })
    put.servers(sv)
    sv.voice.media = callRtc
    sv.voice.consent = (hosts, ik) => relayBook.consent(hosts, ik)
    sv.voice.denied = ik => {
      const at = sv.voice.current()
      p2pHost.toast(RELAY_DENIED_TEXT, at ? memberName(at.room, ik) : 'a member')
    }
    sv.voice.onChange(() => {
      const cur = sv.voice.current()
      const was = useP2p.getState().voice
      if (cur?.room !== was?.room || cur?.ch !== was?.ch) useP2p.setState({ voice: cur })
    })
    put.pingLog(new PingLog({ store: s, dms: d, servers: sv, onWrite: pingLogged }))
    sv.onChange(room => {
      data?.postMessage({ room })
      scheduleServer(room)
    })
    sv.onArrive(a => serverArrived(a))
    sv.onTyping(room => scheduleServer(room))
    const c = new Calls({
      me: () => n.ik,
      sessions: ik => n.readySessions(ik),
      mutual: ik => n.contact(ik)?.state === 'mutual',
      roomOf: ik => dmRoomId(n.ik, ik),
      name: ik => contactName(ik),
      media: callRtc,
      plan: choice => relayBook.check(choice ?? relayBook.prefs.choice),
      hidesIp,
      consent: hosts => relayBook.consent(hosts),
      log: async (room, call) => {
        if (await s.room(room)) await d.logCall(room, call)
      },
      missed: (room, m) => void noteMissed(s, room, m).catch(() => {}),
      busy: () => p2pHost.inCall() || sv.voice.current() !== null,
      muted: () => p2pHost.muted(),
      save: p => void s.setMeta(PENDING_CALL, p).catch(() => {}),
      notice: text => p2pHost.toast(text),
      leaveOthers: () => {
        p2pHost.leaveInstanceCalls()
        sv.voice.leave()
      },
    })
    put.calls(c)
    n.use({
      attach: x => c.attach(x),
      ready: x => c.ready(x),
      keep: x => c.keeps(x),
      awake: () => c.awake() || sv.voice.current() !== null,
    })
    const bs = new Badges({
      store: s,
      verify: checkBinding,
      contacts: () => n.contactList(),
      warn: (ik, other) => n.warnAccount(ik, other),
    })
    put.badges(bs)
    n.onBinding((ik, token) => bs.offer(ik, token))
    bs.onChange(() => {
      data?.postMessage({ badges: true })
      scheduleBadges()
    })
    const k = new BadgeKeeper({
      node: n,
      checkable: () => peersCanCheck(shareOrigin(null), badgeLocal),
      request: (ik, ts, proof) => api.p2pBinding(ik, ts, proof),
      sub: accountSub,
      onIssued: () => void sv.refreshBadge().catch(() => {}),
    })
    put.keeper(k)
    c.onChange(() => publishCall(c))
    c.onRing(v => ringing(v))
    d.blobs.onChange(h => scheduleFile(h))
    put.data(dataChannel(username))
    if (data)
      data.onmessage = e => {
        if ((e.data as { ask?: unknown } | null)?.ask === 'call' && calls === c) publishCall(c)
      }
    d.onChange(room => {
      data?.postMessage({ room })
      scheduleRefresh(room)
    })
    d.onArrive(a => arrived(a))
    void d.recheckOutbox().catch(() => {})
    void s
      .meta<PendingCall>(PENDING_CALL)
      .then(p => c.recover(p && typeof p === 'object' && typeof p.id === 'string' ? p : null))
      .catch(() => {})
    put.unwatch(n.onChange(() => void mirror()))
    useP2p.setState({ enabled: true, loading: false, reader: false, me: n.ik })
    await mirror()
    if (node !== n) return
    await bs.start()
    mirrorBadges(bs.all())
    if (node !== n) return
    await d.start()
    if (node !== n) return
    await sv.start()
    if (node !== n) return
    await refreshRooms()
    refreshServers()
    const chat = useP2p.getState().chat
    if (chat) await loadChat(chat.room, chat.peer)
    await n.start()
    k.start()
    void d.blobs.resume().catch(() => {})
  } catch {
    if (live())
      useP2p.setState({ loading: false, error: "Couldn't open P2P storage in this browser" })
  }
}

// Called on every sign in and out (null): one node per account, none for guests.
export const p2pAccount = async (username: string | null) => {
  const cur = useP2p.getState()
  if (username !== null && cur.account === username && (node || leader || cur.loading)) return
  put.gen(gen + 1)
  shutdown()
  const was = useP2p.getState()
  const keepHome =
    username !== null && ((was.account === username && was.home) || readHome(username))
  useP2p.setState({ ...initial, account: username, home: keepHome, layout: readLayout(username) })
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
  // The limits P2P started with in this tab (the defaults before it starts).
  limits: () => limits,

  // `name` is shown to contacts; empty means "P2P user", never the account name.
  async enable(name = '') {
    const username = useP2p.getState().account
    if (!username || node || leader) return
    writeOn(username, true)
    useP2p.setState({ enabled: true, error: null })
    try {
      await navigator.storage?.persist?.()
    } catch {
      // Best effort: the browser may still evict the data.
    }
    run(username, name)
    void p2p.refreshStorage()
  },

  // Whether this browser holds P2P data of `username`.
  hasData: (username: string) => readOn(username),

  // Deletes the identity, contacts and everything else P2P from this browser, also while the
  // instance has P2P off and nothing runs. False when it failed.
  async removeData(username = useP2p.getState().account): Promise<boolean> {
    const running = useP2p.getState().account
    if (!username || (running !== null && running !== username)) return false
    put.gen(gen + 1)
    shutdown()
    writeOn(username, false)
    let ok = true
    try {
      await removeP2pDb(dbFor(username))
    } catch {
      ok = false
      // While P2P is off the flag is what offers removing the data again; while on, it would
      // start the identity again on the next load.
      if (running === null) writeOn(username, true)
    }
    const error = ok ? null : "Couldn't remove P2P data"
    if (useP2p.getState().account === username)
      useP2p.setState({ ...initial, account: username, layout: readLayout(username), error })
    else if (error) useP2p.setState({ error })
    return ok
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
  async resetIdentity() {
    await withNode(n => n.resetIdentity())
    void keeper?.refresh().catch(() => {})
  },
  resumeSending: () => withNode(n => n.resumeSending()),
  clearAlert: () => withNode(n => n.clearAlert()),
  clearDropped: () => withNode(n => n.clearDropped()),
  // Moves P2P from the tab that runs it to this one.
  useHere: () => leader?.takeOver(),

  openHome: () => {
    writeHome(useP2p.getState().account)
    useP2p.setState(st => ({
      home: true,
      server: null,
      chat: st.chat?.ch ? null : st.chat,
      pins: st.chat?.ch ? null : st.pins,
      panel: null,
      thread: null,
    }))
  },
  closeHome: () => {
    writeHome(null)
    if (useP2p.getState().server) p2pServer.close()
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
