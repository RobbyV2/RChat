import type { Local } from './limits'

// Jumping to a message, in a conversation or a channel: up to `jumpBefore` messages before it,
// the message and the next `jumpAfter` ones (limits.ts `misc`), oldest first. `more`: older ones
// are stored; `newer`: more follow the last one loaded, so the view marks the gap and loads them
// on request.
export type JumpLimits = Pick<Local['misc'], 'jumpBefore' | 'jumpAfter'>

export interface PageOpts {
  // Exclusive bounds, and an inclusive lower one.
  before?: string
  after?: string
  from?: string
  limit?: number
  // Walk forward from the lower bound: `more` then means newer ones follow.
  newer?: boolean
}

export const around = async <M>(
  key: string,
  self: () => Promise<M[]>,
  page: (o: PageOpts) => Promise<{ messages: M[]; more: boolean }>,
  lim: JumpLimits
) => {
  const older = await page({ before: key, limit: lim.jumpBefore })
  const later = await page({ after: key, limit: lim.jumpAfter, newer: true })
  return {
    messages: [...older.messages, ...(await self()), ...later.messages],
    more: older.more,
    newer: later.more,
  }
}
