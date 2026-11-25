'use client'

import { useEffect, useMemo } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { lookIn, lookOf, shownParts, shownUser } from '../lib/server_profile'
import { useStore } from '../lib/store'
import type { MemberLook, UserRef } from '../lib/types'
import { NameWithUsername } from './display_name'
import { UserAvatar } from './user_avatar'

// The hosted server whose channel is open; null in a DM and outside servers.
export const useViewServer = () =>
  useStore(s => (s.view?.kind === 'channel' ? s.view.server : null))

// The look someone set for a hosted server, as the server shows it now; null outside a server
// and until their member row is loaded.
export function useLook(server: string | null | undefined, username: string): MemberLook | null {
  return useStore(useShallow(s => (server ? lookOf(s, { server }, username) : null)))
}

// `user` as `server` shows them: the server name and avatar over the account's. Every place
// that draws an author or a member of a server goes through here (or `shownUser`).
export function useShown<T extends UserRef>(user: T, server: string | null | undefined): T {
  const look = useLook(server, user.username)
  return useMemo(() => shownUser(user, look), [user, look])
}

// The same for someone who may be missing (a deleted author).
export function useShownOrNull<T extends UserRef>(
  user: T | null | undefined,
  server: string | null | undefined
): T | null {
  const look = useLook(user ? server : null, user?.username ?? '')
  return useMemo(() => (user ? shownUser(user, look) : null), [user, look])
}

// Turns member rows that carry their own look into the people a server shows.
export function useShownMembers(server: string | null | undefined) {
  const parts = useStore(useShallow(s => (server ? shownParts(s, server) : null)))
  return useMemo(
    () =>
      <T extends UserRef & { profile?: MemberLook }>(m: T): T =>
        parts && m.profile ? shownUser(m, lookIn(m.profile, parts)) : m,
    [parts]
  )
}

// Asks for the member rows of people a server view names, so their looks can show.
export function useLooksFor(server: string | null | undefined, usernames: readonly string[]) {
  const ensureMembers = useStore(s => s.ensureMembers)
  const key = usernames.join('\n')
  useEffect(() => {
    if (server && key) void ensureMembers(server, key.split('\n'))
  }, [server, key, ensureMembers])
}

export function ShownName({
  user,
  server,
  own,
  fit,
}: {
  user: UserRef
  server: string | null | undefined
  own?: boolean
  fit?: boolean
}) {
  return <NameWithUsername user={useShown(user, server)} own={own} fit={fit} />
}

export function ShownAvatar({
  user,
  server,
  size,
}: {
  user: UserRef
  server: string | null | undefined
  size: number
}) {
  const shown = useShown(user, server)
  return (
    <UserAvatar
      username={shown.username}
      avatarKind={shown.avatar_kind}
      avatarColor={shown.avatar_color}
      size={size}
    />
  )
}
