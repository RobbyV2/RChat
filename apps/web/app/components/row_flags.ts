'use client'

import { useMemo } from 'react'
import type { Live } from '../lib/place/live'
import { useLive } from '../lib/place/react'
import type { RowsState } from '../lib/place/rows'
import type { Message } from '../lib/types'
import { usePeerTimeoutEnds } from './timeout_dialog'

// What the rows of a list may do right now: `of(m)` gives a row's flags (`root`: the row heads
// the open thread), following the reader's timeout as it runs out.
export function useRowFlags(rows: Live<RowsState>) {
  const state = useLive(rows)
  const timedOut = usePeerTimeoutEnds(state.until ?? undefined) !== null
  return useMemo(
    () => ({
      acts: state.acts,
      timedOut,
      // Whether the reader may change the list's pins now.
      mayPin: state.pins && !timedOut,
      of: (m: Message, root = false) => state.of(m, { timedOut, root }),
    }),
    [state, timedOut]
  )
}
