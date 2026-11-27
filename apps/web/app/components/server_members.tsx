'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAccount } from '../lib/client/react'
import { openActionMenu } from '../lib/actions/menu'
import { errorText, roleColor, useStore } from '../lib/store'
import { memberState } from '../lib/selectors'
import {
  EMPTY_PAGES,
  NO_FILTERS,
  allowedFilters,
  hostedQuery,
  pageFailed,
  pageLoaded,
  pagesNote,
  type MemberFilters,
  type SearchPages,
} from '../lib/member_filters'
import { searchRetryAfter } from '../lib/search'
import { Perm, hasPerm, type MemberHit, type Role, type ServerPassword } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Badge } from './profile_card'
import { MemberName, MemberTimeout } from './member_sidebar'
import { passwordName } from './server_access'
import { useShownMembers } from './shown_user'
import { MemberFilterBar, MemberTable, MemberTableRow } from './member_table'
import { Button } from './controls'
import { Sentinel } from './ui'

// Server settings' members of a hosted server: the search route with filters, for members who
// may kick, time out or handle roles.

const SEARCH_DEBOUNCE = 250

export { MEMBER_SEARCH_PERMS } from '../lib/member_filters'

function useHostedSearch(server: string, query: string) {
  const {
    api,
    store,
    lifetime: { inSession },
  } = useAccount()
  const setError = useStore(s => s.setError)
  const rememberMember = useStore(s => s.rememberMember)
  const [found, setFound] = useState<SearchPages<MemberHit>>(EMPTY_PAGES)
  const epoch = useRef(0)
  const retry = useRef<ReturnType<typeof setTimeout> | null>(null)
  const fetchFrom = useCallback(
    async function fetchPage(cursor: string | null, mine: number) {
      setFound(f => ({ ...f, loading: true, failed: undefined }))
      try {
        const page = await api.searchMembers(server, query, cursor)
        if (epoch.current !== mine) return
        for (const m of page.items) rememberMember(server, m.username, m)
        store.menu.noteMemberTimeouts(server, page.items)
        setFound(f => pageLoaded(f, cursor, page.items, page.next))
      } catch (e) {
        if (epoch.current !== mine) return
        const wait = searchRetryAfter(e)
        setFound(f => pageFailed(f, cursor, wait))
        if (wait !== null)
          retry.current = setTimeout(() => {
            if (epoch.current === mine) void fetchPage(cursor, mine)
          }, wait * 1000)
        else inSession(setError)(errorText(e))
      }
    },
    [api, store, server, query, rememberMember, setError, inSession]
  )
  useEffect(() => {
    const mine = ++epoch.current
    setFound(EMPTY_PAGES)
    const t = setTimeout(() => void fetchFrom(null, mine), SEARCH_DEBOUNCE)
    return () => {
      clearTimeout(t)
      if (retry.current !== null) clearTimeout(retry.current)
    }
  }, [fetchFrom])
  const more = useCallback(() => {
    if (found.loading || found.next === null || found.failed !== undefined) return
    void fetchFrom(found.next, epoch.current)
  }, [found, fetchFrom])
  const again = useCallback(() => {
    if (found.failed === undefined) return
    void fetchFrom(found.failed, epoch.current)
  }, [found, fetchFrom])
  return { ...found, more, again }
}

function HitRow({ server, hit, roles }: { server: string; hit: MemberHit; roles: Role[] }) {
  const acct = useAccount()
  const live = useStore(s => memberState(s, server, hit.username))
  const shownOf = useShownMembers(server)
  if (live === null) return null
  const m = { ...hit, ...live }
  const shown = shownOf(m)
  const names = roles.filter(r => m.role_ids.includes(r.id)).map(r => r.name)
  const facts = [
    names.join(', '),
    m.joined_via ? `Joined with: ${passwordName(m.joined_via.label)}` : '',
  ]
    .filter(Boolean)
    .join(' · ')
  return (
    <MemberTableRow
      rowKey={m.username}
      avatar={
        <UserAvatar
          username={shown.username}
          avatarKind={shown.avatar_kind}
          avatarColor={shown.avatar_color}
          size={28}
        />
      }
      name={<MemberName user={shown} color={roleColor(roles, m.role_ids)} />}
      badges={
        <>
          <MemberTimeout server={server} username={m.username} />
          {m.is_creator && <Badge tone="tertiary">Creator</Badge>}
          {m.is_admin && <Badge tone="primary">Admin</Badge>}
        </>
      }
      facts={facts || null}
      joinedAt={hit.joined_at}
      createdAt={hit.created_at}
      created
      menu={(x, y) =>
        openActionMenu(x, y, { kind: 'member', user: m, server, where: 'list' }, undefined, acct)
      }
    />
  )
}

export function HostedMembers({
  server,
  roles,
  perms,
}: {
  server: string
  roles: Role[]
  perms: number
}) {
  const { api } = useAccount()
  const invites = hasPerm(perms, Perm.ManageInvites)
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS)
  const [passwords, setPasswords] = useState<ServerPassword[]>([])
  useEffect(() => {
    if (!invites) return
    let live = true
    api.listPasswords(server).then(
      p => live && setPasswords(p.passwords),
      () => {}
    )
    return () => {
      live = false
    }
  }, [api, server, invites])
  const shown = allowedFilters(filters, { created: true, via: invites })
  const found = useHostedSearch(server, hostedQuery(shown))
  const choices = useMemo(
    () => ({
      roles: roles.map(r => ({ id: String(r.id), name: r.name })),
      via: invites
        ? passwords.map(p => ({ id: String(p.id), label: passwordName(p.label) }))
        : null,
      created: true,
    }),
    [roles, passwords, invites]
  )
  return (
    <div data-hosted-members>
      <MemberFilterBar value={shown} onChange={setFilters} choices={choices} />
      <MemberTable created label="Members">
        {found.list.map(hit => (
          <HitRow key={hit.username} server={server} hit={hit} roles={roles} />
        ))}
      </MemberTable>
      {pagesNote(found) && (
        <p
          role="status"
          className="flex flex-wrap items-center gap-2 px-2 text-sm text-on-surface-variant"
        >
          {pagesNote(found)}
          {found.failed !== undefined && <Button onClick={found.again}>Try again</Button>}
        </p>
      )}
      {found.next !== null && !found.loading && found.failed === undefined && (
        <Sentinel key={found.next} onVisible={found.more} />
      )}
    </div>
  )
}
