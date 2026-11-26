'use client'
import { MicOff, VolumeX } from 'lucide-react'
import { voiceStatusText, type VoiceStatus } from '../lib/voice_status'

// A voice member's mic and sound icons: in sidebar rows (`row`), or on a grid tile's name pill
// (`tile`), where a forced mute keeps its red badge.
export function VoiceStatusIcons({
  status,
  self,
  size,
  variant,
}: {
  status: VoiceStatus
  self: boolean
  size: number
  variant: 'row' | 'tile'
}) {
  const text = voiceStatusText(status, self)
  if (text.mic === null && text.sound === null) return null
  const tile = variant === 'tile'
  const forced = status.mic === 'forced'
  const mic = tile
    ? forced
      ? 'rounded-full bg-mute p-0.5 text-on-mute'
      : ''
    : forced
      ? 'text-mute-fg'
      : 'text-on-surface-variant'
  const sound = tile ? '' : 'text-on-surface-variant'
  const stroke = tile ? 2.5 : 2
  return (
    <span data-voice-status className="flex shrink-0 items-center gap-1">
      {text.mic !== null && (
        <span role="img" title={text.mic} aria-label={text.mic} className={`flex shrink-0 ${mic}`}>
          <MicOff size={size} strokeWidth={stroke} aria-hidden />
        </span>
      )}
      {text.sound !== null && (
        <span
          role="img"
          title={text.sound}
          aria-label={text.sound}
          className={`flex shrink-0 ${sound}`}
        >
          <VolumeX size={size} strokeWidth={stroke} aria-hidden />
        </span>
      )}
    </span>
  )
}
