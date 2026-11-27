import { ApiError } from './api'
import type { RChatState } from './store_types'
import type { View } from './view'

// The header a site admin may give a reason in, and its longest text.
export const STAFF_REASON_HEADER = 'X-Staff-Reason'
export const STAFF_REASON_MAX = 512

// How long a confirmed channel stays open.
export const STAFF_VIEW_MINUTES = 15

// The channel a request was refused for until the site admin confirms opening it; null for any
// other answer.
export const staffViewChannel = (e: unknown): number | null => {
  if (!(e instanceof ApiError) || e.status !== 403) return null
  const data = e.data as { reason?: { kind?: unknown; control?: unknown; channel?: unknown } }
  const reason = data?.reason
  return reason?.kind === 'confirm' &&
    reason.control === 'staff_view' &&
    typeof reason.channel === 'number'
    ? reason.channel
    : null
}

// Whether a request was refused until the site admin confirms opening the channel.
export const asksStaffView = (e: unknown): boolean => staffViewChannel(e) !== null

// The reason as its header carries it; null when there is none to send.
export const staffReasonHeader = (reason: string): Record<string, string> | null => {
  const text = Array.from(reason.trim()).slice(0, STAFF_REASON_MAX).join('')
  return text === '' ? null : { [STAFF_REASON_HEADER]: encodeURIComponent(text) }
}

type StaffState = Pick<RChatState, 'me' | 'view' | 'staffAsk' | 'staffShut' | 'staffOpen'>
type StaffPatch = Partial<Pick<RChatState, 'staffAsk' | 'staffShut' | 'staffOpen'>>

const viewing = (view: View | null, channel: number) =>
  view?.kind === 'channel' && view.channelId === channel

// A request about `channel` was refused until the site admin confirms: ask, unless a question
// is up already, and close the viewed channel while it is that one.
export const staffAsked = (s: StaffState, channel: number): StaffPatch => {
  if (!s.me?.is_site_admin) return {}
  const shut = viewing(s.view, channel) ? { staffShut: s.view } : {}
  return s.staffAsk === null ? { staffAsk: channel, ...shut } : shut
}

// The site admin confirmed `channel`: the question is answered and the channel opens.
export const staffOpened = (s: StaffState, channel: number): StaffPatch => ({
  ...(s.staffAsk === channel ? { staffAsk: null } : {}),
  ...(s.staffShut?.kind === 'channel' && s.staffShut.channelId === channel
    ? { staffShut: null }
    : {}),
  staffOpen: s.staffOpen.includes(channel) ? s.staffOpen : [...s.staffOpen, channel],
})

// The confirmation of `channel` ran out: it closes, and so does the view while it shows it.
export const staffEnded = (s: StaffState, channel: number): StaffPatch => ({
  staffOpen: s.staffOpen.filter(c => c !== channel),
  ...(viewing(s.view, channel) ? { staffShut: s.view } : {}),
})

// What a view of one channel does when the site admin's confirmation of it changes: read the
// channel again once it opens, show it closed once it ends, and nothing otherwise.
export const staffChange = (was: boolean, open: boolean): 'read' | 'close' | null =>
  open === was ? null : open ? 'read' : 'close'
