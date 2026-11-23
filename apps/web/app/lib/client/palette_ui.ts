import { createStore } from 'zustand/vanilla'
import type { PaletteUi } from '../palette_store'
import type { PollTarget } from '../polls_store'
import type { AccountSession } from './session'

export function createPaletteControls() {
  const store = createStore<Pick<PaletteUi, 'open' | 'text' | 'view' | 'poll' | 'actor'>>(() => ({
    actor: null,
    open: false,
    text: '',
    view: { kind: 'list' },
    poll: null,
  }))

  // Something inside the palette (the API console's confirm) that Escape closes first.
  let escapeHolder: (() => void) | null = null

  const holdEscape = (cancel: () => void) => {
    escapeHolder = cancel
    return () => {
      if (escapeHolder === cancel) escapeHolder = null
    }
  }

  // Runs and drops the held Escape action; false when there is none.
  const takeEscape = () => {
    const cancel = escapeHolder
    escapeHolder = null
    cancel?.()
    return cancel !== null
  }

  let nextPoll = 0
  const openPoll = (target: PollTarget, actor: AccountSession) =>
    store.setState({
      actor: null,
      open: false,
      text: '',
      view: { kind: 'list' },
      poll: { actor, target, key: ++nextPoll },
    })

  return { store, holdEscape, takeEscape, openPoll }
}
