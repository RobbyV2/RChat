import { missing, refusalOf, type Refusal } from './api_errors'

// The loads the store makes on its own: after a resync, on an event, when a place opens. One
// that is refused is kept here by what it was loading, and the screen that shows the thing draws
// the refusal with a way to ask again.
export type OwnLoad = 'bulk_jobs' | 'friend_summary' | 'scheduled_counts' | `scheduled:${string}`

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
