'use client'

import { useAccount } from '../client/react'
import { featureAt, isUnsupported } from './feature'
import { accountMessages, messages, type Messages } from './messages'
import type { Place } from './place'
import { useFeature } from './react'

// The message list of the place around the component, or the account's with no place open.
export function useMessages(): Messages {
  const account = useAccount()
  const here = useFeature(messages)
  return isUnsupported(here) ? accountMessages(account) : here
}

// The message list of `place`.
export const messagesAt = (place: Place): Messages => {
  const here = featureAt(messages, place)
  return isUnsupported(here) ? accountMessages(place.account) : here
}
