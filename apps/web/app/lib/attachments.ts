import { ApiError } from './api'
import type { SiteSettings } from './types'

export type UploadMode = 'server' | 'p2p'

export interface PendingUpload {
  file: File
  spoiler: boolean
  mode: UploadMode
  scope: string
  // P2P only: 'auto' or the URL of one of the user's TURN relays (see relays.ts).
  relay?: string
  // "Describe this image", as typed.
  alt?: string
}

// Where an upload for the view `key` will be posted, so the server can store it encrypted from
// its first byte when that place stores its messages encrypted: `c:<channel id>` (a thread
// posts in its channel, which `threadChannel` gives for its root) or `d:<dm id>`; null for
// anything else.
export function uploadPlace(
  key: string | null,
  threadChannel: (root: number) => number | null = () => null
): string | null {
  if (!key) return null
  const id = Number(key.slice(1))
  if (!/^[cdt][1-9][0-9]*$/.test(key) || !Number.isSafeInteger(id)) return null
  if (key[0] === 'c') return `c:${id}`
  if (key[0] === 'd') return `d:${id}`
  const channel = threadChannel(id)
  return channel === null ? null : `c:${channel}`
}

// The server refuses a P2P id that is already another user's attachment (or a server file).
export const p2pIdTaken = (e: unknown) =>
  e instanceof ApiError && e.status === 400 && e.message === 'Invalid p2p_id'

// Which attachment modes the server takes now; none means text only.
export const attachModes = (s: SiteSettings): UploadMode[] => [
  ...(s.asset_uploads ? (['server'] as const) : []),
  ...(s.p2p_attachments ? (['p2p'] as const) : []),
]

// The mode a new attachment starts in: a server upload when allowed and small enough, else P2P.
export const startMode = (s: SiteSettings, size: number, max: number): UploadMode | null => {
  const modes = attachModes(s)
  if (modes.includes('server') && (size <= max || !modes.includes('p2p'))) return 'server'
  return modes.includes('p2p') ? 'p2p' : null
}
