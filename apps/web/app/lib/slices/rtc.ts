import type { AccountSession } from '../client/session'
// Voice channels and calls: the media for them, self audio, and their events.

import type { CallRoute } from '../call_choice'
import { accountPrompt } from '../features'
import { guestVoiceOff, voiceSelf } from '../guest_voice'

import { JoinTracker } from '../negotiation'
import { client } from '../client/client'
import type { CallClaim } from '../client/calls'
import { DENIED_CALL, hidesIp } from '../relays'
import { JoinAborted } from '../rtc'
import { myTimeoutEnds, voiceHushedIn, voiceMutedIn } from '../selectors'
import type { RChatState } from '../store_types'
import { TIMED_OUT_CAMERA, TIMED_OUT_SHARE, timedOutLine } from '../timeouts'
import type { CallKind, VoiceMsg, WsEvent } from '../types'
import { SELF_AUDIO_IDLE, type SelfAudio, toggleDeafenAudio, toggleMicAudio } from '../voice_layout'
import { defaultViewing } from '../viewing'
import { type GetState, type Handlers, type SetState } from './ctx'

export interface RtcDeps {
  acct: AccountSession
  act: (fn: () => Promise<void>) => Promise<void>
  fail: (e: unknown) => void
  saveCallRoute: (route: CallRoute) => void
}

type MuteMarks = Record<number, string[]>

// The marks of a channel with `username` marked or not.
const marked = (marks: MuteMarks, channelId: number, username: string, on: boolean) => {
  const list = (marks[channelId] ?? []).filter(u => u !== username)
  if (on) list.push(username)
  const next = { ...marks }
  if (list.length) next[channelId] = list
  else delete next[channelId]
  return next
}

// The marks of a channel kept only for `users`, or null when none went.
const keptFor = (marks: MuteMarks, channelId: number, users: string[]): MuteMarks | null => {
  const list = marks[channelId]
  const kept = list?.filter(u => users.includes(u))
  if (!list || kept?.length === list.length) return null
  const next = { ...marks }
  if (kept?.length) next[channelId] = kept
  else delete next[channelId]
  return next
}

// A room closed by a local viewing choice keeps its people out of this client.
export const rosterClosed = (
  s: RChatState,
  server: string,
  channelId: number,
  viewing = defaultViewing
) => {
  const target = viewing.instanceTarget(s, server, channelId)
  return !!target && !viewing.canView(target)
}

// A channel's voice members, replaced by the server's list; muted marks go with members who left.
export const applyVoiceState = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'voice_state' }>
): Partial<RChatState> => {
  const voiceUsers = { ...s.voiceUsers }
  if (ev.users.length) voiceUsers[ev.channel_id] = ev.users
  else delete voiceUsers[ev.channel_id]
  const voiceMuted = keptFor(s.voiceMuted, ev.channel_id, ev.users)
  const voiceHushed = keptFor(s.voiceHushed, ev.channel_id, ev.users)
  return {
    voiceUsers,
    ...(voiceMuted ? { voiceMuted } : {}),
    ...(voiceHushed ? { voiceHushed } : {}),
  }
}

// The call a call_state names: cleared when it ended, else its phase, with the answer time kept.
export const applyCallState = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'call_state' }>
): Partial<RChatState> => {
  if (ev.state === 'ended') return s.call?.dmId === ev.dm_id ? { call: null } : {}
  const prev = s.call
  const since =
    ev.state !== 'active'
      ? null
      : typeof ev.answered_at === 'number'
        ? ev.answered_at
        : prev?.dmId === ev.dm_id && prev.since !== null
          ? prev.since
          : Math.floor(Date.now() / 1000)
  return {
    call: {
      dmId: ev.dm_id,
      dmUsers: ev.dm_users,
      state: ev.state,
      from: ev.from,
      kind: ev.kind,
      video: ev.video === true,
      since,
      relays: Array.isArray(ev.relays) ? ev.relays : [],
    },
  }
}

