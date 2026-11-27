import { resolve as resolveNotify } from '../../notify'
import { P2pStore } from '../db'
import type { MissedCall } from '../dm'
import { JoinAborted, RtcManager } from '../../rtc'
import { hidesIp } from '../../relays'
import { endWatch, TIMED_OUT_CAMERA, TIMED_OUT_SHARE, timedOutLine } from '../../timeouts'
import { Calls, type CallView } from '../calls'
import type { P2pState } from './store'
import type { IdentityScope, P2pParts } from './scope'

export const CALL_ELSEWHERE = 'Call in another tab.'

export function createCallsPart(
  parts: Pick<P2pParts, 'servers' | 'viewing' | 'store' | 'dms' | 'account'>,
  scope: IdentityScope
) {
  const state = parts.store
  const { useP2p, p2pHost } = state

  // ----- Calls -----

  const PENDING_CALL = 'call:out'

  const missedKey = (room: string) => `missed:${room}`

  const readMissed = (x: unknown): MissedCall[] =>
    Array.isArray(x)
      ? x.filter(
          (m): m is MissedCall =>
            typeof m === 'object' &&
            m !== null &&
            typeof (m as MissedCall).id === 'string' &&
            typeof (m as MissedCall).from === 'string' &&
            typeof (m as MissedCall).video === 'boolean' &&
            Number.isSafeInteger((m as MissedCall).at)
        )
      : []

  const noteMissed = async (s: P2pStore, room: string, m: MissedCall) => {
    const list = readMissed(await s.meta<unknown>(missedKey(room))).filter(x => x.id !== m.id)
    list.push(m)
    await s.setMeta(missedKey(room), list.slice(-state.limits.dm.missedMax))
    state.data?.postMessage({ room })
    scheduleRefresh(room)
  }

  const elsewhereCall = (x: unknown): P2pState['callElsewhere'] => {
    if (typeof x !== 'object' || x === null) return null
    const { room, peer } = x as { room?: unknown; peer?: unknown }
    return typeof room === 'string' && typeof peer === 'string' ? { room, peer } : null
  }

  const publishCall = (c: Calls) => {
    if (state.calls !== c) return
    const call = c.view()
    useP2p.setState(st => ({ call, callQuiet: call ? st.callQuiet : false }))
    state.data?.postMessage({ call: call ? { room: call.room, peer: call.peer } : null })
  }

  // An incoming call rings by the conversation's notification level: "Nothing" or muted keeps it
  // to the conversation itself; otherwise the call card, and a desktop notification when the tab
  // is in the background.
  const ringing = (v: CallView) => {
    const rule = resolveNotify(p2pHost.prefs(), { kind: 'p2p', room: v.room }, Date.now())
    const quiet = rule.muted || rule.level === 'nothing'
    useP2p.setState({ callQuiet: quiet })
    if (quiet || typeof document === 'undefined' || document.visibilityState === 'visible') return
    p2pHost.alert({
      key: `p2p-call:${v.id}`,
      actor: parts.dms.p2pUser(v.peer),
      action: v.video ? 'is video calling you' : 'is calling you',
      body: '',
      server: null,
      channel: null,
      dm: true,
      message: true,
      name: parts.dms.contactName(v.peer),
      generic: 'Incoming call',
      go: () => {
        parts.account.p2p.openHome()
        void parts.dms.p2pDm.openDm(v.peer)
      },
    })
  }

  // The media of calls with contacts and of voice channels in P2P servers (one at a time): rtc.ts,
  // signaled over the sessions and with the ICE plan of the call or channel (relays.ts), so relay
  // only and the relay prompt work as in instance P2P calls.
  const callRtc = new RtcManager({
    signaler: {
      send: (to, target, payload) =>
        target.ch !== undefined
          ? state.servers?.voice.send(to, target, payload)
          : state.calls?.signaler.send(to, target, payload),
    },
    ice: () =>
      state.servers?.voice.current()
        ? state.servers.voice.config()
        : (state.calls?.config() ?? { iceServers: [], iceTransportPolicy: 'relay' }),
  })

  const ELSEWHERE_TEXT = 'P2P is open in another tab.'
  const NO_VIDEO_TEXT = "You can't share video in this voice channel"

  const callFailed = (e: unknown) => p2pHost.toast(e instanceof Error ? e.message : String(e))

  const mediaVideo = () => callRtc.videoTrack !== null || callRtc.sharing

  // When our timeout in `room` ends (ms), while it runs.
  const timedOutEnds = (room: string | undefined) => {
    const until = room === undefined ? undefined : useP2p.getState().servers[room]?.timedOutUntil
    return until !== undefined && until > Date.now() ? until : null
  }

  // Voice channels of P2P servers: joining leaves any other call or voice channel first.
  const p2pVoice = {
    active: () => !!state.servers?.voice.current() && callRtc.active(),
    // A timeout in the room of the voice channel we are in mutes us and stops our video.
    timedOut: () => timedOutEnds(state.servers?.voice.current()?.room) !== null,
    async join(room: string, ch: string) {
      const account = scope.owner
      const relayBook = account.relays
      const sv = state.servers
      if (!sv) return p2pHost.toast(ELSEWHERE_TEXT)
      const ends = timedOutEnds(room)
      if (ends !== null) return p2pHost.toast(timedOutLine(ends))
      const at = useP2p.getState().server
      if (
        at?.room !== room ||
        at.ch !== ch ||
        !parts.viewing.peerVisible(useP2p.getState(), room, ch)
      ) {
        if (!(await parts.servers.p2pServer.open(room, ch))) return
      }
      const cur = sv.voice.current()
      if (cur?.room === room && cur.ch === ch) return
      try {
        // Other calls end only once this join may go ahead.
        await sv.voice.join(room, ch, {
          plan: async () => {
            const plan = await relayBook.check(relayBook.prefs.choice)
            return { config: plan.config, declared: plan.declared, hidesIp: hidesIp(plan) }
          },
          muted: () =>
            account.store.getState().selfAudio.muted || !sv.voice.rights(room, ch, sv.me).speak,
        })
        if (
          !parts.viewing.peerVisible(useP2p.getState(), room, ch) &&
          sv.voice.current()?.ch === ch
        )
          sv.voice.leave()
      } catch (e) {
        if (!(e instanceof JoinAborted)) callFailed(e)
      }
    },
    leave: () => state.servers?.voice.leave(),
    // Whether the channel we are in takes our audio, and our camera or screen.
    speaks: () => state.servers?.voice.myRights().speak ?? true,
    shows: () => state.servers?.voice.myRights().video ?? true,
    // A camera or a screen share went on or off (the others show the notice for video).
    videoChanged: () => state.servers?.voice.setVideo(mediaVideo()),
    // Our mic or sound went on or off.
    audioChanged: () => state.servers?.voice.setAudio(),
    async camera() {
      try {
        const on = callRtc.videoTrack === null
        if (on && !p2pVoice.shows()) throw new Error(NO_VIDEO_TEXT)
        if (on && p2pVoice.timedOut()) throw new Error(TIMED_OUT_CAMERA)
        await callRtc.camera(on)
      } catch (e) {
        callFailed(e)
      }
      p2pVoice.videoChanged()
    },
    async share() {
      try {
        const on = !callRtc.sharing
        if (on && !p2pVoice.shows()) throw new Error(NO_VIDEO_TEXT)
        if (on && p2pVoice.timedOut()) throw new Error(TIMED_OUT_SHARE)
        await callRtc.share(on)
      } catch (e) {
        callFailed(e)
      }
      p2pVoice.videoChanged()
    },
  }

  // Our timeout in the room of the voice channel we are in: the mic limits are applied when it
  // starts, changes or is removed, and again when it ends by the clock.
  const micWatch = endWatch(
    () => timedOutEnds(state.servers?.voice.current()?.room),
    () => p2pHost.micChanged()
  )
  scope.onDispose(
    useP2p.subscribe((s, prev) => {
      if (s.servers !== prev.servers || s.voice !== prev.voice) micWatch.sync()
    })
  )
  scope.onDispose(micWatch.stop)

  const p2pCall = {
    async start(ik: string, video: boolean, choice?: string) {
      const c = state.calls
      if (!c) return p2pHost.toast(ELSEWHERE_TEXT)
      try {
        const started = await c.start(ik, video, choice)
        if (started && video && state.calls === c && c.view()) await callRtc.camera(true)
      } catch (e) {
        callFailed(e)
      }
    },
    async accept() {
      const c = state.calls
      if (!c) return
      useP2p.setState({ callAccepting: true })
      try {
        await c.accept()
      } catch (e) {
        callFailed(e)
      } finally {
        useP2p.setState({ callAccepting: false })
      }
    },
    decline: () => state.calls?.decline(),
    hangup: () => state.calls?.hangup(),
    // Media is up: our own call, or one we answered.
    media: () => {
      const v = state.calls?.view()
      return !!v && (v.dir === 'out' || v.state === 'active')
    },
    async camera() {
      try {
        await callRtc.camera(callRtc.videoTrack === null)
      } catch (e) {
        callFailed(e)
      }
    },
    async share() {
      try {
        await callRtc.share(!callRtc.sharing)
      } catch (e) {
        callFailed(e)
      }
    },
  }

  // Bursts of changes (a backfill) reload the view once.
  const scheduleRefresh = (room: string) => {
    if (parts.dms.timers.has(room)) return
    parts.dms.timers.set(
      room,
      setTimeout(() => {
        parts.dms.timers.delete(room)
        void parts.dms.refreshRoom(room)
      }, 30)
    )
  }

  callRtc.onChange = () => {
    if (!scope.current()) return
    scope.owner.store.setState(s => ({ rtcTick: s.rtcTick + 1 }))
    p2pVoice.videoChanged()
  }

  scope.onDispose(() => callRtc.dispose())
  return {
    PENDING_CALL,
    missedKey,
    readMissed,
    noteMissed,
    elsewhereCall,
    publishCall,
    ringing,
    callRtc,
    CALL_ELSEWHERE,
    ELSEWHERE_TEXT,
    p2pVoice,
    p2pCall,
    scheduleRefresh,
  }
}
