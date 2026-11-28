import { canRetry, missing, refusalOf, statusOf, type Refusal } from './api_errors'
import type { Time } from './clock'

// The loads the store makes on its own: after a resync, on an event, when a place opens. One
// that is refused is kept here by what it was loading, and the screen that shows the thing draws
// the refusal with a way to ask again.
export type OwnLoad =
  | 'account'
  | 'bulk_jobs'
  | 'friend_summary'
  | 'friends_seen'
  | 'p2p_badge'
  | 'read_marks'
  | 'scheduled_counts'
  | 'unread_counts'
  | `members:${string}`
  | `scheduled:${string}`

export type RefusedLoads = Partial<Record<OwnLoad, Refusal>>

export const ownLoadsInitial = () => ({ refusedLoads: {} as RefusedLoads })

interface Holder {
  refusedLoads: RefusedLoads
}

// The record of the load of `what`: `came` once it answers, `refused` with what it threw. An
// instance that does not have the thing (it answers 404) leaves nothing to show.
export const ownLoad = <S extends Holder>(
  set: (change: (state: S) => Partial<S>) => void,
  what: OwnLoad
) => {
  const came = () =>
    set(s => {
      if (!(what in s.refusedLoads)) return {}
      const { [what]: _gone, ...rest } = s.refusedLoads
      return { refusedLoads: rest } as Partial<S>
    })
  return {
    came,
    refused: (error: unknown) => {
      if (missing(error)) return came()
      set(s => ({ refusedLoads: { ...s.refusedLoads, [what]: refusalOf(error) } }) as Partial<S>)
    },
  }
}

// The same record for work the store does on its own account after trying it quietly (a mark,
// a refresh): a failure with no answer from the instance is left to the connection state the app
// already shows.
export const ownWork = <S extends Holder>(
  set: (change: (state: S) => Partial<S>) => void,
  what: OwnLoad
) => {
  const record = ownLoad(set, what)
  return {
    came: record.came,
    refused: (error: unknown) => {
      if (refusalOf(error).kind !== 'offline') record.refused(error)
    },
  }
}

export interface Persistence {
  // How many times the work is tried in all.
  tries?: number
  // The wait before the second try; each later wait is twice the one before.
  firstMs?: number
  // Whether the work still matters (its session is the same, its screen is open).
  live?: () => boolean
}

// Work nobody is waiting on, tried again on its own after a failure that can pass: quietly, a
// few times, further apart each time. The promise is refused with the last failure, which is
// the one worth showing.
export const persistently = async <T>(
  time: Time,
  run: () => Promise<T>,
  { tries = 3, firstMs = 2000, live = () => true }: Persistence = {}
): Promise<T> => {
  for (let n = 1; ; n++) {
    try {
      return await run()
    } catch (error) {
      if (n >= tries || !live() || !canRetry(refusalOf(error))) throw error
      await new Promise<void>(done => time.after(firstMs * 2 ** (n - 1), done))
      if (!live()) throw error
    }
  }
}

export const SESSION_LEFT_OPEN =
  'Could not end your session at the instance. It stays open there until it expires. Log in and log out again to end it.'

const alreadyEnded = (error: unknown) => {
  const status = statusOf(error)
  return status === 401 || status === 404
}

// Ends a session at its instance on the way out. The promise settles with the first try: its
// answer, or nothing when it failed. After a failure the session is ended again quietly, and
// when that fails too `tell` hears the line for the person: the session then stays open at the
// instance.
export const revokeOnLeaving = <T>(
  time: Time,
  revoke: () => Promise<T>,
  tell: (line: string) => void
): Promise<T | undefined> =>
  revoke().catch((first: unknown) => {
    if (alreadyEnded(first)) return undefined
    time.after(2000, () => {
      persistently(time, revoke, { tries: 2, firstMs: 4000 }).catch((last: unknown) => {
        if (!alreadyEnded(last)) tell(SESSION_LEFT_OPEN)
      })
    })
    return undefined
  })
