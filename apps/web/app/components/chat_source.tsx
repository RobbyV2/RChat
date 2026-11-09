'use client'

import { createContext, useContext, type ReactNode } from 'react'
import { useStore } from '../lib/store'
import type { Message, UserRef } from '../lib/types'

// Where the shared message components (reactions, toolbar, mentions, editor) send their
// actions. Instance messages use the store; a P2P conversation provides its own source, so the
// same components render it without knowing where the messages live.
export interface ChatSource {
  toggleReaction: (m: Message, emoji: string, note?: boolean) => void
  loadReactors: (messageId: number, emoji: string) => Promise<UserRef[]>
  openReactPicker: (m: Message, anchor: HTMLElement | null) => void
  // Mention pills: which candidates are people here, and who they are.
  known: (m: Message, candidates: string[]) => string
  user: (username: string) => UserRef
  mine: (username: string) => boolean
  // Your own identity here, as authors and users carry it in `username`.
  self: string
  // Mention autocomplete.
  people: (query: string) => UserRef[]
}

const Source = createContext<ChatSource | null>(null)

export function ChatSourceProvider({
  value,
  children,
}: {
  value: ChatSource
  children: ReactNode
}) {
  return <Source.Provider value={value}>{children}</Source.Provider>
}

// The P2P (or other) source, or null for instance messages.
export const useChatSource = () => useContext(Source)

export function useReactionActions() {
  const src = useChatSource()
  const toggle = useStore(s => s.toggleReaction)
  const load = useStore(s => s.loadReactors)
  const openPicker = useStore(s => s.openReactPicker)
  return src
    ? { toggle: src.toggleReaction, load: src.loadReactors, openPicker: src.openReactPicker }
    : { toggle, load, openPicker }
}
