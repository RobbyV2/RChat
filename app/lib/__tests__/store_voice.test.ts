import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { home } from '../instances'
import { rtc } from '../rtc'
import { useStore } from '../store'
import { SELF_AUDIO_IDLE, toggleDeafenAudio, toggleMicAudio, type SelfAudio } from '../voice_layout'
import type { VoiceMsg } from '../types'
import { me } from './fixtures'

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
  tracks = []
  sent = []
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      mediaDevices: {
        getUserMedia: async () => {
          const track: FakeTrack = { kind: 'audio', enabled: true, stop: () => {} }
          tracks.push(track)
          return { getTracks: () => [track], getAudioTracks: () => [track] }
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
    openChannel: async () => {},
  })
})

afterEach(() => {
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
    openChannel: realOpen,
  })
})

const ringFromBob = () =>
  useStore.setState({
    call: { dmId: 7, dmUsers: ['alice', 'bob'], state: 'ringing', from: 'bob', kind: 'rtc' },
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
  test('deafen, then switch channel: still deafened and the new mic starts muted', async () => {
    await st().joinVoice('lounge', 1)
    expect(lastTrack().enabled).toBe(true)
    st().toggleDeafen()
    expect(lastTrack().enabled).toBe(false)
    await st().joinVoice('lounge', 2)
    expect(st().voice?.channelId).toBe(2)
    expect(tracks).toHaveLength(2)
    expect(lastTrack().enabled).toBe(false)
    expect(rtc.muted).toBe(true)
    expect(st().selfAudio).toEqual({ muted: true, deafened: true, restoreMute: false })
  })

  test('mute, then switch channel: the new mic stays muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleMute()
    await st().joinVoice('lounge', 2)
    expect(lastTrack().enabled).toBe(false)
    expect(rtc.muted).toBe(true)
  })

  test('deafen in voice, then accept a DM call: the call mic starts muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    ringFromBob()
    await st().acceptCall()
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
    let grant = () => {}
    media.getUserMedia = () => new Promise(done => (grant = () => done(open())))
    const accepting = st().acceptCall()
    useStore.setState({ call: null })
    grant()
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

  test('hanging up a call resets mute and deafen', async () => {
    await st().startCall(7, false)
    st().toggleDeafen()
    useStore.setState({
      call: { dmId: 7, dmUsers: ['alice', 'bob'], state: 'active', from: 'alice', kind: 'rtc' },
    })
    st().hangupCall()
    expect(rtc.active()).toBe(false)
    expect(st().selfAudio).toEqual(SELF_AUDIO_IDLE)
  })

  test('starting a call while deafened in voice starts muted', async () => {
    await st().joinVoice('lounge', 1)
    st().toggleDeafen()
    await st().startCall(7, false)
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
    await st().joinVoice('lounge', 2)
    expect(st().error === null).toBe(false)
    expect(rtc.active()).toBe(false)
    expect(st().voice).toBeNull()
    expect(st().selfAudio).toEqual(SELF_AUDIO_IDLE)
    expect(sent.some(m => m.type === 'voice_leave')).toBe(true)
  })
})