export const rtcSlice = (set: SetState, get: GetState, deps: RtcDeps) => {
  const { acct } = deps
  const { rtc, files: p2p, relays: relayBook } = acct
  const home = acct.conn
  const { sessionMark } = acct.lifetime
  const { act, fail, saveCallRoute } = deps

  // The P2P call whose relays the caller is asking about, so a repeated state asks once.
  let dialing: string | null = null

  // An active P2P call names its id and the peer id of both tabs. The tab that started or
  // accepted it binds to the other side: the caller dials, the callee answers only that peer.
  const bindP2pCall = (me: string, ev: Extract<WsEvent, { type: 'call_state' }>) => {
    const mine = ev.peers?.find(p => p.user === me)
    if (!p2p.mediaActive() || !mine || mine.peer_id !== p2p.peerId()) return
    const other = ev.peers?.find(p => p.user !== me)
    if (!other || !ev.call_id) {
      set(s => ({ p2pCallFailed: { ...s.p2pCallFailed, [ev.dm_id]: Date.now() } }))
      fail(new Error('This P2P call cannot connect: the other side uses an older app'))
      return
    }
    if (get().p2pCallFailed[ev.dm_id] !== undefined)
      set(s => {
        const { [ev.dm_id]: _gone, ...rest } = s.p2pCallFailed
        return { p2pCallFailed: rest }
      })
    const dial = ev.from === me
    const binding = { callId: ev.call_id, peer: other.peer_id, dial }
    if (!dial) {
      p2p.bind(binding)
      return
    }
    // The caller asks about the callee's relays before it connects; the callee asked about the
    // caller's when it accepted.
    if (dialing === binding.callId) return
    dialing = binding.callId
    const theirs = (ev.relays ?? []).filter(r => r.user !== me).flatMap(r => r.hosts)
    const plan = p2p.callPlan()
    const asked = plan && hidesIp(plan) ? Promise.resolve(null) : relayBook.consent(theirs)
    void asked.then(denied => {
      if (dialing !== binding.callId) return
      dialing = null
      const call = get().call
      if (call?.dmId !== ev.dm_id || call.state !== 'active' || !p2p.mediaActive()) return
      if (denied !== null) {
        get().hangupCall()
        fail(new Error(DENIED_CALL))
        return
      }
      if (p2p.bind(binding)) p2p.dial()
    })
  }
  const joins = new JoinTracker()
  let lease: CallClaim | null = null
  type Attempt = {
    dmId: number
    from: string
    kind: CallKind
    video: boolean
    confirmed: boolean
    id: number | null
    ack: 'ringing' | 'active'
    missed?: boolean
    ended?: boolean
  }
  let nextId = 0
  let attempt: Attempt | null = null
  // Only active P2P events have a call_id. The socket reports each successful
  // start with ringing before active/ended, including starts hung up locally.
  let onWire: Attempt | null = null
  // Plain refusals have no request ID. Keep one DM request on the wire, and
  // let only the current claim start capture after the previous call settles.
  let wake: (() => void) | null = null
  const wakeWaiting = () => {
    const resume = wake
    wake = null
    resume?.()
  }
  const resetCallEvents = () => {
    onWire = null
    wakeWaiting()
  }
  const showsAttempt = (dm: Attempt, call: RChatState['call']) =>
    call?.dmId === dm.dmId && call.from === dm.from && call.kind === dm.kind
  const matches = (a: Attempt, ev: Extract<WsEvent, { type: 'call_state' }>) =>
    a.dmId === ev.dm_id &&
    a.from === ev.from &&
    a.kind === ev.kind &&
    (ev.video === undefined || a.video === ev.video)
  const release = (kind?: CallClaim['kind']) => {
    if (kind && lease?.kind !== kind) return
    lease?.release()
    dialing = null
    lease = null
    attempt = null
    wakeWaiting()
  }
  const captureAborted = (claim: CallClaim, error: unknown) => {
    if (!claim.current()) return true
    if (!(error instanceof JoinAborted)) return false
    release(claim.kind)
    return true
  }
  const acquire = async (kind: 'voice' | 'dm', dm?: Attempt, valid = () => true) => {
    // A newer join can supersede a capture that has not joined a channel yet.
    if (kind === 'voice' && lease?.kind === kind && !get().voice) release('voice')
    const at = sessionMark()
    const previous = client.calls.current()
    const audio = get().selfAudio
    const next = await client.calls.request(
      { account: acct, kind },
      () => {
        if (kind === 'voice') {
          if (get().voice && home.ws.sendVoice({ type: 'voice_leave' })) joins.left()
          endVoiceMedia()
        } else if (dm && attempt === dm) {
          if (dm.id) home.ws.sendVoice({ type: 'call_leave', dm_id: dm.dmId })
          if (showsAttempt(dm, get().call)) set({ call: null })
          endCallMedia(dm)
        }
      },
      () => at === sessionMark() && valid()
    )
    if (!next?.current()) return null
    if (previous?.account === acct) set({ selfAudio: audio })
    if (dm && onWire?.missed) {
      resetCallEvents()
      home.ws.reconnectAfterGap()
    }
    lease = next
    attempt = dm ?? null
    if (dm && onWire) {
      await new Promise<void>(resolve => {
        wake = resolve
      })
      if (!next.current()) return null
    }
    const opening = dm && home.ws.afterGap()
    if (opening) {
      const ready = await opening
      if (!next.current()) return null
      if (!ready) {
        release(kind)
        throw new Error('Not connected')
      }
    }
    if (!valid()) {
      release(kind)
      return null
    }
    return next
  }

  // Muted by a timeout in the voice channel you are in: by the server, or by your own clock.
  const forcedMute = () => {
    const s = get()
    if (!s.voice || !s.me) return false
    return (
      voiceMutedIn(s, s.voice.channelId).includes(s.me.username) ||
      myTimeoutEnds(s, s.voice.server) !== null
    )
  }

  // Muted for everyone by staff in the voice channel you are in, as a guest.
  const staffMuted = () => {
    const s = get()
    const self = voiceSelf(s)
    return s.voice !== null && self !== null && voiceHushedIn(s, s.voice.channelId).includes(self)
  }

  // Also stops your camera and screen share while a timeout mutes you in voice.
  const peerMedia = () => {
    const claim = client.calls.current()
    if (claim?.account === acct && (claim.kind === 'p2p-voice' || claim.kind === 'p2p-call'))
      return acct.identities.get(claim.identity)
  }
  const applyMic = () => {
    const forced = forcedMute()
    const muted = get().selfAudio.muted || forced || staffMuted()
    if (rtc.active() && rtc.muted !== muted) rtc.setMuted(muted)
    if (p2p.mediaActive() && p2p.muted !== muted) p2p.setMuted(muted)
    const callRtc = peerMedia()?.callRtc
    if (callRtc?.active() && callRtc.muted !== muted) callRtc.setMuted(muted)
    if (forced && rtc.active()) {
      if (rtc.videoTrack) void rtc.camera(false)
      if (rtc.sharing) void rtc.share(false)
    }
  }

  const setSelfAudio = (selfAudio: SelfAudio) => {
    set({ selfAudio })
    applyMic()
  }

  const endRtc = () => {
    resetCallEvents()
    if (!lease && !get().voice && !get().call) return
    release()
    rtc.leave()
    joins.reset()
    p2p.endMedia()
    set(s => ({
      selfAudio: SELF_AUDIO_IDLE,
      ...(s.voice || s.call ? { voice: null, call: null } : {}),
    }))
  }

  // A resync can stand in for a lost ringing, refusal or end event. An older
  // socket cannot identify which call a later plain refusal belonged to.
  const recoverCallHistory = () => {
    const call = get().call
    if (!attempt && call?.state === 'ringing') {
      home.ws.sendVoice({ type: 'call_decline', dm_id: call.dmId })
      set({ call: null })
    }
    if (!onWire) return
    if (!attempt && lease?.kind === 'voice') {
      onWire.missed = true
      return
    }
    const interrupted = attempt !== null
    endRtc()
    home.ws.reconnectAfterGap()
    if (interrupted) fail(new Error('Call connection interrupted. Try calling again.'))
  }

  const endVoiceMedia = () => {
    release('voice')
    rtc.leave()
    set({ voice: null, selfAudio: SELF_AUDIO_IDLE })
  }

  const endCallMedia = (owner: Attempt) => {
    if (owner !== attempt || lease?.kind !== 'dm') return
    release('dm')
    if (owner.kind === 'p2p') p2p.endMedia()
    else rtc.leave()
    set({ selfAudio: SELF_AUDIO_IDLE })
  }

  const abandonMedia = () => {
    release()
    const { voice, call, me } = get()
    const ours = call !== null && (call.state === 'active' || call.from === me?.username)
    if (voice && home.ws.sendVoice({ type: 'voice_leave' })) joins.left()
    if (ours) home.ws.sendVoice({ type: 'call_leave', dm_id: call.dmId })
    rtc.leave()
    p2p.endMedia()
    set({ voice: null, selfAudio: SELF_AUDIO_IDLE, ...(ours ? { call: null } : {}) })
  }

  // Sends a voice or call message once the media is up; when the socket is down it drops it again.
  const sendOrAbandon = (msg: VoiceMsg) => {
    if (attempt && (msg.type === 'call_start' || msg.type === 'call_accept')) {
      const id = ++nextId
      if (home.ws.sendVoice({ ...msg, attempt_id: id })) {
        attempt.id = id
        onWire = attempt
        return
      }
    } else if (home.ws.sendVoice(msg)) return
    abandonMedia()
    throw new Error('Not connected')
  }

  const ownsCall = (call: RChatState['call']) =>
    !!attempt && showsAttempt(attempt, call) && !!lease?.current()

  const caller = () => {
    const { me, guest, call, settings } = get()
    if (guest || !me) throw new Error(`${accountPrompt(settings)} to start calls`)
    if (call && !ownsCall(call)) throw new Error('Already in a call')
    return me
  }

  const endCall = (type: 'call_decline' | 'call_leave') => {
    const { call } = get()
    if (call) home.ws.sendVoice({ type, dm_id: call.dmId })
    else if (attempt?.id) home.ws.sendVoice({ type, dm_id: attempt.dmId })
    if (attempt && (!call || showsAttempt(attempt, call))) endCallMedia(attempt)
    set({ call: null })
  }

  let endedVoice: number | null = null
  // Whether the server has listed us in the room we last joined. Until it has,
  // a voice_state without us predates our join and is not a removal.
  let voiceListed = false
  const bindMedia = () => {
    rtc.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
    p2p.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
    p2p.onError = message => fail(new Error(message))
    return () => {
      rtc.onChange = p2p.onChange = p2p.onError = () => {}
    }
  }
  const actions: Pick<
    RChatState,
    | 'joinVoice'
    | 'leaveVoice'
    | 'toggleMute'
    | 'toggleDeafen'
    | 'toggleCamera'
    | 'toggleShare'
    | 'canStartCall'
    | 'startCall'
    | 'startP2pCall'
    | 'setCallRoute'
    | 'acceptCall'
    | 'declineCall'
    | 'hangupCall'
  > = {
    joinVoice: (server, channelId) =>
      act(async () => {
        const { voice, settings } = get()
        const self = voiceSelf(get())
        if (self === null) throw new Error(`${accountPrompt(settings)} to join voice`)
        const ends = myTimeoutEnds(get(), server)
        if (ends !== null) throw new Error(timedOutLine(ends))
        await get().openChannel(server, channelId)
        const view = get().view
        if (view?.kind !== 'channel' || view.channelId !== channelId || view.server !== server)
          return
        home.ws.ensureConnected()
        const shut = guestVoiceOff(get(), server)
        if (shut !== null) throw new Error(shut)
        if (voice?.channelId === channelId) return
        const claim = await acquire('voice', undefined, () => get().view === view)
        if (!claim?.current()) return
        const at = sessionMark()
        try {
          p2p.endMedia()
          await rtc.join(self, { channelId }, get().selfAudio.muted)
          if (!claim.current()) return
          if (get().view !== view) {
            endVoiceMedia()
            return
          }
          applyMic()
        } catch (e) {
          if (captureAborted(claim, e)) return
          if (at === sessionMark()) abandonMedia()
          throw e
        }
        sendOrAbandon({ type: 'voice_join', channel_id: channelId })
        joins.joined(channelId, (get().voiceUsers[channelId] ?? []).includes(self))
        voiceListed = false
        set({ voice: { server, channelId }, call: null })
      }),

    leaveVoice: () => {
      if (home.ws.sendVoice({ type: 'voice_leave' })) joins.left()
      endVoiceMedia()
    },

    toggleMute: () => setSelfAudio(toggleMicAudio(get().selfAudio)),

    toggleDeafen: () => setSelfAudio(toggleDeafenAudio(get().selfAudio)),
    toggleCamera: () =>
      act(async () => {
        const owner = client.calls.current()
        if (owner?.account === acct) {
          if (owner.kind === 'p2p-voice')
            return await acct.identities.get(owner.identity)?.p2pVoice.camera()
          if (owner.kind === 'p2p-call')
            return await acct.identities.get(owner.identity)?.p2pCall.camera()
        }
        if (attempt?.kind === 'p2p') return await p2p.toggleCamera()
        const on = rtc.videoTrack === null
        if (on && forcedMute()) throw new Error(TIMED_OUT_CAMERA)
        await rtc.camera(on)
      }),
    toggleShare: () =>
      act(async () => {
        const owner = client.calls.current()
        if (owner?.account === acct) {
          if (owner.kind === 'p2p-voice')
            return await acct.identities.get(owner.identity)?.p2pVoice.share()
          if (owner.kind === 'p2p-call')
            return await acct.identities.get(owner.identity)?.p2pCall.share()
        }
        if (attempt?.kind === 'p2p') return await p2p.toggleShare()
        const on = !rtc.sharing
        if (on && forcedMute()) throw new Error(TIMED_OUT_SHARE)
        await rtc.share(on)
      }),

    canStartCall: dmId => {
      const { call } = get()
      return !call || (call.dmId !== dmId && ownsCall(call))
    },
    startCall: (dmId, video) =>
      act(async () => {
        const me = caller()
        const claim = await acquire('dm', {
          dmId,
          from: me.username,
          kind: 'rtc',
          video,
          confirmed: false,
          id: null,
          ack: 'ringing',
        })
        if (!claim?.current()) return
        const at = sessionMark()
        try {
          p2p.endMedia()
          await rtc.join(me.username, { dmId }, get().selfAudio.muted)
          applyMic()
          if (!claim.current()) return
          if (video) await rtc.camera(true)
        } catch (e) {
          if (captureAborted(claim, e)) return
          if (at === sessionMark()) abandonMedia()
          throw e
        }
        if (!claim.current() || at !== sessionMark()) return
        sendOrAbandon({ type: 'call_start', dm_id: dmId, video })
        set({ voice: null })
      }),

    startP2pCall: (dmId, video, relay) =>
      act(async () => {
        const me = caller()
        const at = sessionMark()
        const plan = await relayBook.check(relay ?? relayBook.prefs.choice)
        if (at !== sessionMark()) return
        const claim = await acquire('dm', {
          dmId,
          from: me.username,
          kind: 'p2p',
          video,
          confirmed: false,
          id: null,
          ack: 'ringing',
        })
        if (!claim?.current()) return
        try {
          rtc.leave()
          await p2p.startMedia(get().selfAudio.muted)
          if (!claim.current()) {
            if (client.calls.current()?.account !== acct) p2p.endMedia()
            return
          }
          p2p.setCallIce(plan)
          applyMic()
          if (video) await p2p.toggleCamera()
        } catch (e) {
          if (claim.current() && at === sessionMark()) abandonMedia()
          throw e
        }
        if (!claim.current() || at !== sessionMark()) return
        sendOrAbandon({
          type: 'call_start',
          dm_id: dmId,
          p2p: true,
          video,
          peer_id: p2p.peerId(),
          ...(plan.declared.length ? { relays: plan.declared } : {}),
        })
        set({ voice: null })
      }),

    setCallRoute: saveCallRoute,

    acceptCall: () =>
      act(async () => {
        const { me, call } = get()
        if (!me || !call || call.state !== 'ringing') return
        let plan: Awaited<ReturnType<typeof relayBook.check>> | null = null
        if (call.kind === 'p2p') {
          const theirs = (call.relays ?? [])
            .filter(r => r.user !== me.username)
            .flatMap(r => r.hosts)
          const mine = await relayBook.check(relayBook.prefs.choice)
          plan = mine
          if (!hidesIp(mine) && (await relayBook.consent(theirs)) !== null) {
            if (get().call === call) get().declineCall()
            throw new Error(DENIED_CALL)
          }
          if (get().call !== call) return
        }
        const ringingNow = () => get().call === call
        const accepting: Attempt = { ...call, confirmed: false, id: null, ack: 'active' }
        const claim = await acquire('dm', accepting, ringingNow)
        if (!claim?.current()) return
        try {
          if (call.kind === 'p2p') {
            rtc.leave()
            await p2p.startMedia(get().selfAudio.muted)
            if (!claim.current()) return
            p2p.setCallIce(plan)
          } else {
            p2p.endMedia()
            await rtc.join(me.username, { dmId: call.dmId }, get().selfAudio.muted)
          }
          applyMic()
        } catch (e) {
          if (captureAborted(claim, e)) return
          abandonMedia()
          throw e
        }
        if (!claim.current()) return
        if (!ringingNow()) {
          endCallMedia(accepting)
          return
        }
        if (call.kind === 'p2p') p2p.expectCall()
        sendOrAbandon(
          call.kind === 'p2p'
            ? {
                type: 'call_accept',
                dm_id: call.dmId,
                peer_id: p2p.peerId(),
                ...(plan?.declared.length ? { relays: plan.declared } : {}),
              }
            : { type: 'call_accept', dm_id: call.dmId }
        )
        set({ voice: null })
      }),

    declineCall: () => endCall('call_decline'),

    hangupCall: () => endCall('call_leave'),
  }

  const handlers = {
    voice_state: ev => {
      set(s =>
        applyVoiceState(
          s,
          rosterClosed(s, ev.server, ev.channel_id, acct.viewing) ? { ...ev, users: [] } : ev
        )
      )
      const { voice } = get()
      const self = voiceSelf(get())
      if (self === null) return
      const listing = joins.state(ev.channel_id, ev.users.includes(self))
      if (voice?.channelId === ev.channel_id) {
        if (listing === 'listed') {
          voiceListed = true
          rtc.sync(ev.users)
        } else if (listing === 'absent' && voiceListed) {
          endedVoice = ev.channel_id
          endVoiceMedia()
        }
      }
    },

    voice_muted: ev => {
      if (!rosterClosed(get(), ev.server, ev.channel_id, acct.viewing))
        set(s =>
          ev.staff === true
            ? { voiceHushed: marked(s.voiceHushed, ev.channel_id, ev.username, ev.muted) }
            : { voiceMuted: marked(s.voiceMuted, ev.channel_id, ev.username, ev.muted) }
        )
      applyMic()
    },

    call_state: ev => {
      const { me } = get()
      if (!me) return
      const owner = onWire && !onWire.ended && matches(onWire, ev) ? onWire : null
      if (owner) {
        if (ev.state === owner.ack) owner.confirmed = true
        if (ev.state === 'ended') {
          if (owner.ack === 'active' && !owner.confirmed) owner.ended = true
          else if (owner.confirmed) resetCallEvents()
        }
        if (owner !== attempt) return
      }
      if (ev.state === 'ended') {
        if (get().call?.dmId === ev.dm_id) dialing = null
        if (attempt && (attempt.confirmed || attempt.ack === 'active') && matches(attempt, ev))
          endCallMedia(attempt)
        if (get().call?.dmId === ev.dm_id) set(s => applyCallState(s, ev))
        return
      }
      if (!get().dms.some(d => d.id === ev.dm_id))
        void get()
          .ensureDms([ev.dm_id])
          .catch(() => {})
      set(s => applyCallState(s, ev))
      if (ev.state !== 'active') return
      if (ev.kind === 'rtc') {
        rtc.sync(ev.dm_users)
        return
      }
      bindP2pCall(me.username, ev)
    },

    rtc_signal: ev => {
      if (voiceSelf(get()) === ev.to)
        rtc
          .onSignal(ev.from, ev.payload, { channelId: ev.channel_id, dmId: ev.dm_id })
          .catch((e: unknown) => console.error('rtc signal', e))
    },

    voice_ended: ev => {
      const { voice } = get()
      const self = voiceSelf(get())
      const mine = self !== null && (ev.dm_users?.includes(self) ?? false)
      if (mine && ev.channel_id !== null && voice?.channelId === ev.channel_id) endVoiceMedia()
      const endedChannel = ev.channel_id !== null && ev.channel_id === endedVoice
      if (endedChannel) endedVoice = null
      if (endedChannel || mine) fail(new Error(ev.reason))
    },

    guest_name: ev => set({ guestVoiceName: ev.name }),

    error: ev => {
      fail(new Error(ev.message))
      const { request } = ev
      if (request?.type === 'other') return
      if (request?.type === 'call' || !request) {
        if (
          !request &&
          ['No such call', 'No shared voice session', 'Signal too large'].includes(ev.message)
        )
          return
        const acceptOnly = ev.message === 'No incoming call'
        const owner = onWire
        if (
          owner &&
          (request
            ? owner.id === request.attempt_id
            : !owner.confirmed && (!acceptOnly || owner.ack === 'active'))
        ) {
          resetCallEvents()
          endCallMedia(owner)
          return
        }
        if (request || acceptOnly) return
      }
      const { voice, voiceUsers } = get()
      if (!voice || lease?.kind !== 'voice') return
      if (request && voice.channelId !== request.channel_id) return
      const self = voiceSelf(get())
      if (self !== null && (voiceUsers[voice.channelId] ?? []).includes(self)) return
      joins.refused()
      endVoiceMedia()
    },
  } satisfies Handlers

  return {
    bindMedia,
    handlers,
    actions,
    applyMic,
    endRtc,
    resetCallEvents,
    recoverCallHistory,
    endVoiceMedia,
    joins,
  }
}
