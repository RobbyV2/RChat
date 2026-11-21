'use client'

import { create } from 'zustand'

// Counts the account changes the admin page made, so an open account page reads its account
// again after one.
export const useAccountChanges = create<{ rev: number; changed: () => void }>(set => ({
  rev: 0,
  changed: () => set(s => ({ rev: s.rev + 1 })),
}))
