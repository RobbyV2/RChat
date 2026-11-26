// What a voice member's mic and sound icons show, in voice channels of instance servers and of
// P2P servers alike.

import { STAFF_MUTED } from './guest_voice'
import { TIMED_OUT_MIC } from './timeouts'
import type { SelfAudio } from './voice_layout'

export interface SeatAudio {
  muted: boolean
  deafened: boolean
}

export interface VoiceStatusInput {
  // Your own row in the call you are in here: your own audio settings decide.
  self: boolean
  selfAudio: SelfAudio
  // The peer's media state while you share the call.
  live: { muted: boolean } | null
  // What they said about themselves: the instance roster or their P2P frame.
  roster: SeatAudio | null
  // A timeout or staff mute.
  forced: 'timeout' | 'staff' | null
}

export interface VoiceStatus {
  mic: 'on' | 'self' | 'forced'
  forced: 'timeout' | 'staff' | null
  deafened: boolean
}

export const VOICE_STATUS_ON: VoiceStatus = { mic: 'on', forced: null, deafened: false }

// A forced mute wins; then your own settings, or for a peer their live state over what they said.
// Deafened also shows the mic as off.
export const voiceStatus = (i: VoiceStatusInput): VoiceStatus => {
  const deafened = i.self ? i.selfAudio.deafened : (i.roster?.deafened ?? false)
  const muted = i.self ? i.selfAudio.muted : (i.live?.muted ?? i.roster?.muted ?? false)
  if (i.forced) return { mic: 'forced', forced: i.forced, deafened }
  return { mic: muted || deafened ? 'self' : 'on', forced: null, deafened }
}

export const MODERATOR_MUTED = 'Muted by a moderator'

export const voiceStatusText = (
  st: VoiceStatus,
  self: boolean
): { mic: string | null; sound: string | null } => ({
  mic:
    st.mic === 'on'
      ? null
      : st.forced === 'timeout'
        ? self
          ? TIMED_OUT_MIC
          : MODERATOR_MUTED
        : st.forced === 'staff'
          ? STAFF_MUTED
          : 'Muted',
  sound: st.deafened ? 'Deafened' : null,
})
