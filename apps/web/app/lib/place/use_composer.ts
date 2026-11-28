'use client'

import { useAccount } from '../client/react'
import { accountComposer, composer, type Compose, type ComposerList } from './composer'
import { featureAt, isUnsupported } from './feature'
import type { Place } from './place'
import { useFeature } from './react'

// The composer of `list` in the place around the component, or the account's with no place open.
export function useCompose(list: ComposerList): Compose {
  const account = useAccount()
  const here = useFeature(composer)
  return (isUnsupported(here) ? accountComposer(account) : here).at(list)
}

// The composer of `list` in `place`.
export const composeAt = (place: Place, list: ComposerList): Compose => {
  const here = featureAt(composer, place)
  return (isUnsupported(here) ? accountComposer(place.account) : here).at(list)
}
