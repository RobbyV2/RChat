import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { home } from '../instances'
import { rtc } from '../rtc'
import { p2p } from '../p2p'
import { useStore } from '../store'
import { SELF_AUDIO_IDLE } from '../voice_layout'
import type { VoiceMsg, WsEvent } from '../types'
import { me, memoryStorage } from './fixtures'

const st = () => useStore.getState()
const dispatch = (ev: WsEvent) => st().applyWsEvent(ev)
const storage = new Map<string, string>()

beforeEach(() => {
  storage.clear()
  Object.assign(globalThis, {
    localStorage: {
      getItem: (k: string) => storage.get(k) ?? null,
      setItem: (k: string, v: string) => void storage.set(k, v),
      removeItem: (k: string) => void storage.delete(k),
    },
  })
  useStore.setState({ me: me('alice'), guest: false, callRoute: 'server', call: null })
})

afterEach(() => {
  Object.assign(globalThis, { localStorage: memoryStorage })
  useStore.setState({ me: null, call: null, callRoute: 'server', p2pCallFailed: {} })
})

describe('call connection choice', () => {
  test('is remembered per account', () => {
    st().setCallRoute('p2p')
    expect(st().callRoute).toBe('p2p')
    expect(JSON.parse(storage.get('rchat_call:alice') ?? 'null')).toEqual({ v: 1, route: 'p2p' })
    useStore.setState({ me: me('bob'), callRoute: 'server' })
    st().setCallRoute('server')
    expect(storage.has('rchat_call:bob')).toBe(false)
  })

  test('guests and signed out sessions never write', () => {
    useStore.setState({ me: null, guest: true })
    st().setCallRoute('p2p')
    expect([st().callRoute, storage.size]).toEqual(['server', 0])
  })

  test('an imported config sets it for the signed in account', async () => {
    expect(await st().applyConfig({ v: 1, calls: 'p2p' }, ['calls'])).toBeNull()
    expect(st().callRoute).toBe('p2p')
    expect(storage.get('rchat_call:alice')).toBe('{"v":1,"route":"p2p"}')
  })
})

describe('call type on the wire', () => {
  const ws = home.ws as unknown as { sendVoice: (m: VoiceMsg) => boolean }
  const realSend = ws.sendVoice
  const realJoin = rtc.join.bind(rtc)
  const realCamera = rtc.camera.bind(rtc)
  const realStart = p2p.startMedia.bind(p2p)
  const realCam = p2p.toggleCamera.bind(p2p)
  const realPeer = p2p.peerId.bind(p2p)
  let sent: VoiceMsg[] = []
  beforeEach(() => {
    sent = []
    ws.sendVoice = m => {
      sent.push(m)
      return true
    }
    Object.assign(rtc, { join: async () => {}, camera: async () => {} })
    Object.assign(p2p, {
      startMedia: async () => {},
      toggleCamera: async () => {},
      peerId: () => 'alice-tab',
    })
    useStore.setState({ selfAudio: SELF_AUDIO_IDLE, voice: null })
  })
  afterEach(() => {
    ws.sendVoice = realSend
    Object.assign(rtc, { join: realJoin, camera: realCamera })
    Object.assign(p2p, { startMedia: realStart, toggleCamera: realCam, peerId: realPeer })
  })

  test('server and direct calls say whether they start with video', async () => {
    await st().startCall(5, true)
    useStore.setState({ call: null })
    await st().startP2pCall(5, false)
    expect(sent).toEqual([
      { type: 'call_start', dm_id: 5, video: true },
      { type: 'call_start', dm_id: 5, p2p: true, video: false, peer_id: 'alice-tab' },
    ])
  })

  test('the call state keeps the type and when it went live', () => {
    const state = (phase: 'ringing' | 'active', video?: boolean): WsEvent => ({
      type: 'call_state',
      dm_id: 5,
      dm_users: ['alice', 'bob'],
      state: phase,
      from: 'bob',
      kind: 'rtc',
      ...(video === undefined ? {} : { video }),
    })
    useStore.setState({ dms: [{ id: 5, other: me('bob'), is_self: false }] })
    dispatch(state('ringing', true))
    expect([st().call?.video, st().call?.since]).toEqual([true, null])
    const before = Math.floor(Date.now() / 1000)
    dispatch(state('active', true))
    const since = st().call?.since ?? 0
    expect(since >= before).toBe(true)
    useStore.setState({ call: { ...st().call!, since: since - 30 } })
    dispatch(state('active', true))
    expect(st().call?.since).toBe(since - 30)
    dispatch(state('ringing'))
    expect(st().call?.video).toBe(false)
  })

  test("the server's answer time starts the timer, so a reload keeps it", () => {
    useStore.setState({ dms: [{ id: 5, other: me('bob'), is_self: false }] })
    const answered = Math.floor(Date.now() / 1000) - 90
    dispatch({
      type: 'call_state',
      dm_id: 5,
      dm_users: ['alice', 'bob'],
      state: 'active',
      from: 'bob',
      kind: 'rtc',
      answered_at: answered,
    })
    expect(st().call?.since).toBe(answered)
  })
})
