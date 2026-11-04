import { resolve as resolveNotify } from '../../notify'
import { P2pStore } from '../db'
import { MISSED_MAX, type MissedCall } from '../dm'
import { JoinAborted, RtcManager } from '../../rtc'
import { hidesIp, relayBook } from '../../relays'
import { Calls, type CallView } from '../calls'
import { data, calls, useP2p, p2pHost, servers, type P2pState } from './store'
import { p2pUser, contactName, p2pDm, timers, refreshRoom } from './dms'
import { p2p } from './account'

// ----- Calls -----

export const PENDING_CALL = 'call:out'

export const missedKey = (room: string) => `missed:${room}`

export const readMissed = (x: unknown): MissedCall[] =>
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

export const noteMissed = async (s: P2pStore, room: string, m: MissedCall) => {
  const list = readMissed(await s.meta<unknown>(missedKey(room))).filter(x => x.id !== m.id)
  list.push(m)
  await s.setMeta(missedKey(room), list.slice(-MISSED_MAX))
  data?.postMessage({ room })
  scheduleRefresh(room)
}

export const elsewhereCall = (x: unknown): P2pState['callElsewhere'] => {
  if (typeof x !== 'object' || x === null) return null
  const { room, peer } = x as { room?: unknown; peer?: unknown }
  return typeof room === 'string' && typeof peer === 'string' ? { room, peer } : null
}

export const publishCall = (c: Calls) => {
  if (calls !== c) return
  const call = c.view()
  useP2p.setState(st => ({ call, callQuiet: call ? st.callQuiet : false }))
  data?.postMessage({ call: call ? { room: call.room, peer: call.peer } : null })
}

// An incoming call rings by the conversation's notification level: "Nothing" or muted keeps it
// to the conversation itself; otherwise the call card, and a desktop notification when the tab
// is in the background.
export const ringing = (v: CallView) => {
  const rule = resolveNotify(p2pHost.prefs(), { kind: 'p2p', room: v.room }, Date.now())
  const quiet = rule.muted || rule.level === 'nothing'
  useP2p.setState({ callQuiet: quiet })
  if (quiet || typeof document === 'undefined' || document.visibilityState === 'visible') return
  p2pHost.alert({
    key: `p2p-call:${v.id}`,
    actor: p2pUser(v.peer),
    action: v.video ? 'is video calling you' : 'is calling you',
    body: '',
    server: null,
    channel: null,
    dm: true,
    message: true,
    name: contactName(v.peer),
    generic: 'Incoming call',
    go: () => {
      p2p.openHome()
      void p2pDm.openDm(v.peer)
    },
  })
}

// The media of calls with contacts and of voice channels in P2P servers (one at a time): rtc.ts,
// signaled over the sessions and with the ICE plan of the call or channel (relays.ts), so relay
// only and the relay prompt work as in instance P2P calls.
export const callRtc = new RtcManager({
  signaler: {
    send: (to, target, payload) =>
      target.ch !== undefined
        ? servers?.voice.send(to, target, payload)
        : calls?.signaler.send(to, target, payload),
  },
  ice: () =>
    servers?.voice.current()
      ? servers.voice.config()
      : (calls?.config() ?? { iceServers: [], iceTransportPolicy: 'relay' }),
})

export const CALL_ELSEWHERE = 'Call in another tab.'

export const ELSEWHERE_TEXT = 'P2P is open in another tab.'

const callFailed = (e: unknown) => p2pHost.toast(e instanceof Error ? e.message : String(e))

const mediaVideo = () => callRtc.videoTrack !== null || callRtc.sharing

// Voice channels of P2P servers: joining leaves any other call or voice channel first.
export const p2pVoice = {
  active: () => !!servers?.voice.current() && callRtc.active(),
  async join(room: string, ch: string) {
    const sv = servers
    if (!sv) return p2pHost.toast(ELSEWHERE_TEXT)
    const cur = sv.voice.current()
    if (cur?.room === room && cur.ch === ch) return
    try {
      // Other calls end only once this join may go ahead.
      await sv.voice.join(room, ch, {
        plan: async () => {
          const plan = await relayBook.check(relayBook.prefs.choice)
          return { config: plan.config, declared: plan.declared, hidesIp: hidesIp(plan) }
        },
        muted: () => p2pHost.muted(),
        leaveOthers: () => {
          calls?.hangup()
          p2pHost.leaveInstanceCalls()
        },
      })
    } catch (e) {
      if (!(e instanceof JoinAborted)) callFailed(e)
    }
  },
  leave: () => servers?.voice.leave(),
  // A camera or a screen share went on or off (the others show the notice for video).
  videoChanged: () => servers?.voice.setVideo(mediaVideo()),
  async camera() {
    try {
      await callRtc.camera(callRtc.videoTrack === null)
    } catch (e) {
      callFailed(e)
    }
    p2pVoice.videoChanged()
  },
  async share() {
    try {
      await callRtc.share(!callRtc.sharing)
    } catch (e) {
      callFailed(e)
    }
    p2pVoice.videoChanged()
  },
}

export const p2pCall = {
  async start(ik: string, video: boolean, choice?: string) {
    const c = calls
    if (!c) return p2pHost.toast(ELSEWHERE_TEXT)
    try {
      await c.start(ik, video, choice)
      if (video && calls === c && c.view()) await callRtc.camera(true)
    } catch (e) {
      callFailed(e)
    }
  },
  async accept() {
    const c = calls
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
  decline: () => calls?.decline(),
  hangup: () => calls?.hangup(),
  // Media is up: our own call, or one we answered.
  media: () => {
    const v = calls?.view()
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
export const scheduleRefresh = (room: string) => {
  if (timers.has(room)) return
  timers.set(
    room,
    setTimeout(() => {
      timers.delete(room)
      void refreshRoom(room)
    }, 30)
  )
}
