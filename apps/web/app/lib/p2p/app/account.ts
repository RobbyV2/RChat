import { client } from '../../client/client'
import type { AccountSession } from '../../client/session'
import { instanceLabel } from '../../instance_label'
import { sessionStore, shareOrigin } from '../../instances'
import { probeAddress } from '../../ice'
import { keepAsker } from '../keep'
import { dbName, P2pStore, removeP2pDb } from '../db'
import { BadgeKeeper, Badges, peersCanCheck, readSlots } from '../badge'
import { fingerprint, keyId } from '../keys'
import type { AddResult } from '../contacts'
import { dmRoomId, Dms } from '../dm'
import { PingLog } from '../ping_log'
import { freeSpace, storageSpace } from '../files'
import { pausesHidden } from '../../platform'
import { TabLeader, webLeaderDeps } from '../leader'
import { P2pNode, squatted, type Visibility } from '../node'
import { PeerTransport } from '../transport'
import { hidesIp } from '../../relays'
import { Calls, type PendingCall } from '../calls'
import { RELAY_DENIED_TEXT } from '../voice'
import { Servers } from '../server'
import { runtimeLimits } from '../user_limits'
import { LOCAL, type Local } from '../limits'
import type { P2pDialog } from './store'
import type { IdentityScope, P2pParts } from './scope'
import { loaded } from '../../perms'
import { loadPermissionRules } from '../../perms_load'
import { unavailable } from '../../capabilities'

const RULES_UNAVAILABLE = unavailable(
  "P2P couldn't load its permission rules. Reload to try again."
)

// How long signed leaves get to reach the connected members before the identity stops.
export const RETIRE_FLUSH_MS = 400
// How long an identity that is being removed gets to come online in this tab, how much of that
// the members of its servers get to connect, and how long leaves that fail are tried again.
const RETIRE_START_MS = 15_000
const RETIRE_REACH_MS = 5_000
const RETIRE_RETRY_MS = 5_000
const RETIRE_POLL_MS = 100

const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

