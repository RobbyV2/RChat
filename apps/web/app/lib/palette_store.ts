import { create } from 'zustand'
import { ctxFor } from './actions/ctx'
import { paletteRow } from './actions/palette'
import { actionById, guardAction } from './actions/registry'
import { askable } from './actions/steps'
import type { Target } from './actions/types'
import { home, writeLocal } from './instances'
import {
  EMPTY_PALETTE,
  noteUse,
  palettePrefsKey,
  paletteValue,
  parsePalette,
  type IndexMode,
  type PaletteItem,
  type PalettePrefs,
} from './palette'
import type { PollTarget } from './polls_store'
import { useStore } from './store'

// The palette's open state and its per-account prefs (usage counts, index mode).
export type PaletteView =
  | { kind: 'list' }
  // A command waiting for its argument.
  | { kind: 'arg'; item: PaletteItem }
  // An API operation in the console, by operation id, with saved values to start from.
  | { kind: 'api'; op: string; values?: unknown }

interface PaletteUi {
  open: boolean
  text: string
  view: PaletteView
  owner: string | null
  prefs: PalettePrefs
  // "Create poll" from the palette opens the poll dialog here.
  poll: PollTarget | null
}

export const usePaletteUi = create<PaletteUi>(() => ({
  open: false,
  text: '',
  view: { kind: 'list' },
  owner: null,
  prefs: EMPTY_PALETTE,
  poll: null,
}))

const read = (owner: string | null): PalettePrefs => {
  try {
    return parsePalette(localStorage.getItem(home.scoped(palettePrefsKey(owner))))
  } catch {
    return EMPTY_PALETTE
  }
}

const save = (prefs: PalettePrefs) => {
  const { owner } = usePaletteUi.getState()
  usePaletteUi.setState({ prefs })
  writeLocal(home.scoped(palettePrefsKey(owner)), paletteValue(prefs))
}

export const loadPalettePrefs = (owner: string | null) =>
  usePaletteUi.setState({ owner, prefs: read(owner) })

export const reloadPalettePrefs = () => loadPalettePrefs(usePaletteUi.getState().owner)

export const openPalette = (text = '') =>
  usePaletteUi.setState({ open: true, text, view: { kind: 'list' } })

export const closePalette = () =>
  usePaletteUi.setState({ open: false, text: '', view: { kind: 'list' } })

// Opens the palette at the action's argument for `target`.
export const openPaletteAt = (id: string, target: Target) => {
  const a = actionById(id)
  const ctx = ctxFor(useStore.getState(), target, 'palette')
  const item = a ? guardAction(a, () => (askable(a, ctx) ? paletteRow(a, ctx) : null), null) : null
  if (item)
    usePaletteUi.setState({
      open: true,
      text: '',
      view: item.arg ? { kind: 'arg', item } : { kind: 'list' },
    })
}

export const togglePalette = () => (usePaletteUi.getState().open ? closePalette() : openPalette())

export const setPaletteText = (text: string) => usePaletteUi.setState({ text })

export const setPaletteView = (view: PaletteView) => usePaletteUi.setState({ view })

export const noteUsed = (id: string, now = Date.now()) =>
  save(noteUse(usePaletteUi.getState().prefs, id, now))

export const clearUsage = () => save({ ...usePaletteUi.getState().prefs, used: {} })

export const setIndexMode = (index: IndexMode) => save({ ...usePaletteUi.getState().prefs, index })

export const openPollFromPalette = (target: PollTarget) =>
  usePaletteUi.setState({ open: false, text: '', view: { kind: 'list' }, poll: target })

export const closePalettePoll = () => usePaletteUi.setState({ poll: null })

// Something inside the palette (the API console's confirm) that Escape closes first.
let escapeHolder: (() => void) | null = null

export const holdEscape = (cancel: () => void) => {
  escapeHolder = cancel
  return () => {
    if (escapeHolder === cancel) escapeHolder = null
  }
}

// Runs and drops the held Escape action; false when there is none.
export const takeEscape = () => {
  const cancel = escapeHolder
  escapeHolder = null
  cancel?.()
  return cancel !== null
}
