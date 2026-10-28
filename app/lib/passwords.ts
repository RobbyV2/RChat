import { useEffect, useState } from 'react'
import { expiryText } from './rules'
import type { PasswordStatus, ServerPassword, ServerPasswords } from './types'

export const EXPIRY_PRESETS: { label: string; seconds: number }[] = [
  { label: '30 minutes', seconds: 30 * 60 },
  { label: '1 hour', seconds: 3600 },
  { label: '6 hours', seconds: 6 * 3600 },
  { label: '12 hours', seconds: 12 * 3600 },
  { label: '1 day', seconds: 86400 },
  { label: '7 days', seconds: 7 * 86400 },
  { label: '30 days', seconds: 30 * 86400 },
]

export const USE_PRESETS = [1, 2, 5, 10, 25, 100]

export const USES_MAX = 10_000
export const EXPIRY_MIN = 60
export const EXPIRY_MAX = 365 * 86400
export const ACTIVE_MAX = 50

export const STATUS_LABEL: Record<PasswordStatus, string> = {
  live: 'Live',
  expired: 'Expired',
  used_up: 'Used up',
  revoked: 'Revoked',
}

export const statusAt = (p: ServerPassword, now: number): PasswordStatus =>
  p.status === 'live' && p.expires_at !== null && p.expires_at <= now ? 'expired' : p.status

export const isClosed = (s: ServerPasswords, now: number) =>
  s.protected && !s.permanent && !s.passwords.some(p => statusAt(p, now) === 'live')

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

export const usesText = (uses: number, max: number | null) =>
  max === null ? plural(uses, 'use') : `${uses}/${max}`

export const usesLeftText = (left: number) => `${plural(Math.max(0, left), 'use')} left`

export const countdown = (expiresAt: number, now: number) => expiryText(expiresAt - now)

export const absoluteTime = (seconds: number) =>
  new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })

export const tickMs = (remaining: number) => (remaining <= 120 ? 1000 : 30_000)

export const parseUses = (raw: string): number | null => {
  const text = raw.trim()
  if (!/^\d+$/.test(text)) return null
  const n = Number(text)
  return n >= 1 && n <= USES_MAX ? n : null
}

const pad = (n: number) => String(n).padStart(2, '0')

export const toLocalInput = (ms: number) => {
  const d = new Date(ms)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export const customExpiry = (
  local: string,
  nowMs: number
): { at: number; error: null } | { at: null; error: string } => {
  const ms = local ? new Date(local).getTime() : NaN
  if (!Number.isFinite(ms)) return { at: null, error: 'Pick a date and time' }
  const at = Math.floor(ms / 1000)
  const now = Math.floor(nowMs / 1000)
  if (at - now < EXPIRY_MIN) return { at: null, error: 'Pick a time at least a minute away' }
  if (at - now > EXPIRY_MAX) return { at: null, error: 'Pick a time within a year' }
  return { at, error: null }
}

export interface SecretBook {
  v: 1
  servers: Record<string, Record<string, string>>
}

export const emptySecrets = (): SecretBook => ({ v: 1, servers: {} })

export const secretsKey = (username: string) => `rchat_server_passwords:${username}`

const isRecord = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

export const parseSecrets = (raw: string | null): SecretBook => {
  let data: unknown
  try {
    data = raw ? JSON.parse(raw) : null
  } catch {
    return emptySecrets()
  }
  if (!isRecord(data) || data.v !== 1 || !isRecord(data.servers)) return emptySecrets()
  const servers: SecretBook['servers'] = {}
  for (const [server, ids] of Object.entries(data.servers)) {
    if (!isRecord(ids)) continue
    const kept: Record<string, string> = {}
    for (const [id, secret] of Object.entries(ids))
      if (/^\d+$/.test(id) && typeof secret === 'string' && secret) kept[id] = secret
    if (Object.keys(kept).length) servers[server] = kept
  }
  return { v: 1, servers }
}

export const withSecret = (
  book: SecretBook,
  server: string,
  id: number,
  secret: string
): SecretBook => ({
  v: 1,
  servers: { ...book.servers, [server]: { ...book.servers[server], [String(id)]: secret } },
})

export const keepSecrets = (book: SecretBook, server: string, live: number[]): SecretBook => {
  const ids = book.servers[server]
  if (!ids) return book
  const kept = Object.fromEntries(Object.entries(ids).filter(([id]) => live.includes(Number(id))))
  const servers = { ...book.servers }
  if (Object.keys(kept).length) servers[server] = kept
  else delete servers[server]
  return { v: 1, servers }
}

export const secretFor = (book: SecretBook, server: string, id: number) =>
  book.servers[server]?.[String(id)] ?? null

const nowSeconds = () => Math.floor(Date.now() / 1000)

export function useNow(ms: number) {
  const [now, setNow] = useState(nowSeconds)
  useEffect(() => {
    setNow(nowSeconds())
    const id = window.setInterval(() => setNow(nowSeconds()), ms)
    return () => window.clearInterval(id)
  }, [ms])
  return now
}
