'use client'

import { useEffect, useMemo } from 'react'
import { useAccount } from '../client/react'
import { mentionLookups } from '../mentions'
import type { Message, UserRef } from '../types'
import { isUnsupported } from './feature'
import { accountLooks, looks, type Face, type Looks } from './looks'
import { HostedServer } from './place'
import { useFeature, useWatch } from './react'
import { featureAt } from './feature'

// The looks of the place around a component; outside any place, the account's own.
export function useLooks(): Looks {
  const account = useAccount()
  const here = useFeature(looks)
  return isUnsupported(here) ? accountLooks(account) : here
}

// The looks of hosted `server` of the account around a component; with none, the account's own.
export function useServerLooks(server: string | null | undefined): Looks {
  const account = useAccount()
  if (!server) return accountLooks(account)
  const here = featureAt(looks, HostedServer.open(account, server))
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

// Has `here` load the people called `names` while the component shows them.
export function useLoaded(here: Looks, names: readonly string[]) {
  const key = [...new Set(names)].sort().join('\n')
  useEffect(() => (key ? here.load(key.split('\n')) : undefined), [here, key])
}

// Has the place around load the authors of `messages`, everyone they may mention or answer, and
// `extra`, so their names and mention pills show as the place draws them.
export function useLoadedPeople(messages: readonly Message[], extra: readonly string[] = []) {
  const here = useLooks()
  const names = useMemo(
    () =>
      messages.flatMap(m => [
        m.author.username,
        ...(m.content.includes('@') ? mentionLookups(m.content) : []),
        ...(m.reply_to?.author ? [m.reply_to.author.username] : []),
      ]),
    [messages]
  )
  useLoaded(here, [...names, ...extra])
}
