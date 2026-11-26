import { describe, expect, test } from 'bun:test'
import { STAFF_MUTED } from '../guest_voice'
import { TIMED_OUT_MIC } from '../timeouts'
import { SELF_AUDIO_IDLE, toggleDeafenAudio, toggleMicAudio } from '../voice_layout'
import {
  MODERATOR_MUTED,
  VOICE_STATUS_ON,
  voiceStatus,
  voiceStatusText,
  type VoiceStatusInput,
} from '../voice_status'

const input = (over: Partial<VoiceStatusInput> = {}): VoiceStatusInput => ({
  self: false,
  selfAudio: SELF_AUDIO_IDLE,
  live: null,
  roster: null,
  forced: null,
  ...over,
})

const muted = { muted: true, deafened: false }
const deaf = { muted: true, deafened: true }
const open = { muted: false, deafened: false }

describe('voice member status', () => {
  test('the precedence table', () => {
    const rows: [Partial<VoiceStatusInput>, ReturnType<typeof voiceStatus>][] = [
      [{}, VOICE_STATUS_ON],
      [{ roster: muted }, { mic: 'self', forced: null, deafened: false }],
      [{ roster: deaf }, { mic: 'self', forced: null, deafened: true }],
      [{ roster: { muted: false, deafened: true } }, { mic: 'self', forced: null, deafened: true }],
      [{ live: { muted: true } }, { mic: 'self', forced: null, deafened: false }],
      [{ forced: 'timeout' }, { mic: 'forced', forced: 'timeout', deafened: false }],
      [
        { forced: 'staff', roster: deaf },
        { mic: 'forced', forced: 'staff', deafened: true },
      ],
      [
        { self: true, selfAudio: toggleMicAudio(SELF_AUDIO_IDLE) },
        { mic: 'self', forced: null, deafened: false },
      ],
      [
        { self: true, selfAudio: toggleDeafenAudio(SELF_AUDIO_IDLE) },
        { mic: 'self', forced: null, deafened: true },
      ],
      [{ self: true, roster: deaf, live: { muted: true } }, VOICE_STATUS_ON],
      [{ self: false, selfAudio: toggleDeafenAudio(SELF_AUDIO_IDLE) }, VOICE_STATUS_ON],
    ]
    for (const [over, want] of rows) expect(voiceStatus(input(over))).toEqual(want)
  })

  test('deafened shows both icons', () => {
    const st = voiceStatus(input({ roster: deaf }))
    expect(voiceStatusText(st, false)).toEqual({ mic: 'Muted', sound: 'Deafened' })
    const mine = voiceStatus(input({ self: true, selfAudio: toggleDeafenAudio(SELF_AUDIO_IDLE) }))
    expect(voiceStatusText(mine, true)).toEqual({ mic: 'Muted', sound: 'Deafened' })
  })

  test('a forced mute wins over your own settings and what a peer said', () => {
    const self = voiceStatus(input({ self: true, forced: 'timeout' }))
    expect(self.mic).toBe('forced')
    expect(voiceStatusText(self, true).mic).toBe(TIMED_OUT_MIC)
    const peer = voiceStatus(input({ forced: 'timeout', roster: open, live: { muted: false } }))
    expect(voiceStatusText(peer, false)).toEqual({ mic: MODERATOR_MUTED, sound: null })
    const guest = voiceStatus(input({ forced: 'staff', roster: muted }))
    expect(voiceStatusText(guest, false).mic).toBe(STAFF_MUTED)
  })

  test('the live state of a peer in your call wins over what the roster says', () => {
    expect(voiceStatus(input({ live: { muted: false }, roster: muted })).mic).toBe('on')
    expect(voiceStatus(input({ live: { muted: true }, roster: open })).mic).toBe('self')
    expect(voiceStatus(input({ live: { muted: false }, roster: deaf }))).toEqual({
      mic: 'self',
      forced: null,
      deafened: true,
    })
  })

  test('nothing to say shows no icons', () => {
    expect(voiceStatusText(VOICE_STATUS_ON, false)).toEqual({ mic: null, sound: null })
  })
})
