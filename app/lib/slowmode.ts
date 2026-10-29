import { Perm, hasPerm } from './types'
import { SLOWMODE_MAX } from './rules'
import { fmtDuration } from './voice_layout'

export const SLOWMODE_PRESETS = [
  0, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 21600,
] as const

export const CUSTOM = 'custom'

export const slowLabel = (seconds: number): string => {
  if (seconds <= 0) return 'Off'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60
  const parts = [h ? `${h}h` : '', m ? `${m}m` : '', s ? `${s}s` : ''].filter(Boolean)
  return parts.join(' ')
}

export const slowTitle = (seconds: number) => `Slow mode is on: ${slowLabel(seconds)}`

export const isPreset = (seconds: number) =>
  (SLOWMODE_PRESETS as readonly number[]).includes(seconds)

export const customSeconds = (raw: string): number | null => {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= SLOWMODE_MAX ? n : null
}

export const slowWait = (message: string): number | null => {
  const hit = /^Slow mode: wait (\d+)s$/.exec(message)
  return hit ? Number(hit[1]) : null
}

export const slowExempt = (perms: number) =>
  hasPerm(perms, Perm.ManageChannels) || hasPerm(perms, Perm.DeleteMessages)

export const clock = (ms: number): string => fmtDuration(Math.max(0, Math.ceil(ms / 1000)))
