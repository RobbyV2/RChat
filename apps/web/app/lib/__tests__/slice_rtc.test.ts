import { afterAll, describe, expect, test } from 'bun:test'
import { applyCallState, applyVoiceState } from '../slices/rtc'
import { resetSessionCaches, useStore, type CallSession, type RChatState } from '../store'
import type { WsEvent } from '../types'

afterAll(resetSessionCaches)

const state = (over: Partial<RChatState>): RChatState => ({ ...useStore.getState(), ...over })
const voice = (users: string[]) => ({
  type: 'voice_state' as const,
  server: 's',
  channel_id: 5,
  users,
})
const call = (over: Partial<Extract<WsEvent, { type: 'call_state' }>>) => ({
  type: 'call_state' as const,
  dm_id: 3,
  dm_users: ['alice', 'bob'],
  state: 'active' as const,
  from: 'alice',
  kind: 'rtc' as const,
  ...over,
})
const session: CallSession = {
  dmId: 3,
  dmUsers: ['alice', 'bob'],
  state: 'ringing',
  from: 'alice',
  kind: 'rtc',
  video: false,
  since: null,
  relays: [],
}

describe('rtc reducers', () => {
  test("voice_state replaces the channel's member list", () => {
    const s = state({
      voiceUsers: { 5: ['a', 'b'], 6: ['z'] },
      voiceMuted: { 5: ['a', 'b'], 6: ['z'] },
    })
    const out = applyVoiceState(s, voice(['c', 'b']))
    expect(out.voiceUsers).toEqual({ 5: ['c', 'b'], 6: ['z'] })
    expect(out.voiceMuted).toEqual({ 5: ['b'], 6: ['z'] })
    const gone = applyVoiceState(s, voice([]))
    expect(gone.voiceUsers).toEqual({ 6: ['z'] })
    expect(gone.voiceMuted).toEqual({ 6: ['z'] })
    const kept = applyVoiceState(s, voice(['a', 'b']))
    expect(kept.voiceMuted).toBeUndefined()
  })

  test('call_state with ended clears the call', () => {
    const s = state({ call: session })
    expect(applyCallState(s, call({ state: 'ended' }))).toEqual({ call: null })
    expect(applyCallState(s, call({ state: 'ended', dm_id: 4 }))).toEqual({})
  })

  test('an active call keeps the answer time it knows', () => {
    const s = state({ call: { ...session, state: 'active', since: 77 } })
    expect(applyCallState(s, call({ answered_at: 90 })).call?.since).toBe(90)
    expect(applyCallState(s, call({})).call?.since).toBe(77)
    expect(applyCallState(s, call({ state: 'ringing' })).call?.since).toBeNull()
  })
})
