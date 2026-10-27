import type { CallLog } from './types'

export const TILE_ASPECT = 16 / 9
const SPREAD = 0.85

export interface GridFit {
  cols: number
  width: number
  height: number
}

export const maxColumns = (count: number) => {
  if (count <= 1) return 1
  if (count <= 4) return 2
  if (count <= 9) return 3
  return 4
}

export const fitGrid = (
  count: number,
  width: number,
  height: number,
  gap = 8,
  minWidth = 150
): GridFit => {
  const n = Math.max(1, count)
  const fits: GridFit[] = []
  for (let cols = 1; cols <= Math.min(n, maxColumns(n)); cols++) {
    const rows = Math.ceil(n / cols)
    const byWidth = (width - gap * (cols - 1)) / cols
    const byHeight = ((height - gap * (rows - 1)) / rows) * TILE_ASPECT
    const w = Math.floor(Math.max(0, Math.min(byWidth, byHeight)))
    fits.push({ cols, width: w, height: Math.floor(w / TILE_ASPECT) })
  }
  const largest = Math.max(...fits.map(f => f.width))
  const fit = fits.findLast(f => f.width >= largest * SPREAD) ?? fits[0]
  if (fit.width >= minWidth || width <= 0) return fit
  const cols = Math.max(1, Math.min(maxColumns(n), Math.floor((width + gap) / (minWidth + gap))))
  const w = Math.floor((width - gap * (cols - 1)) / cols)
  return { cols, width: w, height: Math.floor(w / TILE_ASPECT) }
}

export const toggleFocus = (current: string | null, key: string) => (current === key ? null : key)

export const keepFocus = (current: string | null, keys: string[]) =>
  current !== null && keys.includes(current) ? current : null

export type LinkQuality = 'good' | 'connecting' | 'bad'

export const linkQuality = (states: RTCPeerConnectionState[]): LinkQuality => {
  if (states.some(s => s === 'failed' || s === 'disconnected')) return 'bad'
  if (states.some(s => s === 'new' || s === 'connecting')) return 'connecting'
  return 'good'
}

export type CallTone = 'ringing' | 'active' | 'ended' | 'declined' | 'missed'

export const callTone = (call: CallLog): CallTone => {
  if (call.ended_at === null) return call.answered_at === null ? 'ringing' : 'active'
  if (call.outcome === 'completed' && call.answered_at !== null) return 'ended'
  return call.outcome === 'declined' ? 'declined' : 'missed'
}

export const fmtDuration = (s: number) => {
  const pad = (n: number) => String(n).padStart(2, '0')
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const sec = s % 60
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`
}

export const spokenDuration = (s: number) => {
  if (s < 60) return 'a few seconds'
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const part = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`
  if (h === 0) return part(m, 'minute')
  return m === 0 ? part(h, 'hour') : `${part(h, 'hour')} ${part(m, 'minute')}`
}

export interface SelfAudio {
  muted: boolean
  deafened: boolean
  restoreMute: boolean
}

export const SELF_AUDIO_IDLE: SelfAudio = { muted: false, deafened: false, restoreMute: false }

export const toggleMicAudio = (s: SelfAudio): SelfAudio =>
  s.deafened ? SELF_AUDIO_IDLE : { ...s, muted: !s.muted }

export const toggleDeafenAudio = (s: SelfAudio): SelfAudio =>
  s.deafened
    ? { muted: s.restoreMute, deafened: false, restoreMute: false }
    : { muted: true, deafened: true, restoreMute: s.muted }
