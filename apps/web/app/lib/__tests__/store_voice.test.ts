import { testClock, type ManualTime } from './helpers/test_clock'
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { client } from '../client/client'
import { home } from './home_instance'
import { getHomeSession, useStore, resetSessionCaches } from '../store'
import { SELF_AUDIO_IDLE, toggleDeafenAudio, toggleMicAudio, type SelfAudio } from '../voice_layout'
import { ChannelPermBit, type VoiceMsg } from '../types'
import { TIMED_OUT_CAMERA, TIMED_OUT_SHARE } from '../timeouts'
import { drain, me, serverDetail, summary as summaryOf, until, dmWith } from './fixtures'
import { AUDIO_SEND_MS } from '../slices/rtc'

let clock: ManualTime
beforeEach(() => {
  clock = testClock()
})

const { rtc } = getHomeSession()

const st = () => useStore.getState()

interface FakeTrack {
  kind: 'audio'
  enabled: boolean
  stop: () => void
}

let tracks: FakeTrack[] = []
let sent: VoiceMsg[] = []
const g = globalThis as { navigator?: unknown }
const realNavigator = g.navigator
const ws = home.ws as unknown as {
  sendVoice: (m: VoiceMsg) => boolean
  ensureConnected: () => void
}
const realSend = ws.sendVoice
const realEnsure = ws.ensureConnected
const realOpen = useStore.getState().openChannel
const quiet = { watch: () => {}, unwatch: () => {}, clear: () => {} }
const detectors = rtc as unknown as { detector: unknown }
const realDetector = detectors.detector

const lastTrack = () => tracks[tracks.length - 1]

beforeEach(() => {
  resetSessionCaches()
  tracks = []
  sent = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const track: FakeTrack = { kind: 'audio', enabled: true, stop: () => {} }
          tracks.push(track)
          return {
            getTracks: () => [track],
            getAudioTracks: () => [track],
            addTrack: () => {},
            removeTrack: () => {},
          }
        },
      },
    },
  })
  ws.sendVoice = m => {
    sent.push(m)
    return true
  }
  ws.ensureConnected = () => {}
  detectors.detector = quiet
  useStore.setState({
    me: me('alice'),
    guest: false,
    voice: null,
    call: null,
    selfAudio: SELF_AUDIO_IDLE,
    error: null,
    openChannel: async (server, channelId) =>
      useStore.setState({ view: { kind: 'channel', server, channelId } }),
  })
})

afterEach(async () => {
  // A change of ours still waiting to be said is said (to nobody) before the clock goes.
  await clock.pass(AUDIO_SEND_MS)
  rtc.leave()
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: realNavigator })
  ws.sendVoice = realSend
  ws.ensureConnected = realEnsure
  detectors.detector = realDetector
  useStore.setState({
    me: null,
    voice: null,
    call: null,
    selfAudio: SELF_AUDIO_IDLE,
    error: null,
    voiceMuted: {},
    timeouts: {},
    openChannel: realOpen,
  })
})

const switchCall = async (action: () => Promise<void>) => {
  const done = action()
  await until(() => !!st().confirm)
  const request = st().confirm!
  expect(request.confirm).toBe('Switch')
  st().closeConfirm()
  request.action('')
  return done
}

const ringFromBob = () =>
  useStore.setState({
    call: {
      dmId: 7,
      dmUsers: ['alice', 'bob'],
      state: 'ringing',
      from: 'bob',
      kind: 'rtc',
      video: false,
      since: null,
    },
  })

describe('self audio transitions', () => {
  const idle: SelfAudio = SELF_AUDIO_IDLE

  test('deafening mutes and undeafening restores the previous mic state', () => {
    const deaf = toggleDeafenAudio(idle)
    expect(deaf).toEqual({ muted: true, deafened: true, restoreMute: false })
    expect(toggleDeafenAudio(deaf)).toEqual(idle)
    const mutedDeaf = toggleDeafenAudio({ ...idle, muted: true })
    expect(toggleDeafenAudio(mutedDeaf)).toEqual({ ...idle, muted: true })
  })

  test('unmuting while deafened undeafens and opens the mic', () => {
    expect(toggleMicAudio(toggleDeafenAudio(idle))).toEqual(idle)
    expect(toggleMicAudio(idle)).toEqual({ ...idle, muted: true })
  })
})

