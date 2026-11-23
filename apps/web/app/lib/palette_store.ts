import { create } from 'zustand'
import { ctxFor } from './actions/ctx'
import { paletteRow } from './actions/palette'
import { actionById, guardAction } from './actions/registry'
import { askable } from './actions/steps'
import type { Target } from './actions/types'
import { readLocal, writeLocal } from './instances'
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
import { client } from './client/client'
import type { AccountSession } from './client/session'
import { accountBoundStore } from './client/react'

// The palette's open state and its per-account prefs (usage counts, index mode).
export type PaletteView =
  | { kind: 'list' }
  // A command waiting for its argument.
  | { kind: 'arg'; item: PaletteItem }
  // An API operation in the console, by operation id, with saved values to start from.
  | { kind: 'api'; op: string; values?: unknown }

export interface PaletteUi {
  actor: AccountSession | null
  open: boolean
  text: string
  view: PaletteView
  owner: string | null
  prefs: PalettePrefs
  // "Create poll" from the palette opens the poll dialog here.
  poll: { actor: AccountSession; target: PollTarget; key: number } | null
}

const emptyPrefs = (): PalettePrefs => ({ ...EMPTY_PALETTE, used: {} })

export function createPalettePrefs(acct: AccountSession) {
  const home = acct.conn
  const usePaletteUi = create<PaletteUi>(() => ({
    ...client.palette.store.getState(),
    owner: null,
    prefs: emptyPrefs(),
  }))
  const off = client.palette.store.subscribe(next => usePaletteUi.setState(next))
  const mirror = usePaletteUi.subscribe(state => {
    const { actor, open, text, view, poll } = state
    const current = client.palette.store.getState()
    if (
      actor !== current.actor ||
      open !== current.open ||
      text !== current.text ||
      view !== current.view ||
      poll !== current.poll
    )
      client.palette.store.setState({ actor, open, text, view, poll })
  })
  // Close only overlays opened by the identity that just left this session.
  let origin = home.origin
  const closeOwned = () => {
    const { actor, poll } = client.palette.store.getState()
    if (actor === acct) closePalette()
    if (poll?.actor === acct) closePalettePoll(poll)
  }
  const offOwner = acct.store.subscribe((state, previous) => {
    if (
      origin !== home.origin ||
      state.me?.username !== previous.me?.username ||
      state.guest !== previous.guest
    ) {
      origin = home.origin
      closeOwned()
    }
  })
  const read = (owner: string | null): PalettePrefs => {
    try {
      const prefs = parsePalette(readLocal(home.scoped(palettePrefsKey(owner))))
      return prefs === EMPTY_PALETTE ? emptyPrefs() : prefs
    } catch {
      return emptyPrefs()
    }
  }

  const save = (prefs: PalettePrefs) => {
    const { owner } = usePaletteUi.getState()
    usePaletteUi.setState({ prefs })
    writeLocal(home.scoped(palettePrefsKey(owner)), paletteValue(prefs))
  }

  const loadPalettePrefs = (owner: string | null) =>
    usePaletteUi.setState({ owner, prefs: read(owner) })

  const reloadPalettePrefs = () => loadPalettePrefs(usePaletteUi.getState().owner)

  const noteUsed = (id: string, now = Date.now()) =>
    save(noteUse(usePaletteUi.getState().prefs, id, now))

  const clearUsage = () => save({ ...usePaletteUi.getState().prefs, used: {} })

  const setIndexMode = (index: IndexMode) => save({ ...usePaletteUi.getState().prefs, index })

  return {
    usePaletteUi,
    loadPalettePrefs,
    reloadPalettePrefs,
    noteUsed,
    clearUsage,
    setIndexMode,
    dispose() {
      offOwner()
      closeOwned()
      off()
      mirror()
    },
  }
}
export const usePaletteUi = accountBoundStore<PaletteUi>(acct => acct.palettePrefs.usePaletteUi)
export const loadPalettePrefs = (owner: string | null) =>
  client.shown().palettePrefs.loadPalettePrefs(owner)
export const reloadPalettePrefs = () => client.shown().palettePrefs.reloadPalettePrefs()
export const noteUsed = (id: string, now?: number) => client.shown().palettePrefs.noteUsed(id, now)
export const clearUsage = () => client.shown().palettePrefs.clearUsage()
export const setIndexMode = (mode: IndexMode) => client.shown().palettePrefs.setIndexMode(mode)
export const openPalette = (text = '', acct = client.shown()) =>
  client.palette.store.setState({ actor: acct, open: true, text, view: { kind: 'list' } })

export const closePalette = () =>
  client.palette.store.setState({ actor: null, open: false, text: '', view: { kind: 'list' } })

// Opens the palette at the action's argument for `target`.
export const openPaletteAt = (id: string, target: Target, acct = client.shown()) => {
  const a = actionById(id)
  const ctx = ctxFor(acct.store.getState(), target, 'palette', acct)
  const item = a ? guardAction(a, () => (askable(a, ctx) ? paletteRow(a, ctx) : null), null) : null
  if (item)
    client.palette.store.setState({
      actor: acct,
      open: true,
      text: '',
      view: item.arg ? { kind: 'arg', item } : { kind: 'list' },
    })
}

export const togglePalette = (acct = client.shown()) =>
  client.palette.store.getState().open ? closePalette() : openPalette('', acct)

export const setPaletteText = (text: string) => client.palette.store.setState({ text })

export const setPaletteView = (view: PaletteView) => client.palette.store.setState({ view })

export const openPollFromPalette = (target: PollTarget, acct = client.shown()) =>
  client.palette.openPoll(target, acct)

export const closePalettePoll = (poll = client.palette.store.getState().poll) => {
  if (poll && client.palette.store.getState().poll === poll)
    client.palette.store.setState({ poll: null })
}

export const holdEscape = (cancel: () => void) => client.palette.holdEscape(cancel)
export const takeEscape = () => client.palette.takeEscape()
