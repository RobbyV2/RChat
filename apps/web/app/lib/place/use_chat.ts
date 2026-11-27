'use client'

import { useAccount } from '../client/react'
import { accountChat, chat, type Chat } from './chat'
import { isUnsupported } from './feature'
import { useFeature } from './react'

// The chat of the place around a component; outside any place, the account's own.
export function useChat(): Chat {
  const account = useAccount()
  const here = useFeature(chat)
  return isUnsupported(here) ? accountChat(account) : here
}