describe('voice and call mic state', () => {
  test('deafen, then switch channel: deafened carries over and the new mic starts muted', async () => {
    await st().joinVoice('lounge', 1)
    expect(lastTrack().enabled).toBe(true)
    st().toggleDeafen()
    expect(lastTrack().enabled).toBe(false)
    await switchCall(() => st().joinVoice('lounge', 2))
    expect(st().voice?.channelId).toBe(2)
    expect(tracks).toHaveLength(2)
    expect(lastTrack().enabled).toBe(false)
    expect(rtc.muted).toBe(true)
    expect(st().selfAudio).toEqual({ muted: true, deafened: true, restoreMute: false })
  })

  test('mute, then switch channel: the new mic stays muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleMute()
    await switchCall(() => st().joinVoice('lounge', 2))
    expect(lastTrack().enabled).toBe(false)
    expect(rtc.muted).toBe(true)
  })

  test('deafen in voice, then accept a DM call: the call mic starts muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    ringFromBob()
    await switchCall(() => st().acceptCall())
    expect(st().error).toBeNull()
    expect(st().voice).toBeNull()
    expect(tracks).toHaveLength(2)
    expect(lastTrack().enabled).toBe(false)
    expect(rtc.muted).toBe(true)
    expect(st().selfAudio.deafened).toBe(true)
  })

  test('a ring that ends while accepting from voice leaves voice instead of accepting', async () => {
    await st().joinVoice('lounge', 1)
    ringFromBob()
    const media = navigator.mediaDevices as unknown as { getUserMedia: () => Promise<unknown> }
    const open = media.getUserMedia
    let grant: (() => void) | undefined
    media.getUserMedia = () => new Promise(done => (grant = () => done(open())))
    const accepting = switchCall(() => st().acceptCall())
    await until(() => grant !== undefined)
    useStore.setState({ call: null })
    grant!()
    await accepting
    expect(sent.some(m => m.type === 'call_accept')).toBe(false)
    expect(sent.some(m => m.type === 'voice_leave')).toBe(true)
    expect(st().voice).toBeNull()
    expect(rtc.active()).toBe(false)
  })

  test('declining or a cancelled ring while in voice keeps voice and deafen intact', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    ringFromBob()
    st().declineCall()
    expect(rtc.active()).toBe(true)
    expect(st().voice?.channelId).toBe(1)
    expect(st().selfAudio.deafened).toBe(true)
    expect(lastTrack().enabled).toBe(false)
  })

  test('leaving voice resets mute and deafen, so the next join has an open mic', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    st().leaveVoice()
    expect(st().selfAudio).toEqual(SELF_AUDIO_IDLE)
    await st().joinVoice('lounge', 2)
    expect(lastTrack().enabled).toBe(true)
    expect(rtc.muted).toBe(false)
  })

  test('a ring ending while the switch prompt is open keeps the existing call', async () => {
    await st().joinVoice('lounge', 1)
    const voice = client.calls.current()
    ringFromBob()
    const accepting = st().acceptCall()
    await until(() => !!st().confirm)
    const stale = st().confirm!
    st().applyWsEvent({
      type: 'call_state',
      dm_id: 7,
      dm_users: ['alice', 'bob'],
      from: 'bob',
      kind: 'rtc',
      state: 'ended',
      answered_at: null,
      call_id: null,
    })
    expect(st().confirm).toBeNull()
    ringFromBob()
    stale.action('')
    await accepting
    expect(client.calls.current()).toBe(voice)
    expect(st().voice?.channelId).toBe(1)
    expect(sent.map(m => m.type)).toEqual(['voice_join'])
  })

  describe('DM signaling replies', () => {
    const sync = rtc.sync
    beforeEach(() => {
      rtc.sync = () => {}
    })
    afterEach(() => {
      rtc.sync = sync
    })

    function callState(from: string, state: 'ringing' | 'active' | 'ended', dmId = 7) {
      st().applyWsEvent({
        type: 'call_state',
        dm_id: dmId,
        dm_users: ['alice', 'bob'],
        from,
        kind: 'rtc',
        state,
        answered_at: null,
        call_id: null,
      })
    }

    function lastRequest() {
      const msg = sent.at(-1)
      if ((msg?.type !== 'call_accept' && msg?.type !== 'call_start') || !msg.attempt_id)
        throw new Error('Expected a call request')
      return { type: 'call' as const, attempt_id: msg.attempt_id }
    }

    for (const scoped of [false, true]) {
      const refuse = (request: ReturnType<typeof lastRequest>) =>
        st().applyWsEvent({
          reason: null,
          request: null,
          type: 'error',
          message: 'Calling too often, try again in a moment',
          ...(scoped && { request }),
        })

      test(`an accept refused after hangup preserves the redial (scoped reply: ${scoped})`, async () => {
        useStore.setState({
          dms: [
            {
              id: 7,
              is_self: false,
              other: me('bob'),
              closed: false,
              friend: false,
              last_message_at: null,
              last_message_id: null,
              seal: { forced: false, on: false },
            },
          ],
        })
        callState('bob', 'ringing')
        await st().acceptCall()
        const accepted = lastRequest()
        callState('bob', 'ended')
        expect(client.calls.current()).toBeNull()
        expect(rtc.active()).toBe(false)

        const starting = st().startCall(7, false)
        await drain()
        const redial = client.calls.current()
        expect(lastRequest()).toEqual(accepted)
        st().applyWsEvent({
          reason: null,
          request: null,
          type: 'error',
          message: 'No incoming call',
          ...(scoped && { request: accepted }),
        })
        await starting
        expect(lastRequest()).not.toEqual(accepted)
        expect(client.calls.current()).toBe(redial)
        expect(rtc.active()).toBe(true)
        callState('alice', 'ringing')
        callState('alice', 'active')
        expect(st().call?.state).toBe('active')
        callState('alice', 'ended')
        expect(rtc.active()).toBe(false)
        expect(client.calls.current()).toBeNull()
      })

      test(`a refused accept stops its microphone and leaves the ring answerable (scoped reply: ${scoped})`, async () => {
        useStore.setState({
          dms: [
            {
              id: 7,
              is_self: false,
              other: me('bob'),
              closed: false,
              friend: false,
              last_message_at: null,
              last_message_id: null,
              seal: { forced: false, on: false },
            },
          ],
        })
        callState('bob', 'ringing')
        await st().acceptCall()
        for (const message of ['No shared voice session', 'Signal too large']) {
          st().applyWsEvent({
            reason: null,
            request: null,
            type: 'error',
            message,
            ...(scoped && { request: { type: 'other' as const } }),
          })
          expect(rtc.active()).toBe(true)
        }
        let stopped = false
        lastTrack().stop = () => {
          stopped = true
        }
        callState('bob', 'ringing')
        st().applyWsEvent({
          reason: null,
          request: null,
          type: 'error',
          message: 'Too many requests, slow down',
          ...(scoped && { request: lastRequest() }),
        })
        expect(stopped).toBe(true)
        expect(client.calls.current()).toBeNull()
        expect(st().call?.state).toBe('ringing')
        await st().acceptCall()
        callState('bob', 'active')
        expect(client.calls.current()?.kind).toBe('dm')
        expect(rtc.active()).toBe(true)
        callState('bob', 'ended')
        expect(rtc.active()).toBe(false)
      })

      for (const oldRefused of [false, true]) {
        test(`redial after voice waits for the first DM (old refused: ${oldRefused}, scoped: ${scoped})`, async () => {
          useStore.setState({ dms: [7, 8].map(id => dmWith(id, me('bob'))) })
          await st().joinVoice('lounge', 1)
          await switchCall(() => st().startCall(7, false))
          const old = lastRequest()
          st().hangupCall()
          const starting = st().startCall(8, false)
          await drain()
          expect(sent.at(-1)?.type).toBe('call_leave')
          expect(rtc.active()).toBe(false)
          if (oldRefused) refuse(old)
          else {
            callState('alice', 'ringing')
            callState('alice', 'ended')
          }
          await starting
          expect(sent.at(-1)).toMatchObject({ type: 'call_start', dm_id: 8 })
          expect(rtc.active()).toBe(true)
          if (oldRefused) {
            st().applyWsEvent({
              type: 'error',
              message: 'No incoming call',
              reason: null,
              request: null,
            })
            callState('alice', 'ringing', 8)
            expect(st().call?.dmId).toBe(8)
            expect(rtc.active()).toBe(true)
            callState('alice', 'ended', 8)
          } else refuse(lastRequest())
          expect(client.calls.current()).toBeNull()
          expect(rtc.active()).toBe(false)
        })
      }

      test(`switching a waiting redial to voice preserves its new guard (scoped: ${scoped})`, async () => {
        await st().startCall(7, false)
        const first = lastRequest()
        st().hangupCall()
        const waiting = st().startCall(8, false)
        await drain()
        await switchCall(() => st().joinVoice('lounge', 1))
        await waiting
        const voice = client.calls.current()
        refuse(first)
        expect(voice?.kind).toBe('voice')
        expect(client.calls.current()).toBe(voice)
        expect(st().voice?.channelId).toBe(1)
        expect(rtc.active()).toBe(true)
        expect(sent.map(m => m.type)).toEqual(['call_start', 'call_leave', 'voice_join'])
      })

      test(`successive refusals skip a cancelled waiter (scoped: ${scoped})`, async () => {
        await st().startCall(7, false)
        const first = lastRequest()
        st().hangupCall()
        const cancelled = st().startCall(8, false)
        await drain()
        st().hangupCall()
        await cancelled
        const next = st().startCall(9, false)
        await drain()
        refuse(first)
        await next
        expect(sent.filter(m => m.type === 'call_start').map(m => m.dm_id)).toEqual([7, 9])
        refuse(lastRequest())
        expect(rtc.active()).toBe(false)
        expect(client.calls.current()).toBeNull()
      })
    }

    test('a lost end before redial clears both outgoing and incoming stale calls', async () => {
      await st().startCall(7, false)
      callState('alice', 'ringing')
      st().hangupCall()
      st().applyWsEvent({ type: 'resync' })
      await st().startCall(8, false)
      expect(sent.at(-1)).toMatchObject({ type: 'call_start', dm_id: 8 })
      callState('alice', 'ringing', 8)
      callState('alice', 'ended', 8)
      callState('bob', 'ringing')
      st().applyWsEvent({ type: 'resync' })
      expect(st().call).toBeNull()
      await st().startCall(9, false)
      expect(sent.at(-1)).toMatchObject({ type: 'call_start', dm_id: 9 })
    })

    test('resync dismisses an unanswered ring during voice with an older DM outstanding', async () => {
      await st().startCall(7, false)
      st().hangupCall()
      await st().joinVoice('lounge', 1)
      const voice = client.calls.current()
      callState('bob', 'ringing', 8)
      st().applyWsEvent({ type: 'resync' })
      expect(st().call).toBeNull()
      expect(st().voice?.channelId).toBe(1)
      expect(client.calls.current()).toBe(voice)
      expect(rtc.active()).toBe(true)
      expect(sent.at(-1)).toMatchObject({ type: 'call_decline', dm_id: 8 })
    })

    test('lost call events cancel the waiting redial and allow a fresh call', async () => {
      await st().startCall(7, false)
      callState('alice', 'ringing')
      st().hangupCall()
      const waiting = st().startCall(8, false)
      await drain()
      st().applyWsEvent({ type: 'resync' })
      await waiting
      expect(client.calls.current()).toBeNull()
      expect(rtc.active()).toBe(false)
      await st().startCall(8, false)
      expect(sent.filter(m => m.type === 'call_start').map(m => m.dm_id)).toEqual([7, 8])
    })

    test('session reset cancels a waiting redial and clears the wire slot', async () => {
      await st().startCall(7, false)
      st().hangupCall()
      const waiting = st().startCall(8, false)
      await drain()
      resetSessionCaches()
      await waiting
      expect(client.calls.current()).toBeNull()
      expect(rtc.active()).toBe(false)
      useStore.setState({ me: me('alice'), guest: false })
      await st().startCall(9, false)
      expect(sent.filter(m => m.type === 'call_start').map(m => m.dm_id)).toEqual([7, 9])
    })
  })

  for (const earlyHangup of [false, true]) {
    test(`same-DM redial captures after the previous call ends (early hangup: ${earlyHangup})`, async () => {
      useStore.setState({
        dms: [
          {
            id: 7,
            is_self: false,
            other: me('bob'),
            closed: false,
            friend: false,
            last_message_at: null,
            last_message_id: null,
            seal: { forced: false, on: false },
          },
        ],
      })
      const phase = (state: 'ringing' | 'ended') =>
        st().applyWsEvent({
          type: 'call_state',
          dm_id: 7,
          dm_users: ['alice', 'bob'],
          from: 'alice',
          kind: 'rtc',
          video: false,
          state,
          answered_at: null,
          call_id: null,
        })
      await st().startCall(7, false)
      if (!earlyHangup) phase('ringing')
      st().hangupCall()
      const starting = st().startCall(7, false)
      await drain()
      const successor = client.calls.current()
      expect(successor?.kind).toBe('dm')
      if (earlyHangup) {
        phase('ringing')
        expect(st().call).toBeNull()
      }
      phase('ended')
      await starting
      expect(rtc.active()).toBe(true)
      expect(client.calls.current()).toBe(successor)
      expect(sent.map(m => m.type)).toEqual(['call_start', 'call_leave', 'call_start'])
      phase('ringing')
      expect(st().call?.state).toBe('ringing')
      phase('ended')
      expect(st().call).toBeNull()
      expect(rtc.active()).toBe(false)
      expect(client.calls.current()).toBeNull()
    })
  }

  for (const decline of [true, false]) {
    test(`ending a ring during voice capture preserves the voice join (decline: ${decline})`, async () => {
      const devices = navigator.mediaDevices
      const capture = devices.getUserMedia
      let grant: (() => void) | undefined
      devices.getUserMedia = async options => {
        await new Promise<void>(done => {
          grant = done
        })
        return capture.call(devices, options)
      }
      useStore.setState({
        dms: [
          {
            id: 7,
            is_self: false,
            other: me('bob'),
            closed: false,
            friend: false,
            last_message_at: null,
            last_message_id: null,
            seal: { forced: false, on: false },
          },
        ],
      })
      const joining = st().joinVoice('lounge', 1)
      await until(() => !!grant)
      const claim = client.calls.current()
      const ring = {
        type: 'call_state',
        kind: 'rtc',
        from: 'bob',
        dm_id: 7,
        dm_users: ['bob', 'alice'],
        video: false,
        answered_at: null,
        call_id: null,
      } as const
      const phase = (state: 'ringing' | 'ended') =>
        st().applyWsEvent({ ...ring, dm_users: [...ring.dm_users], state })
      phase('ringing')
      if (decline) st().declineCall()
      phase('ended')
      expect(st().call).toBeNull()
      expect(client.calls.current()).toBe(claim)
      grant!()
      await joining
      expect(st().voice?.channelId).toBe(1)
      expect(rtc.active()).toBe(true)
      expect(sent.at(-1)?.type).toBe('voice_join')
      st().leaveVoice()
      expect(client.calls.current()).toBeNull()
    })
  }

  test('hanging up a call resets mute and deafen', async () => {
    await st().startCall(7, false)
    st().toggleDeafen()
    useStore.setState({
      call: {
        dmId: 7,
        dmUsers: ['alice', 'bob'],
        state: 'active',
        from: 'alice',
        kind: 'rtc',
        video: false,
        since: 1,
      },
    })
    st().hangupCall()
    expect(rtc.active()).toBe(false)
    expect(st().selfAudio).toEqual(SELF_AUDIO_IDLE)
  })

  test('starting a call while deafened in voice starts muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    await switchCall(() => st().startCall(7, false))
    expect(st().voice).toBeNull()
    expect(lastTrack().enabled).toBe(false)
    expect(sent.some(m => m.type === 'call_start')).toBe(true)
  })

  test('a failed switch drops the old session and resets mic state', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { mediaDevices: { getUserMedia: async () => Promise.reject(new Error('denied')) } },
    })
    await switchCall(() => st().joinVoice('lounge', 2))
    expect(st().error === null).toBe(false)
    expect(rtc.active()).toBe(false)
    expect(st().voice).toBeNull()
    expect(st().selfAudio).toEqual(SELF_AUDIO_IDLE)
    expect(sent.some(m => m.type === 'voice_leave')).toBe(true)
  })

  test('a room update from before our join is not a removal', async () => {
    const roomState = (users: string[]) =>
      st().applyWsEvent({
        type: 'voice_state',
        server: 'lounge',
        channel_id: 3,
        users,
        audio: null,
      })
    await st().joinVoice('lounge', 3)
    // bob's join was applied just before ours, so this state doesn't list us yet
    roomState(['bob'])
    expect(rtc.active()).toBe(true)
    expect(st().voice?.channelId).toBe(3)
    roomState(['alice'])
    expect(rtc.active()).toBe(true)
    // once the server has listed us, a state without us means we were removed
    roomState(['bob'])
    expect(rtc.active()).toBe(false)
    expect(st().voice).toBeNull()
  })

  test('switching back to a channel ignores its state from before the rejoin', async () => {
    const roomState = (channel_id: number, users: string[]) =>
      st().applyWsEvent({ type: 'voice_state', server: 'lounge', channel_id, users, audio: null })
    await st().joinVoice('lounge', 3)
    roomState(3, ['alice'])
    await switchCall(() => st().joinVoice('lounge', 4))
    await switchCall(() => st().joinVoice('lounge', 3))
    // our leave from channel 3 arrives after we already rejoined it
    roomState(3, [])
    expect(rtc.active()).toBe(true)
    expect(st().voice?.channelId).toBe(3)
  })

  test('a quick A -> B -> A before any join is acknowledged keeps the session', async () => {
    const roomState = (channel_id: number, users: string[]) =>
      st().applyWsEvent({ type: 'voice_state', server: 'lounge', channel_id, users, audio: null })
    await st().joinVoice('lounge', 13)
    await switchCall(() => st().joinVoice('lounge', 14))
    await switchCall(() => st().joinVoice('lounge', 13))
    // the server applies the three joins in order
    roomState(13, ['alice'])
    roomState(13, [])
    roomState(14, ['alice'])
    expect(rtc.active()).toBe(true)
    roomState(14, [])
    roomState(13, ['alice'])
    expect(rtc.active()).toBe(true)
    expect(st().voice?.channelId).toBe(13)
    roomState(13, [])
    expect(rtc.active()).toBe(false)
  })

  test('overlapping joins: the earlier one is dropped and its mic stopped', async () => {
    const media = navigator.mediaDevices as unknown as { getUserMedia: () => Promise<unknown> }
    const open = media.getUserMedia
    const grants: (() => void)[] = []
    const stopped: boolean[] = []
    media.getUserMedia = () =>
      new Promise(done =>
        grants.push(() =>
          done(
            open().then(m => {
              const t = (m as { getTracks: () => FakeTrack[] }).getTracks()[0]
              const k = stopped.push(false) - 1
              t.stop = () => (stopped[k] = true)
              return m
            })
          )
        )
      )
    const first = st().joinVoice('lounge', 11)
    await until(() => grants.length === 1)
    const second = st().joinVoice('lounge', 12)
    await until(() => grants.length === 2)
    grants[1]?.()
    await second
    grants[0]?.()
    await first
    expect(st().error).toBeNull()
    expect(st().voice?.channelId).toBe(12)
    expect(rtc.active()).toBe(true)
    expect(sent.filter(m => m.type === 'voice_join')).toEqual([
      { type: 'voice_join', channel_id: 12, muted: false, deafened: false },
    ])
    expect(sent.some(m => m.type === 'voice_leave')).toBe(false)
    expect(stopped).toEqual([false, true])
  })
})

