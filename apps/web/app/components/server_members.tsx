'use client'
import { ask, asked, known } from '../lib/asks'
import { Loaded, More, Refreshed, useAccountPages, useAccountRequest } from './loaded'

import { useMemo, useState, type ReactNode } from 'react'
import { useAccount } from '../lib/client/react'
import { openActionMenu } from '../lib/actions/menu'
import { roleColor, useStore } from '../lib/store'
import { memberState } from '../lib/selectors'
import { NO_FILTERS, allowedFilters, hostedQuery, type MemberFilters } from '../lib/member_filters'
import { Perm, hasPerm, type MemberHit, type Role, type ServerPassword } from '../lib/types'
import { UserAvatar } from './user_avatar'
import { Badge } from './profile_card'
import { MemberName, MemberTimeout } from './member_sidebar'
import { passwordName } from './server_access'
import { useShownMembers } from './shown_user'
import { MemberFilterBar, MemberTable, MemberTableRow } from './member_table'
import { Stack } from './layout'

// Server settings' members of a hosted server: the search route with filters, for members who
// may kick, time out or handle roles.

const SEARCH_DEBOUNCE = 250

export { MEMBER_SEARCH_PERMS } from '../lib/member_filters'

// The members a filter finds, a page at a time, asked for after a pause while the filter changes.
// Each page is noted in the store, so rows follow kicks, roles and timeouts.
function useHostedSearch(server: string, query: string) {
  const { store } = useAccount()
  const rememberMember = useStore(s => s.rememberMember)
  const [found] = useAccountPages(
    (cursor, signal) =>
      asked(ask.searchMembers(server, query, cursor, signal), page => {
        for (const m of page.items) rememberMember(server, m.username, m)
        store.menu.noteMemberTimeouts(server, page.items)
        return page
      }),
    hit => hit.username,
    [server, query, store, rememberMember],
    { delayMs: SEARCH_DEBOUNCE }
  )
  return found
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
      avatar={<UserAvatar person={shown} size={28} />}
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

const NO_PASSWORDS: ServerPassword[] = []

export function HostedMembers({
  server,
  roles,
  perms,
}: {
  server: string
  roles: Role[]
  perms: number
}) {
  const invites = hasPerm(perms, Perm.ManageInvites)
  const load = useAccountRequest(
    () =>
      invites ? asked(ask.listPasswords(server), found => found.passwords) : known(NO_PASSWORDS),
    [server, invites]
  )
  return (
    <Refreshed load={load} known={NO_PASSWORDS} what="the invites to filter by">
      {(passwords, notice) => (
        <MemberSearch
          server={server}
          roles={roles}
          invites={invites}
          passwords={passwords}
          notice={notice}
        />
      )}
    </Refreshed>
  )
}

function MemberSearch({
  server,
  roles,
  invites,
  passwords,
  notice,
}: {
  server: string
  roles: Role[]
  invites: boolean
  passwords: ServerPassword[]
  notice: ReactNode
}) {
  const [filters, setFilters] = useState<MemberFilters>(NO_FILTERS)
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
    <Stack data-hosted-members gap="sm">
      <MemberFilterBar value={shown} onChange={setFilters} choices={choices} />
      {notice}
      <Loaded load={found} what="members" empty="No matching members.">
        {members => (
          <Stack gap="none">
            <MemberTable created label="Members">
              {members.items.map(hit => (
                <HitRow key={hit.username} server={server} hit={hit} roles={roles} />
              ))}
            </MemberTable>
            <More pages={members} auto />
          </Stack>
        )}
      </Loaded>
    </Stack>
  )
}