export function createAccountPart(
  parts: Pick<
    P2pParts,
    'store' | 'badge' | 'calls' | 'dms' | 'servers' | 'inbox' | 'attachments' | 'rail'
  >,
  scope: IdentityScope
) {
  const state = parts.store
  const { useP2p, p2pHost, writeHome, initial, put, readAuto, readHome, readOn, writeOn } = state

  const pageVisibility: Visibility = {
    visible: () => typeof document === 'undefined' || document.visibilityState !== 'hidden',
    pauses: () => pausesHidden(),
    onChange: fn => {
      if (typeof globalThis.document?.addEventListener !== 'function') return () => {}
      document.addEventListener('visibilitychange', fn)
      return () => document.removeEventListener('visibilitychange', fn)
    },
  }

  // Leaving the page says goodbye to every contact, so they see us go offline at once. A page
  // restored from the back-forward cache starts again.
  if (
    typeof globalThis.window?.addEventListener === 'function' &&
    typeof globalThis.document?.addEventListener === 'function'
  ) {
    // Frames are sealed asynchronously and a page that unloads doesn't wait for that, so what
    // pagehide sends is best effort (a contact call's `end` usually doesn't get out). A voice
    // channel's leave goes out on beforeunload instead, while there is still time; a page that
    // stays after all says it is back as soon as it is used again.
    const events = new AbortController()
    scope.onDispose(() => events.abort())
    const options = { signal: events.signal }
    window.addEventListener('beforeunload', () => state.servers?.voice.goodbye(), options)
    const back = () => state.servers?.voice.back()
    window.addEventListener('pointerdown', back, { ...options, capture: true })
    window.addEventListener('keydown', back, { ...options, capture: true })
    document.addEventListener(
      'visibilitychange',
      () => {
        if (document.visibilityState === 'visible') back()
      },
      options
    )
    window.addEventListener(
      'pagehide',
      () => {
        // Session.close still sends what was queued first, when the page lives long enough.
        state.calls?.stop()
        state.servers?.voice.leave()
        state.node?.stop()
      },
      options
    )
    window.addEventListener(
      'pageshow',
      e => {
        if (e.persisted && state.node) void state.node.start()
      },
      options
    )
  }

  const owner = scope.owner
  const connection = () => owner.conn

  const homeLabel = () => instanceLabel(connection().info, connection().host)

  const dbFor = (username: string) => {
    const name = dbName(scope.dbHost(username), username)
    return scope.localId === 'main' ? name : `${name}~${scope.localId}`
  }

  // The node's view into the store; our own badge change is told to the reader tabs (`post`).
  const mirrorFrom = async (
    n: Pick<P2pNode, 'view' | 'paused' | 'myCard'>,
    post: (m: { badges: true }) => void
  ) => {
    const v = n.view()
    parts.badge.tellBadge(useP2p.getState().badge, v.badge, post)
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
      error: v.status === 'squatted' ? squatted(homeLabel()) : null,
    })
    const card = await n.myCard().catch(() => null)
    if (state.node === n) useP2p.setState({ card })
  }

  const mirror = async () => {
    const n = state.node
    if (n) await mirrorFrom(n, m => state.data?.postMessage(m))
  }

  const stopNode = () => {
    state.unwatch?.()
    put.unwatch(null)
    if (state.calls) {
      state.calls.stop()
      put.calls(null)
      state.data?.postMessage({ call: null })
    }
    if (useP2p.getState().call) useP2p.setState({ call: null, callQuiet: false })
    state.servers?.stop()
    if (useP2p.getState().voice) useP2p.setState({ voice: null })
    put.servers(null)
    state.pingLog?.stop()
    put.pingLog(null)
    state.keeper?.stop()
    put.keeper(null)
    state.badges?.stop()
    put.badges(null)
    state.dms?.stop()
    put.dms(null)
    state.node?.stop()
    put.node(null)
    state.store?.close()
    put.store(null)
    stopReader()
  }

  const stopReader = () => {
    state.reader?.store.close()
    put.reader(null)
    state.data?.close()
    put.data(null)
  }

  const dataChannel = (username: string) =>
    (scope.options.leaderDeps ?? webLeaderDeps)().channel(`${dbFor(username)}:data`)

  const shutdown = () => {
    const l = state.leader
    put.leader(null)
    stopNode()
    scope.reset()
    void l?.stop()
  }

  // The view fields a node fills in; cleared when this tab hands P2P to another one.
  const nodeless = () => {
    const {
      account,
      enabled,
      home: h,
      dmList,
      dialog,
      chat,
      drafts,
      server,
      layout,
    } = useP2p.getState()
    return {
      ...initial,
      account,
      enabled,
      home: h,
      dmList,
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
        if (state.reader?.store === s) stopReader()
      })
      const self = await s.self()
      if (!live() || !self) return s.close()
      stopReader()
      put.limits(state.identityLimits(username))
      put.reader({ store: s, me: keyId(self.ik.pk) })
      const ch = dataChannel(username)
      const rooms = parts.dms.refreshRooms()
      // Apply broadcasts after the initial snapshot and in arrival order.
      let roomUpdates = rooms.catch(() => {})
      if (ch) {
        ch.onmessage = e => {
          const msg = e.data as {
            room?: unknown
            call?: unknown
            badges?: unknown
            inbox?: unknown
          } | null
          if (msg && 'call' in msg)
            return useP2p.setState({ callElsewhere: parts.calls.elsewhereCall(msg.call) })
          if (msg && 'inbox' in msg) return useP2p.setState(st => ({ pingLog: st.pingLog + 1 }))
          if (msg && 'badges' in msg)
            return void Promise.all([readSlots(s), s.self()]).then(
              ([slots, me]) => {
                if (state.reader?.store !== s) return
                parts.badge.mirrorBadges(Object.fromEntries(slots))
                // Our own badge changed in the leading tab too.
                if (me) useP2p.setState({ badge: me.badge ?? null })
              },
              () => {}
            )
          const room = msg?.room
          if (typeof room !== 'string') return
          roomUpdates = roomUpdates
            .then(async () => {
              if (state.reader?.store === s) await parts.dms.refreshRoom(room)
            })
            .catch(() => {})
          void s.contacts().then(
            contacts => state.reader?.store === s && useP2p.setState({ contacts }),
            () => {}
          )
        }
        put.data(ch)
        ch.postMessage({ ask: 'call' })
      }
      const contacts = await s.contacts()
      if (!live() || state.reader?.store !== s) return
      useP2p.setState({
        reader: true,
        me: state.reader!.me,
        contacts,
        ik: state.reader!.me,
        name: self.profile.name,
        fingerprint: fingerprint(state.reader!.me),
        badge: self.badge ?? null,
      })
      const slots = await readSlots(s)
      if (!live() || state.reader?.store !== s) return
      parts.badge.mirrorBadges(Object.fromEntries(slots))
      await rooms
      if (!live() || state.reader?.store !== s) return
      useP2p.setState({ countsLoaded: {} })
      const chat = useP2p.getState().chat
      if (chat) await parts.dms.loadChat(chat.room, chat.peer)
    } catch {
      // The leader's copy is all there is; this tab just shows the notice.
    }
  }

  // Runs P2P in this tab once it holds the account's lock; until then the tab shows a notice.
  // `create` is the name for a new identity, when one should be made.
  // P2P decides through the shared permission rules, so nothing starts before they are loaded.
  const run = (username: string, create: string | null) => {
    if (loaded()) return start(username, create)
    const mine = state.gen
    const live = () => mine === state.gen && scope.current(username)
    useP2p.setState({ loading: true })
    void loadPermissionRules().then(
      () => {
        if (live()) start(username, create)
      },
      () => {
        if (live()) useP2p.setState({ loading: false, error: RULES_UNAVAILABLE })
      }
    )
  }

  const start = (username: string, create: string | null) => {
    if (!scope.current(username)) return
    const mine = state.gen
    // Bumped on every resign, so a boot still in flight stops instead of starting a second node.
    let term = 0
    const hooks = {
      lead: (): Promise<void> => {
        const t = ++term
        return mine === state.gen
          ? boot(
              username,
              create,
              l,
              () => scope.current(username) && mine === state.gen && t === term
            )
          : Promise.resolve()
      },
      resign: async () => {
        term++
        if (mine !== state.gen || state.leader !== l) return
        stopNode()
        if (mine === state.gen) useP2p.setState(nodeless())
      },
      follow: () => {
        if (mine !== state.gen) return
        useP2p.setState({ ...nodeless(), elsewhere: true })
        void read(
          username,
          () => scope.current(username) && mine === state.gen && l.state !== 'leading'
        )
      },
    }
    const lim = runtimeLimits(state.identityLimits(username)).leader
    const l: TabLeader = new TabLeader(
      dbFor(username),
      hooks,
      (scope.options.leaderDeps ?? webLeaderDeps)(),
      lim
    )
    put.leader(l)
    useP2p.setState({ loading: true })
    l.start()
  }

  // What the P2P runtime of `username` starts with, besides the store and its parts: the account's
  // limits for each part, and this page's hooks.
  const startDeps = (username: string, lim: Readonly<Local> = state.identityLimits(username)) => {
    const rt = runtimeLimits(lim)
    return {
      account: scope.owner,
      limits: lim,
      transport: rt.transport,
      calls: rt.calls,
      badge: rt.badge,
      inbox: rt.inbox,
      node: { host: connection().host, visibility: pageVisibility, ...rt.node },
      dms: {
        ...rt.dms,
        attachments: () => !p2pHost.textOnly(),
        label: homeLabel,
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

  type StartDeps = ReturnType<typeof startDeps>

  // The account's node on its open store (null: no identity yet, and none to make).
  const openNode = (deps: StartDeps, s: P2pStore, create?: { name: string }) =>
    P2pNode.open(
      {
        ...deps.node,
        store: s,
        transport:
          scope.options.transport?.(deps.transport, deps.account) ??
          new PeerTransport(deps.transport, undefined, undefined, deps.account),
      },
      create
    )

  // The rest of the account's P2P runtime on its store and node.
  const startParts = (deps: StartDeps, s: P2pStore, n: P2pNode) => {
    const d = new Dms({ ...deps.dms, node: n, store: s })
    const { account } = deps
    const sv = new Servers({
      ...deps.servers,
      node: n,
      store: s,
      dms: d,
      audio: () => {
        const { muted, deafened } = account.store.getState().selfAudio
        return { muted, deafened }
      },
    })
    const pingLog = new PingLog({
      store: s,
      dms: d,
      servers: sv,
      onWrite: parts.inbox.pingLogged,
      limits: deps.inbox,
    })
    const claim = (kind: 'p2p-voice' | 'p2p-call', leave: () => void, valid: () => boolean) =>
      client.calls.request(
        { account, identity: scope.localId, kind },
        leave,
        () => state.node === n && valid()
      )
    sv.voice.consent = (hosts, ik) => account.relays.consent(hosts, ik)
    sv.voice.claim = (leave, valid) => claim('p2p-voice', leave, valid)
    const calls = new Calls({
      me: () => n.ik,
      sessions: ik => n.readySessions(ik),
      mutual: ik => n.contact(ik)?.state === 'mutual',
      roomOf: ik => dmRoomId(n.ik, ik),
      name: ik => parts.dms.contactName(ik),
      media: parts.calls.callRtc,
      plan: choice => account.relays.check(choice ?? account.relays.prefs.choice),
      hidesIp,
      consent: hosts => account.relays.consent(hosts),
      log: async (room, call) => {
        if (await s.room(room)) await d.logCall(room, call)
      },
      missed: (room, m) => void parts.calls.noteMissed(s, room, m).catch(() => {}),
      busy: () => client.calls.current() !== null,
      muted: () => account.store.getState().selfAudio.muted,
      save: p => void s.setMeta(parts.calls.PENDING_CALL, p).catch(() => {}),
      notice: text => p2pHost.toast(text),
      claim: (leave, valid) => claim('p2p-call', leave, valid),
      limits: deps.calls,
    })
    const badges = new Badges({
      store: s,
      verify: parts.badge.checkBinding,
      contacts: () => n.contactList(),
      warn: (ik, other) => n.warnAccount(ik, other),
      limits: deps.badge,
    })
    const keeper = new BadgeKeeper({
      node: n,
      checkable: () =>
        peersCanCheck(shareOrigin(null, undefined, connection()), parts.badge.badgeLocal),
      label: homeLabel,
      request: (ik, ts, proof) => account.api.p2pBinding(ik, ts, proof),
      sub: parts.badge.accountSub,
      onIssued: () => void sv.refreshBadge().catch(() => {}),
      limits: deps.badge,
    })
    return { dms: d, servers: sv, pingLog, calls, badges, keeper }
  }

  // Never waited on (keep.ts); asked again at a later start after a dismissed prompt.
  const keep = keepAsker(() => sessionStore)

  const storageManager = () => (typeof navigator === 'undefined' ? undefined : navigator.storage)

  const boot = async (
    username: string,
    create: string | null,
    l: TabLeader,
    live: () => boolean
  ) => {
    useP2p.setState({ loading: true, elsewhere: false })
    try {
      const s = await P2pStore.open(dbFor(username), () => {
        // Another tab removed the data or upgraded the schema: start over from what is stored.
        if (state.store !== s) return
        put.gen(state.gen + 1)
        shutdown()
        useP2p.setState({ loading: false })
        void p2pAccount(useP2p.getState().account)
      })
      if (!live()) return s.close()
      const deps = startDeps(username)
      const n = await openNode(deps, s, create !== null ? { name: create } : undefined)
      if (!live()) {
        n?.stop()
        return s.close()
      }
      if (!n) {
        s.close()
        writeOn(username, false)
        if (state.leader === l) put.leader(null)
        void l.stop()
        useP2p.setState({ ...initial, account: username })
        return
      }
      put.store(s)
      put.node(n)
      put.limits(deps.limits)
      stopReader()
      const {
        dms: d,
        servers: sv,
        pingLog: pl,
        calls: c,
        badges: bs,
        keeper: k,
      } = startParts(deps, s, n)
      put.dms(d)
      put.servers(sv)
      sv.voice.media = parts.calls.callRtc
      parts.calls.callRtc.heardMuted = ik => sv.voice.heardMuted(ik)
      sv.voice.denied = ik => {
        const at = sv.voice.current()
        p2pHost.toast(RELAY_DENIED_TEXT, at ? parts.servers.memberName(at.room, ik) : 'a member')
      }
      sv.voice.onChange(() => {
        const cur = sv.voice.current()
        const was = useP2p.getState().voice
        if (cur?.room !== was?.room || cur?.ch !== was?.ch) useP2p.setState({ voice: cur })
      })
      put.pingLog(pl)
      sv.onChange(room => {
        state.data?.postMessage({ room })
        parts.servers.scheduleServer(room)
      })
      sv.onArrive(a => parts.servers.serverArrived(a))
      sv.onAimed(targets => parts.inbox.heldTouched(targets))
      sv.onTyping(room => parts.servers.scheduleServer(room))
      put.calls(c)
      n.use({
        attach: x => c.attach(x),
        ready: x => c.ready(x),
        keep: x => c.keeps(x),
        awake: () => c.awake() || sv.voice.current() !== null,
      })
      put.badges(bs)
      n.onBinding((ik, token) => bs.offer(ik, token))
      bs.onChange(() => {
        state.data?.postMessage({ badges: true })
        parts.badge.scheduleBadges()
      })
      put.keeper(k)
      c.onChange(() => parts.calls.publishCall(c))
      c.onRing(v => parts.calls.ringing(v))
      d.blobs.onChange(h => parts.attachments.scheduleFile(h))
      put.data(dataChannel(username))
      if (state.data)
        state.data.onmessage = e => {
          if ((e.data as { ask?: unknown } | null)?.ask === 'call' && state.calls === c)
            parts.calls.publishCall(c)
        }
      d.onChange(room => {
        state.data?.postMessage({ room })
        parts.calls.scheduleRefresh(room)
      })
      d.onArrive(a => parts.dms.arrived(a))
      d.onAimed(targets => parts.inbox.heldTouched(targets))
      void d.recheckOutbox().catch(() => {})
      void s
        .meta<PendingCall>(parts.calls.PENDING_CALL)
        .then(p => c.recover(p && typeof p === 'object' && typeof p.id === 'string' ? p : null))
        .catch(() => {})
      put.unwatch(n.onChange(() => void mirror()))
      useP2p.setState({ enabled: true, loading: false, reader: false, me: n.ik })
      await mirror()
      if (state.node !== n) return
      await bs.start()
      if (state.node !== n) return
      parts.badge.mirrorBadges(bs.all())
      if (state.node !== n) return
      await d.start()
      if (state.node !== n) return
      await sv.start()
      if (state.node !== n) return
      await parts.dms.refreshRooms()
      if (!live() || state.node !== n) return
      parts.servers.refreshServers()
      useP2p.setState({ countsLoaded: {} })
      const chat = useP2p.getState().chat
      if (chat) await parts.dms.loadChat(chat.room, chat.peer)
      // The instance's PeerJS address, on a first visit (later ones keep it).
      if (!connection().info) await owner.discovery.settled(LOCAL.misc.infoWaitMs)
      if (state.node !== n) return
      await n.start()
      if (state.node !== n) return
      k.start()
      void d.blobs.resume().catch(() => {})
      void checkAddress(n, deps.account).catch(() => {})
      void keep(storageManager())
    } catch {
      if (live())
        useP2p.setState({ loading: false, error: "Couldn't open P2P storage in this browser" })
    }
  }

  // Relay only hides the address on purpose, and connects through the relay.
  const checkAddress = async (n: P2pNode, account: AccountSession) => {
    const { iceServers, iceTransportPolicy } = account.relays.autoConfig()
    if (iceTransportPolicy === 'relay') return
    const seen = await probeAddress({ iceServers })
    if (state.node === n) useP2p.setState({ addressHidden: seen === 'hidden' })
  }

  // Stop the transport and invalidate pending node opens. This app is pinned to one
  // account lifetime, so its drafts can stay in memory until reactivation or signout.
  const park = () => {
    if (!scope.current()) return
    put.gen(state.gen + 1)
    shutdown()
    useP2p.setState({ ...initial, drafts: useP2p.getState().drafts })
  }

  // Called on every sign in and out (null): one node per account, none for guests.
  const p2pAccount = async (username: string | null) => {
    if (scope.disposed || (username !== null && !scope.current(username))) return
    const cur = useP2p.getState()
    if (
      username !== null &&
      cur.account === username &&
      (state.node || state.leader || cur.loading)
    )
      return
    put.gen(state.gen + 1)
    shutdown()
    const was = useP2p.getState()
    const keepHome =
      username !== null && ((was.account === username && was.home) || readHome(username))
    useP2p.setState({
      ...initial,
      account: username,
      drafts: username === null ? initial.drafts : was.drafts,
      home: keepHome,
      layout: parts.rail.readLayout(username),
    })
    if (username === null || !readOn(username)) return
    useP2p.setState({ enabled: true })
    run(username, null)
  }

  const withNode = async <T>(fn: (n: P2pNode) => Promise<T>): Promise<T | null> => {
    const n = state.node
    if (!n || !scope.current()) return null
    try {
      return await fn(n)
    } catch (e) {
      if (state.node === n && scope.current())
        useP2p.setState({ error: e instanceof Error ? e.message : String(e) })
      return null
    }
  }

  // This tab runs the identity's node and it is online.
  const onlineHere = () => !!state.servers && state.node?.status === 'online'

  const p2p = {
    // The limits P2P started with in this tab (the defaults before it starts).
    limits: () => state.limits,

    // `name` is shown to contacts; empty means "P2P user", never the account name.
    async enable(name = '') {
      const username = useP2p.getState().account
      if (!username || !scope.current(username) || state.node || state.leader) return
      writeOn(username, true)
      useP2p.setState({ enabled: true, error: null })
      void keep(storageManager())
      run(username, name)
      void p2p.refreshStorage()
    },

    // Whether this browser holds P2P data of `username`.
    hasData: (username: string) => scope.current(username) && readOn(username),

    // Deletes the identity, contacts and everything else P2P from this browser, also while the
    // instance has P2P off and nothing runs. False when it failed.
    async removeData(username = useP2p.getState().account): Promise<boolean> {
      const running = useP2p.getState().account
      if (!username || !scope.current(username) || (running !== null && running !== username))
        return false
      const name = dbFor(username)
      const mine = state.gen + 1
      const live = () => mine === state.gen && scope.current(username) && name === dbFor(username)
      put.gen(mine)
      shutdown()
      if (!live()) return false
      writeOn(username, false)
      let ok = true
      try {
        await removeP2pDb(name)
      } catch {
        ok = false
        // While P2P is off the flag is what offers removing the data again; while on, it would
        // start the identity again on the next load.
        if (running === null && live()) writeOn(username, true)
      }
      if (!live()) return ok
      const error = ok ? null : "Couldn't remove P2P data"
      if (useP2p.getState().account === username)
        useP2p.setState({
          ...initial,
          account: username,
          layout: parts.rail.readLayout(username),
          error,
        })
      else if (error) useP2p.setState({ error })
      if (ok) owner.identities.dataRemoved(username, scope.localId)
      return ok
    },

    // Runs this identity in this tab, for steps that sign with it: a parked identity starts here
    // and one that another tab runs moves here. Then the members of its servers get a moment to
    // connect. False when it is not online here within `ms`.
    async runHere(username: string, ms = RETIRE_START_MS): Promise<boolean> {
      const until = Date.now() + ms
      while (!onlineHere()) {
        if (!scope.current(username) || !readOn(username) || Date.now() >= until) return false
        const l = state.leader
        if (!l) await p2pAccount(username)
        else if (l.state === 'waiting') l.takeOver()
        await pause(RETIRE_POLL_MS)
      }
      const sv = state.servers!
      const reach = Math.min(until, Date.now() + RETIRE_REACH_MS)
      const unreached = () =>
        sv.serverRooms().some(r => sv.myMembership(r.id) === 'join' && !sv.online(r.id))
      while (state.servers === sv && unreached() && Date.now() < reach) await pause(RETIRE_POLL_MS)
      return onlineHere()
    },

    // Leaves every P2P server of this identity with a signed leave, then deletes the identity,
    // its device key and everything else P2P from this browser. The identity has to be online
    // in this tab (`runHere`). False when the data stayed: it is not, or a server was not left.
    async retire(username = useP2p.getState().account): Promise<boolean> {
      const sv = state.servers
      if (!username || !scope.current(username) || !sv || !onlineHere()) return false
      const until = Date.now() + RETIRE_RETRY_MS
      let kept = await sv.retire().catch(() => null)
      while (kept?.length !== 0 && state.servers === sv && Date.now() < until) {
        await pause(RETIRE_POLL_MS)
        kept = await sv.retire().catch(() => null)
      }
      if (kept?.length !== 0 || state.servers !== sv) return false
      await pause(RETIRE_FLUSH_MS)
      if (state.servers !== sv) return false
      return p2p.removeData(username)
    },

    setPaused: (on: boolean) => withNode(n => n.setPaused(on)),
    retry: () => withNode(n => n.retry()),
    dismissAddress: () => useP2p.setState({ addressHidden: false }),
    addContact: (text: string, intro = ''): Promise<AddResult | null> =>
      withNode(n => n.addContact(text, intro)),
    readCard: (text: string) => withNode(n => n.readCard(text)),
    accept: (ik: string) => withNode(n => n.accept(ik)),
    ignore: (ik: string) => withNode(n => n.ignore(ik)),
    block: (ik: string) => withNode(n => n.block(ik)),
    remove: (ik: string) => withNode(n => n.remove(ik)),
    rename: (ik: string, name: string) => withNode(n => n.rename(ik, name)),
    markVerified: (ik: string) => withNode(n => n.markVerified(ik)),
    verifyCode: (ik: string) => state.node?.verifyCodeFor(ik) ?? null,
    scanVerify: (ik: string, text: string) => withNode(n => n.scanVerifyCode(ik, text)),
    setName: (name: string) => withNode(n => n.setName(name)),
    async resetIdentity() {
      await withNode(n => n.resetIdentity())
      void state.keeper?.refresh().catch(() => {})
    },
    resumeSending: () => withNode(n => n.resumeSending()),
    clearAlert: () => withNode(n => n.clearAlert()),
    clearDropped: () => withNode(n => n.clearDropped()),
    // Moves P2P from the tab that runs it to this one.
    useHere: () => state.leader?.takeOver(),

    // A conversation open beside the DM list closes, so the P2P home opens on its contacts.
    openHome: () => {
      writeHome(useP2p.getState().account)
      useP2p.setState(st => {
        const drop = st.dmList || Boolean(st.chat?.ch)
        return {
          home: true,
          dmList: false,
          server: null,
          chat: drop ? null : st.chat,
          pins: drop ? null : st.pins,
          ...(st.dmList ? { editing: null, replying: null } : {}),
          panel: null,
          thread: null,
        }
      })
    },
    // A conversation open beside the DM list closes with it.
    closeHome: () => {
      writeHome(null)
      const { server, dmList } = useP2p.getState()
      if (server) parts.servers.p2pServer.close()
      useP2p.setState({
        home: false,
        dmList: false,
        ...(dmList ? { chat: null, pins: null, threads: null, editing: null, replying: null } : {}),
      })
    },
    // The P2P home on its contacts, where the message requests are.
    openRequests: () => {
      p2p.openHome()
      useP2p.setState({ chat: null, pins: null, threads: null, editing: null, replying: null })
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

  return {
    dbFor,
    mirrorFrom,
    stopNode,
    run,
    startDeps,
    openNode,
    startParts,
    boot,
    p2pAccount,
    park,
    p2p,
  }
}
