import { create } from 'zustand'
import { accountBoundStore } from './client/react'
import type { ChannelKind } from './types'

// The sidebar's inline channel name field: a new channel (in a category or none) or a rename.
export type Editing =
  | {
      mode: 'create'
      server: string
      kind: ChannelKind
      category: number | null
      textOnly?: boolean
    }
  | { mode: 'rename'; server: string; id: number }

interface ChannelEdit {
  editing: Editing | null
  name: string
  start(next: Editing, initial: string): void
  setName(name: string): void
  setKind(kind: ChannelKind): void
  setTextOnly(enabled: boolean): void
  stop(): void
}

export const createChannelEdit = () =>
  create<ChannelEdit>(set => ({
    editing: null,
    name: '',
    start: (editing, name) => set({ editing, name }),
    setName: name => set({ name }),
    setKind: kind =>
      set(s => (s.editing?.mode === 'create' ? { editing: { ...s.editing, kind } } : {})),
    setTextOnly: enabled =>
      set(s =>
        s.editing?.mode === 'create' ? { editing: { ...s.editing, textOnly: enabled } } : {}
      ),
    stop: () => set({ editing: null, name: '' }),
  }))

export const useChannelEdit = accountBoundStore<ChannelEdit>(acct => acct.channelEdit)