describe('timeouts in voice', () => {
  const summary = (until?: number) =>
    summaryOf('lounge', { display_name: 'Lounge', timed_out_until: until ?? null })
  const timeoutEvent = (until: number | null) =>
    st().applyWsEvent({
      type: 'member_timeout',
      server: 'lounge',
      username: 'alice',
      until,
      remaining: until === null ? 0 : 600,
      reason: null,
    })

  test('a guest joins voice under the name its connection got', async () => {
    const name = '@guest:00000000000000aa'
    useStore.setState({
      me: null,
      guest: true,
      guestVoiceName: null,
      servers: { lounge: serverDetail('lounge', { guest_voice: true }) },
      settings: { ...st().settings, guests_enabled: true, guest_voice_enabled: true },
    })
    await st().joinVoice('lounge', 3)
    expect(st().error).toBe('Create an account to join voice')
    expect(sent.some(m => m.type === 'voice_join')).toBe(false)
    useStore.setState({ error: null })
    st().applyWsEvent({ type: 'guest_name', name })
    expect(st().guestVoiceName).toBe(name)
    await st().joinVoice('lounge', 3)
    expect(st().error).toBeNull()
    expect(sent.some(m => m.type === 'voice_join' && m.channel_id === 3)).toBe(true)
    const roomState = (users: string[]) =>
      st().applyWsEvent({
        type: 'voice_state',
        server: 'lounge',
        channel_id: 3,
        users,
        audio: null,
      })
    roomState([name])
    expect(rtc.active()).toBe(true)
    roomState([])
    expect(rtc.active()).toBe(false)
    expect(st().voice).toBeNull()
    useStore.setState({ guest: false, guestVoiceName: null })
  })

  test('a timed out member cannot join voice in that server', async () => {
    useStore.setState({ me: me('alice', { servers: [summary()] }) })
    timeoutEvent(Math.floor(Date.now() / 1000) + 600)
    expect((st().me?.servers[0].timed_out_until ?? 0) > Date.now() / 1000).toBe(true)
    expect(st().timeouts).toEqual({})
    await st().joinVoice('lounge', 1)
    expect(/^You are timed out until .+\.$/.test(st().error ?? '')).toBe(true)
    expect(st().voice).toBeNull()
    expect(sent.some(m => m.type === 'voice_join')).toBe(false)
    useStore.setState({ error: null })
    timeoutEvent(null)
    expect(st().me?.servers[0].timed_out_until).toBeNull()
    await st().joinVoice('lounge', 1)
    expect(st().error).toBeNull()
    expect(st().voice?.channelId).toBe(1)
  })

  test('a timeout mutes the mic while joined and unmuting is ignored until it ends', async () => {
    useStore.setState({ me: me('alice', { servers: [summary()] }) })
    await st().joinVoice('lounge', 1)
    expect(lastTrack().enabled).toBe(true)
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'lounge',
      channel_id: 1,
      username: 'alice',
      muted: true,
    })
    expect(st().voiceMuted).toEqual({ 1: ['alice'] })
    expect(lastTrack().enabled).toBe(false)
    st().toggleMute()
    st().toggleMute()
    expect(lastTrack().enabled).toBe(false)
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'lounge',
      channel_id: 1,
      username: 'alice',
      muted: false,
    })
    expect(st().voiceMuted).toEqual({})
    expect(lastTrack().enabled).toBe(true)
  })

  test('a timeout stops the camera and screen share and keeps them off', async () => {
    useStore.setState({ me: me('alice', { servers: [summary()] }) })
    await st().joinVoice('lounge', 1)
    let stopped = 0
    const video = () => ({ kind: 'video', enabled: true, stop: () => (stopped += 1) })
    const live = rtc as unknown as { videoTrack: unknown; screen: unknown }
    live.videoTrack = video()
    live.screen = { video: video(), audio: null, audioNote: false }
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'lounge',
      channel_id: 1,
      username: 'alice',
      muted: true,
    })
    await Promise.resolve()
    expect(rtc.videoTrack).toBeNull()
    expect(rtc.sharing).toBe(false)
    expect(stopped).toBe(2)
    const asked = tracks.length
    await st().toggleCamera()
    expect(st().error).toBe(TIMED_OUT_CAMERA)
    useStore.setState({ error: null })
    await st().toggleShare()
    expect(st().error).toBe(TIMED_OUT_SHARE)
    expect(tracks.length).toBe(asked)
    expect(rtc.videoTrack).toBeNull()
    expect(rtc.sharing).toBe(false)
  })

  test("the member's own timeout follows the seconds left, not their clock", () => {
    useStore.setState({ me: me('alice', { servers: [summary()] }) })
    st().applyWsEvent({
      type: 'member_timeout',
      server: 'lounge',
      username: 'alice',
      until: 1,
      remaining: 600,
      reason: null,
    })
    const until = st().me?.servers[0].timed_out_until ?? 0
    expect(Math.abs(until - (Date.now() / 1000 + 600)) < 2).toBe(true)
  })

  test('muted users who leave the room are forgotten', () => {
    useStore.setState({ voiceMuted: { 4: ['bob', 'carol'] }, voiceUsers: {} })
    st().applyWsEvent({
      type: 'voice_state',
      server: 'lounge',
      channel_id: 4,
      users: ['carol'],
      audio: null,
    })
    expect(st().voiceMuted).toEqual({ 4: ['carol'] })
    st().applyWsEvent({
      type: 'voice_state',
      server: 'lounge',
      channel_id: 4,
      users: [],
      audio: null,
    })
    expect(st().voiceMuted).toEqual({})
  })

  test('moderators keep timeouts by server, the member keeps their own end', () => {
    useStore.setState({ me: me('mo', { servers: [summary()] }), timeouts: {} })
    st().applyWsEvent({
      type: 'member_timeout',
      server: 'lounge',
      username: 'bob',
      until: 1,
      remaining: 60,
      reason: 'spam',
    })
    const t = st().timeouts.lounge?.bob
    expect(t?.reason).toBe('spam')
    expect((t?.ends ?? 0) - Date.now() > 59_000).toBe(true)
    expect(st().me?.servers[0].timed_out_until).toBeNull()
    st().applyWsEvent({
      type: 'member_timeout',
      server: 'lounge',
      username: 'bob',
      until: null,
      remaining: 0,
      reason: null,
    })
    expect(st().timeouts.lounge).toEqual({})
  })
})

