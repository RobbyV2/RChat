import { LOCAL } from './limits'

// Jumping to a message, in a conversation or a channel: up to `before` messages before it, the
// message and the next `after` ones, oldest first. `more`: older ones are stored; `newer`: more
// follow the last one loaded, so the view marks the gap and loads them on request.
export const JUMP = { before: LOCAL.misc.jumpBefore, after: LOCAL.misc.jumpAfter }

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
  page: (o: PageOpts) => Promise<{ messages: M[]; more: boolean }>
) => {
  const older = await page({ before: key, limit: JUMP.before })
  const later = await page({ after: key, limit: JUMP.after, newer: true })
  return {
    messages: [...older.messages, ...(await self()), ...later.messages],
    more: older.more,
    newer: later.more,
  }
}
