import { create } from 'zustand'

// The command palette registers here when it exists. Until then nothing offers to open it.
interface PaletteState {
  open: (() => void) | null
}

export const usePalette = create<PaletteState>(() => ({ open: null }))

export const registerPalette = (open: (() => void) | null) => usePalette.setState({ open })

export const usePaletteAvailable = () => usePalette(s => s.open !== null)

export const paletteShortcut = (mac: boolean) => (mac ? '⌘K' : 'Ctrl+K')

export const isMac = () =>
  typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')