describe('what you hold in the voice channel', () => {
  const FULL =
    ChannelPermBit.ViewChannels |
    ChannelPermBit.ReadHistory |
    ChannelPermBit.Connect |
    ChannelPermBit.Speak |
    ChannelPermBit.Video
  const details = (mask: bigint) =>
    useStore.setState({
      servers: {
        lounge: serverDetail('lounge', {
          channels: [
            {
              id: 1,
              name: 'v',
              kind: 'voice',
              slowmode_seconds: 0,
              my_perms: mask,
              category_id: null,
              topic: null,
            },
          ],
        }),
      },
    })
  const listed = (muted: boolean) =>
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'lounge',
      channel_id: 1,
      username: 'alice',
      muted,
    })
  const join = async (mask: bigint) => {
    useStore.setState({
      me: me('alice', {
        servers: [
          {
            name: 'lounge',
            display_name: 'Lounge',
            creator: null,
            is_admin: false,
            banner_color: null,
            icon_image: null,
            icon_kind: 'identicon' as const,
            name_color: null,
            profiles_mode: 'all' as const,
            timed_out_remaining: null,
            timed_out_until: null,
          },
        ],
      }),
    })
    details(mask)
    await st().joinVoice('lounge', 1)
    expect(st().voice?.channelId).toBe(1)
  }
  const camera = () => {
    const live = rtc as unknown as { videoTrack: unknown; screen: unknown }
    live.videoTrack = { kind: 'video', enabled: true, stop: () => {} }
    live.screen = { video: { kind: 'video', enabled: true, stop: () => {} }, audio: null }
  }

  afterEach(() => useStore.setState({ servers: {} }))

  for (const detailsFirst of [true, false]) {
    const order = detailsFirst ? 'the details first' : 'the mute first'
    test(`getting Speak back opens the mic (${order})`, async () => {
      await join(FULL & ~ChannelPermBit.Speak)
      listed(true)
      expect(lastTrack().enabled).toBe(false)
      if (detailsFirst) details(FULL)
      listed(false)
      if (!detailsFirst) {
        expect(lastTrack().enabled).toBe(false)
        details(FULL)
      }
      expect(rtc.muted).toBe(false)
      expect(lastTrack().enabled).toBe(true)
    })

    test(`losing Speak closes the mic (${order})`, async () => {
      await join(FULL)
      expect(lastTrack().enabled).toBe(true)
      if (detailsFirst) details(FULL & ~ChannelPermBit.Speak)
      else listed(true)
      expect(lastTrack().enabled).toBe(false)
      if (detailsFirst) listed(true)
      else details(FULL & ~ChannelPermBit.Speak)
      st().toggleMute()
      st().toggleMute()
      expect(lastTrack().enabled).toBe(false)
    })

    test(`losing Video turns the camera and the share off (${order})`, async () => {
      await join(FULL)
      camera()
      if (detailsFirst) details(FULL & ~ChannelPermBit.Video)
      listed(false)
      if (!detailsFirst) {
        expect(rtc.videoTrack).not.toBeNull()
        details(FULL & ~ChannelPermBit.Video)
      }
      await Promise.resolve()
      expect(rtc.videoTrack).toBeNull()
      expect(rtc.sharing).toBe(false)
      expect(lastTrack().enabled).toBe(true)
    })
  }

  test('a change elsewhere leaves the mic and camera alone', async () => {
    await join(FULL)
    camera()
    useStore.setState({
      servers: {
        ...st().servers,
        other: serverDetail('other', {
          channels: [
            {
              id: 9,
              name: 'v',
              kind: 'voice',
              slowmode_seconds: 0,
              my_perms: 0n,
              category_id: null,
              topic: null,
            },
          ],
        }),
      },
    })
    details(FULL)
    await Promise.resolve()
    expect(rtc.videoTrack).not.toBeNull()
    expect(lastTrack().enabled).toBe(true)
    const live = rtc as unknown as { videoTrack: unknown; screen: unknown }
    live.videoTrack = null
    live.screen = null
  })
})

