import { create } from 'zustand'
import type { ChannelKind } from './types'

// The sidebar's inline channel name field: a new channel (in a category or none) or a rename.
export type Editing =
  | { mode: 'create'; server: string; kind: ChannelKind; category: number | null }
  | { mode: 'rename'; server: string; id: number }

interface ChannelEdit {
  editing: Editing | null
  name: string
  start(next: Editing, initial: string): void
  setName(name: string): void
  setKind(kind: ChannelKind): void
  stop(): void
}

export const useChannelEdit = create<ChannelEdit>(set => ({
  editing: null,
  name: '',
  start: (editing, name) => set({ editing, name }),
  setName: name => set({ name }),
  setKind: kind =>
    set(s => (s.editing?.mode === 'create' ? { editing: { ...s.editing, kind } } : {})),
  stop: () => set({ editing: null, name: '' }),
}))
