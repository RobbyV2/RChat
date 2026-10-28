import type { Message } from './types'

export const PINS_TITLE = 'Pinned Messages'

// Only top-level user messages take pins (the server checks the same).
export const canPin = (m: Message) => m.kind === 'user' && m.thread_root_id === null && m.id > 0

export const isPinned = (m: Message) => typeof m.pinned_at === 'number'

export const withPinnedAt = (m: Message, at: number | null): Message =>
  (m.pinned_at ?? null) === at ? m : { ...m, pinned_at: at }

// A deleted message takes its pin with it: notices about it stop linking to it.
export const unlinkPin = (list: Message[], id: number) =>
  list.some(m => m.pin_message_id === id)
    ? list.map(m => (m.pin_message_id === id ? { ...m, pin_message_id: null } : m))
    : list

export const withoutPin = (list: Message[], id: number) =>
  list.some(m => m.id === id) ? list.filter(m => m.id !== id) : list

export const pinPlace = (key: string) => (key.startsWith('d') ? 'conversation' : 'channel')

export const noPinsText = (key: string) =>
  `This ${pinPlace(key)} doesn't have any pinned messages yet.`