describe('guests muted by staff', () => {
  const guestName = '@guest:3f9a1c2b00000000'
  const hush = (muted: boolean, channel_id = 1) =>
    st().applyWsEvent({
      type: 'voice_muted',
      server: 'lounge',
      channel_id,
      username: guestName,
      muted,
      staff: true,
    })

  afterEach(() =>
    useStore.setState({ guest: false, guestVoiceName: null, voiceHushed: {}, voiceUsers: {} })
  )

  test('the guest sees it is muted and cannot unmute itself until staff end it', async () => {
    useStore.setState({
      me: null,
      guest: true,
      guestVoiceName: guestName,
      servers: { lounge: serverDetail('lounge', { guest_voice: true }) },
      settings: { ...st().settings, guest_voice_enabled: true },
    })
    await st().joinVoice('lounge', 1)
    expect(st().voice?.channelId).toBe(1)
    expect(lastTrack().enabled).toBe(true)
    hush(true)
    expect(st().voiceHushed).toEqual({ 1: [guestName] })
    expect(st().voiceMuted).toEqual({})
    expect(lastTrack().enabled).toBe(false)
    st().toggleMute()
    st().toggleMute()
    expect(lastTrack().enabled).toBe(false)
    hush(false)
    expect(st().voiceHushed).toEqual({})
    expect(lastTrack().enabled).toBe(true)
  })

  test('a staff mute leaves the camera alone', async () => {
    useStore.setState({
      me: null,
      guest: true,
      guestVoiceName: guestName,
      servers: { lounge: serverDetail('lounge', { guest_voice: true }) },
      settings: { ...st().settings, guest_voice_enabled: true },
    })
    await st().joinVoice('lounge', 1)
    const live = rtc as unknown as { videoTrack: unknown }
    live.videoTrack = { kind: 'video', enabled: true, stop: () => {} }
    hush(true)
    await Promise.resolve()
    expect(rtc.videoTrack).not.toBeNull()
    live.videoTrack = null
  })

  test("a guest can't join voice where the server keeps guests out", async () => {
    useStore.setState({
      me: null,
      guest: true,
      guestVoiceName: guestName,
      servers: { lounge: serverDetail('lounge', { guest_voice: false }) },
    })
    await st().joinVoice('lounge', 1)
    expect(st().error).toBe("Guests can't use voice in this server")
    expect(st().voice).toBeNull()
    expect(sent.some(m => m.type === 'voice_join')).toBe(false)
    useStore.setState({ error: null, servers: {} })
  })

  test('the mark is kept per room and forgotten when the guest leaves it', () => {
    useStore.setState({ voiceUsers: { 1: [guestName, 'bob'] } })
    hush(true)
    hush(true, 2)
    expect(st().voiceHushed).toEqual({ 1: [guestName], 2: [guestName] })
    st().applyWsEvent({
      type: 'voice_state',
      server: 'lounge',
      channel_id: 1,
      users: ['bob'],
      audio: null,
    })
    expect(st().voiceHushed).toEqual({ 2: [guestName] })
    st().applyWsEvent({
      type: 'voice_state',
      server: 'lounge',
      channel_id: 2,
      users: [],
      audio: null,
    })
    expect(st().voiceHushed).toEqual({})
  })
})

