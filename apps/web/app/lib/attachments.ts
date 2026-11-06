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
}

// Servers before 0.3.0 send no p2p_attachments: P2P was always on there.
export const siteSettings = (s: SiteSettings): SiteSettings => ({
  ...s,
  p2p_attachments: s.p2p_attachments !== false,
})

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
