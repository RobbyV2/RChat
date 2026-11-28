'use client'

import { memo, useMemo } from 'react'
import { useLive } from '../lib/place/react'
import type { Live } from '../lib/place/live'
import type { RowsState } from '../lib/place/rows'
import type { Message } from '../lib/types'
import { usePeerTimeoutEnds } from './timeout_dialog'
import { isSystem } from '../lib/system_messages'
import { CallRow } from './call_row'
import { MessageRow, RemovedRow, SlowHiddenRow, type RowProps } from './message_row'
import { PinNotice } from './pins'
import { SystemNotice } from './system_messages'
import { UnreadDivider } from './unread_banner'

const unreadDivider = <UnreadDivider />

// What the rows of a list may do right now: `of(m)` gives a row's flags (`root`: the row heads
// the open thread), following the reader's timeout as it runs out.
export function useRowFlags(rows: Live<RowsState>) {
  const state = useLive(rows)
  const timedOut = usePeerTimeoutEnds(state.until ?? undefined) !== null
  return useMemo(
    () => ({
      acts: state.acts,
      timedOut,
      of: (m: Message, root = false) => state.of(m, { timedOut, root }),
    }),
    [state, timedOut]
  )
}

// One row of a message list, whichever place it is in: the line its kind calls for (a pin, a
// join or leave, a call, a message hidden from the reader), else the message.
export const ListedRow = memo(function ListedRow(
  props: RowProps & {
    // Why the message does not show: its author was removed around then, or slow mode hides it.
    hidden?: 'removed' | 'slow'
    // The pinned message's key in the place, on a pin's line; null once it is gone.
    pinned?: string | null
  }
) {
  const { m, event, server, divider, on, hidden, pinned = null, local = false } = props
  if (hidden === 'removed') return <RemovedRow m={m} divider={divider} />
  if (hidden === 'slow') return <SlowHiddenRow m={m} divider={divider} />
  const mark = divider && unreadDivider
  if (m.kind === 'pin')
    return <PinNotice m={m} event={event} target={pinned} divider={mark} onMenu={on.menu} />
  if (isSystem(m))
    return (
      <SystemNotice
        m={m}
        server={server}
        divider={mark}
        local={local}
        onMenu={local ? undefined : on.menu}
      />
    )
  if (m.kind === 'call') return <CallRow m={m} event={event} divider={mark} />
  return <MessageRow {...props} />
})