describe('what people in voice say about their own audio', () => {
  const said = (channel_id: number, username: string, muted: boolean, deafened: boolean) =>
    st().applyWsEvent({
      type: 'voice_audio',
      server: 'lounge',
      channel_id,
      username,
      muted,
      deafened,
    })
  const audioSent = () => sent.filter(m => m.type === 'voice_audio')
  const settle = () => clock.pass(AUDIO_SEND_MS + 150)
  const listed = (
    channel_id: number,
    users: string[],
    audio?: { username: string; muted: boolean; deafened: boolean }[]
  ) =>
    st().applyWsEvent({
      audio: null,
      type: 'voice_state',
      server: 'lounge',
      channel_id,
      users,
      ...(audio ? { audio } : {}),
    })
  const talk = {
    id: 3,
    name: 'talk',
    kind: 'voice' as const,
    slowmode_seconds: 0,
    category_id: null,
    my_perms: null,
    topic: null,
  }
  const marked = { ...talk, id: 4, name: 'marked', sensitive: true }

  afterEach(() => useStore.setState({ voiceAudio: {}, voiceUsers: {}, servers: {} }))

  test('voice_audio applies, goes with the roster and is ignored in a room closed here', () => {
    useStore.setState({
      servers: { lounge: serverDetail('lounge', { channels: [talk, marked] }) },
      voiceUsers: { 3: ['bob', 'carol'] },
    })
    said(3, 'bob', true, false)
    said(3, 'carol', true, true)
    expect(st().voiceAudio).toEqual({
      3: { bob: { muted: true, deafened: false }, carol: { muted: true, deafened: true } },
    })
    said(3, 'bob', false, false)
    expect(st().voiceAudio).toEqual({ 3: { carol: { muted: true, deafened: true } } })
    said(4, 'dan', true, false)
    expect(st().voiceAudio[4]).toBeUndefined()
    listed(3, ['bob'])
    expect(st().voiceAudio).toEqual({})
  })

  test("a snapshot's room state brings the room's audio, and not into a room closed here", () => {
    useStore.setState({
      servers: { lounge: serverDetail('lounge', { channels: [talk, marked] }) },
      voiceAudio: { 3: { gone: { muted: true, deafened: false } } },
    })
    listed(
      3,
      ['bob', 'carol', 'dan'],
      [
        { username: 'bob', muted: true, deafened: false },
        { username: 'carol', muted: true, deafened: true },
        { username: 'dan', muted: false, deafened: false },
        { username: 'eve', muted: true, deafened: false },
        { username: 7, muted: true } as unknown as {
          username: string
          muted: boolean
          deafened: boolean
        },
      ]
    )
    expect(st().voiceAudio).toEqual({
      3: { bob: { muted: true, deafened: false }, carol: { muted: true, deafened: true } },
    })
    listed(3, ['bob', 'carol', 'dan'], [])
    expect(st().voiceAudio).toEqual({})
    listed(4, ['dan'], [{ username: 'dan', muted: true, deafened: false }])
    expect(st().voiceAudio).toEqual({})
  })

  test('your own changes go once after a short wait, and every join carries them', async () => {
    await st().joinVoice('lounge', 1)
    expect(sent.find(m => m.type === 'voice_join')).toEqual({
      type: 'voice_join',
      channel_id: 1,
      muted: false,
      deafened: false,
    })
    listed(1, ['alice'])
    st().toggleMute()
    st().toggleDeafen()
    st().toggleDeafen()
    expect(audioSent()).toEqual([])
    await until(() => audioSent().length > 0, 2000)
    expect(audioSent()).toEqual([{ type: 'voice_audio', muted: true, deafened: false }])
    said(1, 'alice', true, false)
    st().toggleMute()
    st().toggleMute()
    await settle()
    expect(audioSent()).toHaveLength(1)
    await switchCall(() => st().joinVoice('lounge', 2))
    expect(sent.filter(m => m.type === 'voice_join').at(-1)).toEqual({
      type: 'voice_join',
      channel_id: 2,
      muted: true,
      deafened: false,
    })
    listed(2, ['alice'])
    expect(audioSent()).toHaveLength(1)
    said(2, 'alice', true, false)
    st().toggleDeafen()
    await until(() => audioSent().length > 1, 2000)
    expect(audioSent().at(-1)).toEqual({ type: 'voice_audio', muted: true, deafened: true })
    st().leaveVoice()
    await settle()
    expect(audioSent()).toHaveLength(2)
  })

  test('what the roster says about us is set right once, and again when the room changes', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleMute()
    await settle()
    expect(audioSent()).toEqual([])
    listed(1, ['alice'])
    expect(audioSent()).toEqual([{ type: 'voice_audio', muted: true, deafened: false }])
    listed(1, ['alice'])
    expect(audioSent()).toHaveLength(2)
    // A resync brings the room again: once it says what we said, nothing more goes.
    listed(1, ['alice'], [{ username: 'alice', muted: true, deafened: false }])
    expect(audioSent()).toHaveLength(2)
    // A lost change: the next room state shows it and it goes again.
    listed(1, ['alice'], [])
    expect(audioSent()).toHaveLength(3)
    said(1, 'alice', true, false)
    await settle()
    expect(audioSent()).toHaveLength(3)
  })

  test('while another tab holds the seat, ours says its audio once the seat moves here', async () => {
    useStore.setState({
      voiceUsers: { 1: ['alice'] },
      voiceAudio: { 1: { alice: { muted: true, deafened: false } } },
    })
    await st().joinVoice('lounge', 1)
    listed(1, ['alice'])
    expect(audioSent()).toEqual([])
    st().toggleMute()
    await settle()
    expect(audioSent()).toEqual([])
    // The join lands with what it carried: an open mic.
    listed(1, ['alice'])
    said(1, 'alice', false, false)
    expect(audioSent()).toEqual([{ type: 'voice_audio', muted: true, deafened: false }])
  })
})

