'use client'

import { useAccount } from '../client/react'
import { featureAt, isUnsupported } from './feature'
import type { Place } from './place'
import { useFeature } from './react'
import { accountThread, thread, type OpenThread } from './thread'

// The open thread of the place around the component, or the account's with no place open.
export function useThread(): OpenThread {
  const account = useAccount()
  const here = useFeature(thread)
  return isUnsupported(here) ? accountThread(account) : here
}

// The open thread of `place`.
export const openThreadAt = (place: Place): OpenThread => {
  const here = featureAt(thread, place)
  return isUnsupported(here) ? accountThread(place.account) : here
}
