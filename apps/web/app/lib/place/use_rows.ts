'use client'

import { useAccount } from '../client/react'
import type { ComposerList } from './composer'
import { featureAt, isUnsupported } from './feature'
import type { Live } from './live'
import type { Place } from './place'
import { useFeature } from './react'
import { accountRows, rows, type RowsState } from './rows'

// The rows of `list` in the place around the component, or the account's with no place open.
export function useRows(list: ComposerList): Live<RowsState> {
  const account = useAccount()
  const here = useFeature(rows)
  return (isUnsupported(here) ? accountRows(account) : here).at(list)
}

// The rows of `list` in `place`.
export const rowsAt = (place: Place, list: ComposerList): Live<RowsState> => {
  const here = featureAt(rows, place)
  return (isUnsupported(here) ? accountRows(place.account) : here).at(list)
}