describe('voice rooms a refetch reveals', () => {
  const realFetch = globalThis.fetch
  const ws = home.ws as unknown as { resubscribe: () => void }
  const realResubscribe = ws.resubscribe

  afterEach(() => {
    globalThis.fetch = realFetch
    ws.resubscribe = realResubscribe
    useStore.setState({ servers: {} })
  })

  test('ask for the rosters again, so their audio shows', async () => {
    const talk = {
      id: 3,
      name: 'talk',
      kind: 'voice' as const,
      slowmode_seconds: 0,
      category_id: null,
      my_perms: null,
      topic: null,
    }
    const hidden = { ...talk, id: 4, name: 'hidden' }
    const chat = { ...talk, id: 5, name: 'chat', kind: 'text' as const }
    let detail = serverDetail('lounge', { channels: [talk] })
    globalThis.fetch = (async () => Response.json(detail)) as unknown as typeof fetch
    let asked = 0
    ws.resubscribe = () => {
      asked += 1
    }
    useStore.setState({ servers: { lounge: detail } })
    const refetched = async (next: typeof detail) => {
      detail = next
      const before = st().servers.lounge
      st().applyWsEvent({ type: 'channel_perms_changed', server: 'lounge', channel_id: 3 })
      await until(() => st().servers.lounge !== before, 2000)
      expect(st().servers.lounge?.channels.map(c => c.id)).toEqual(next.channels.map(c => c.id))
    }
    await refetched(serverDetail('lounge', { channels: [talk] }))
    expect(asked).toBe(0)
    await refetched(serverDetail('lounge', { channels: [talk, hidden] }))
    expect(asked).toBe(1)
    await refetched(serverDetail('lounge', { channels: [talk, hidden, chat] }))
    expect(asked).toBe(1)
  })
})
