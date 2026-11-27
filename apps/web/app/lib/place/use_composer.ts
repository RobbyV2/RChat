'use client'

import { useAccount } from '../client/react'
import { accountComposer, composer, type Compose, type ComposerList } from './composer'
import { isUnsupported } from './feature'
import { useFeature } from './react'

// The composer of `list` in the place around the component, or the account's with no place open.
export function useCompose(list: ComposerList): Compose {
  const account = useAccount()
  const here = useFeature(composer)
  return (isUnsupported(here) ? accountComposer(account) : here).at(list)
}
