// Voice channels and calls: the media for them, self audio, and their events.

import type { CallRoute } from '../call_choice'
import { accountPrompt } from '../features'
import { voiceSelf } from '../guest_voice'
import { home } from '../instances'
import { JoinTracker } from '../negotiation'
import { p2p } from '../p2p'
import { callRtc, p2pCall, p2pVoice } from '../p2p/app'
import { DENIED_CALL, hidesIp, relayBook } from '../relays'
import { JoinAborted, rtc } from '../rtc'
import { myTimeoutEnds, voiceMutedIn } from '../selectors'
import type { RChatState } from '../store_types'
import { TIMED_OUT_CAMERA, TIMED_OUT_SHARE, timedOutLine } from '../timeouts'
import type { CallKind, VoiceMsg, WsEvent } from '../types'
import { SELF_AUDIO_IDLE, type SelfAudio, toggleDeafenAudio, toggleMicAudio } from '../voice_layout'
import type { GetState, Handlers, SetState } from './ctx'

export interface RtcDeps {
  act: (fn: () => Promise<void>) => Promise<void>
  fail: (e: unknown) => void
  saveCallRoute: (route: CallRoute) => void
}

// A channel's voice members, replaced by the server's list; muted marks go with members who left.
export const applyVoiceState = (
  s: RChatState,
  ev: Extract<WsEvent, { type: 'voice_state' }>
): Partial<RChatState> => {
  const voiceUsers = { ...s.voiceUsers }
  if (ev.users.length) voiceUsers[ev.channel_id] = ev.users
  else delete voiceUsers[ev.channel_id]
  const muted = s.voiceMuted[ev.channel_id]
  const kept = muted?.filter(u => ev.users.includes(u))
  if (!muted || kept?.length === muted.length) return { voiceUsers }
  const voiceMuted = { ...s.voiceMuted }
  if (kept?.length) voiceMuted[ev.channel_id] = kept
  else delete voiceMuted[ev.channel_id]
  return { voiceUsers, voiceMuted }
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

  // Muted by a timeout in the voice channel you are in: by the server, or by your own clock.
  const forcedMute = () => {
    const s = get()
    if (!s.voice || !s.me) return false
    return (
      voiceMutedIn(s, s.voice.channelId).includes(s.me.username) ||
      myTimeoutEnds(s, s.voice.server) !== null
    )
  }

  // Also stops your camera and screen share while a timeout mutes you in voice.
  const applyMic = () => {
    const forced = forcedMute()
    const muted = get().selfAudio.muted || forced
    if (rtc.active() && rtc.muted !== muted) rtc.setMuted(muted)
    if (p2p.mediaActive() && p2p.muted !== muted) p2p.setMuted(muted)
    if (callRtc.active() && callRtc.muted !== muted) callRtc.setMuted(muted)
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
    rtc.leave()
    joins.reset()
    p2p.endMedia()
    set(s => ({
      selfAudio: SELF_AUDIO_IDLE,
      ...(s.voice || s.call ? { voice: null, call: null } : {}),
    }))
  }

  const endVoiceMedia = () => {
    rtc.leave()
    set({ voice: null, selfAudio: SELF_AUDIO_IDLE })
  }

  const endCallMedia = (kind: CallKind) => {
    if (get().voice) return
    if (kind === 'p2p') p2p.endMedia()
    else rtc.leave()
    set({ selfAudio: SELF_AUDIO_IDLE })
  }

  const abandonMedia = () => {
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
    if (home.ws.sendVoice(msg)) return
    abandonMedia()
    throw new Error('Not connected')
  }

  const caller = () => {
    const { me, guest, call, settings } = get()
    if (guest || !me) throw new Error(`${accountPrompt(settings)} to start calls`)
    if (call) throw new Error('Already in a call')
    return me
  }

  const endCall = (type: 'call_decline' | 'call_leave') => {
    const { call } = get()
    if (call) {
      home.ws.sendVoice({ type, dm_id: call.dmId })
      endCallMedia(call.kind)
    }
    set({ call: null })
  }

  let endedVoice: number | null = null
  // Whether the server has listed us in the room we last joined. Until it has,
  // a voice_state without us predates our join and is not a removal.
  let voiceListed = false
  rtc.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  callRtc.onChange = () => {
    set(s => ({ rtcTick: s.rtcTick + 1 }))
    p2pVoice.videoChanged()
  }
  p2p.onChange = () => set(s => ({ rtcTick: s.rtcTick + 1 }))
  p2p.onError = message => fail(new Error(message))

  const actions: Pick<
    RChatState,
    | 'joinVoice'
    | 'leaveVoice'
    | 'toggleMute'
    | 'toggleDeafen'
    | 'toggleCamera'
    | 'toggleShare'
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
        home.ws.ensureConnected()
        await get().openChannel(server, channelId)
        if (voice?.channelId === channelId) return
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          p2p.endMedia()
          await rtc.join(self, { channelId }, get().selfAudio.muted)
          applyMic()
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
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
        const { call, voice } = get()
        if (!voice && !call && p2pVoice.active()) return await p2pVoice.camera()
        if (!voice && !call && p2pCall.media()) return await p2pCall.camera()
        if (!voice && call?.kind === 'p2p') return await p2p.toggleCamera()
        const on = rtc.videoTrack === null
        if (on && forcedMute()) throw new Error(TIMED_OUT_CAMERA)
        await rtc.camera(on)
      }),
    toggleShare: () =>
      act(async () => {
        const { call, voice } = get()
        if (!voice && !call && p2pVoice.active()) return await p2pVoice.share()
        if (!voice && !call && p2pCall.media()) return await p2pCall.share()
        if (!voice && call?.kind === 'p2p') return await p2p.toggleShare()
        const on = !rtc.sharing
        if (on && forcedMute()) throw new Error(TIMED_OUT_SHARE)
        await rtc.share(on)
      }),

    startCall: (dmId, video) =>
      act(async () => {
        const me = caller()
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          p2p.endMedia()
          await rtc.join(me.username, { dmId }, get().selfAudio.muted)
          applyMic()
          if (video) await rtc.camera(true)
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
          throw e
        }
        sendOrAbandon({ type: 'call_start', dm_id: dmId, video })
        set({ voice: null })
      }),

    startP2pCall: (dmId, video, relay) =>
      act(async () => {
        caller()
        const plan = await relayBook.check(relay ?? relayBook.prefs.choice)
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          rtc.leave()
          await p2p.startMedia(get().selfAudio.muted)
          p2p.setCallIce(plan)
          applyMic()
          if (video) await p2p.toggleCamera()
        } catch (e) {
          abandonMedia()
          throw e
        }
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
            if (get().call?.dmId === call.dmId) get().declineCall()
            throw new Error(DENIED_CALL)
          }
          const still = get().call
          if (still?.dmId !== call.dmId || still.state !== 'ringing') return
        }
        try {
          p2pCall.hangup()
          p2pVoice.leave()
          if (call.kind === 'p2p') {
            rtc.leave()
            await p2p.startMedia(get().selfAudio.muted)
            p2p.setCallIce(plan)
          } else {
            p2p.endMedia()
            await rtc.join(me.username, { dmId: call.dmId }, get().selfAudio.muted)
          }
          applyMic()
        } catch (e) {
          if (e instanceof JoinAborted) return
          abandonMedia()
          throw e
        }
        const ringing = get().call
        if (ringing?.dmId !== call.dmId || ringing.state !== 'ringing') {
          abandonMedia()
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
      set(s => applyVoiceState(s, ev))
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
      set(s => {
        const was = s.voiceMuted[ev.channel_id] ?? []
        const list = was.filter(u => u !== ev.username)
        if (ev.muted) list.push(ev.username)
        const voiceMuted = { ...s.voiceMuted }
        if (list.length) voiceMuted[ev.channel_id] = list
        else delete voiceMuted[ev.channel_id]
        return { voiceMuted }
      })
      applyMic()
    },

    call_state: ev => {
      const { me } = get()
      if (!me) return
      if (ev.state === 'ended') {
        if (get().call?.dmId === ev.dm_id) {
          endCallMedia(ev.kind)
          set(s => applyCallState(s, ev))
        }
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
      const { voice, call, voiceUsers } = get()
      const self = voiceSelf(get())
      const confirmed =
        call !== null ||
        (voice !== null && self !== null && (voiceUsers[voice.channelId] ?? []).includes(self))
      if (confirmed) return
      if (voice) joins.refused()
      if (rtc.active() || voice) endVoiceMedia()
      if (p2p.mediaActive()) p2p.endMedia()
      set({ selfAudio: SELF_AUDIO_IDLE })
    },
  } satisfies Handlers

  return {
    handlers,
    actions,
    applyMic,
    endRtc,
    endVoiceMedia,
    joins,
  }
}
