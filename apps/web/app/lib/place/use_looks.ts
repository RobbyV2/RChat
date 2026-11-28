'use client'

import { useAccount } from '../client/react'
import type { Message, UserRef } from '../types'
import { isUnsupported } from './feature'
import { accountLooks, looks, type Face, type Looks } from './looks'
import { useFeature, useWatch } from './react'

// The looks of the place around a component; outside any place, the account's own.
export function useLooks(): Looks {
  const account = useAccount()
  const here = useFeature(looks)
  return isUnsupported(here) ? accountLooks(account) : here
}

// The author of `m` as the place around the component draws them.
export function useAuthor(m: Message, event?: string): Face {
  const here = useLooks()
  return useWatch(() => here.author(m, event), [here, m.author, event])
}

// `user` as the place around the component draws them.
export function useFace(user: UserRef): Face {
  const here = useLooks()
  return useWatch(() => here.of(user), [here, user])
}

// The color the place gives the name of `user`; none for nobody.
export function useNameColor(user: UserRef | null | undefined): string | undefined {
  const here = useLooks()
  return useWatch(() => (user ? here.color(user) : NOBODY), [here, user])
}

const NOBODY = { get: () => undefined, subscribe: () => () => {} }
