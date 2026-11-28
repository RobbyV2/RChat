'use client'
import { ask, asked } from '../../lib/asks'
import { Name, NameInput } from '../name'
import { handleName, personCalled, serverCalled, serverName } from '../../lib/names'
import { asAccount } from '../../lib/people'
import { useAccount } from '../../lib/client/react'
import { useEffect, useState, type ReactNode } from 'react'
import { ACCOUNT_FILTERS, signInLine } from '../../lib/admin_accounts'
import { orMissing } from '../../lib/api_errors'
import { useStore } from '../../lib/store'
import type { AccountFilter, AdminAccount, ServerSummaryLite, UserRef } from '../../lib/types'
import { openActionMenu } from '../../lib/actions/menu'
import { longPress } from '../context_menu'
import { UserAvatar } from '../user_avatar'
import { PageGroup } from '../settings_page'
import { Button, ListRow } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { Chips } from '../ui'
import { useAccountChanges } from './account_state'
import type { Pages } from '../../lib/load'
import {
  Loaded,
  More,
  useAccountPages,
  useAccountSource,
  useRefreshOn,
  useRefreshWhen,
} from '../loaded'
import { time } from '../../lib/platform/time'

function UserServers({ username }: { username: string }) {
  const openServer = useStore(s => s.openServer)
  const openAdmin = useStore(s => s.openAdmin)
  const [load] = useAccountPages(
    cursor => ask.adminUserServers(username, cursor),
    (sv: ServerSummaryLite) => sv.name,
    [username]
  )
  return (
    <Loaded load={load} skeleton={null} empty="No servers created." what="the servers">
      {pages => (
        <>
          {pages.items.map(sv => (
            <Surface key={sv.name} tone="base" radius="lg" pad="md">
              <Row gap="sm" wrap>
                <span className="min-w-24 flex-1 truncate text-sm">
                  <Name of={serverName(sv)} />{' '}
                  <Name
                    of={serverCalled(sv.name)}
                    before="("
                    after=")"
                    look="text-on-surface-variant"
                  />
                </span>
                <Button onClick={() => void openServer(sv.name)}>Open</Button>
                <Button onClick={() => openAdmin('servers', sv.name)}>Manage</Button>
              </Row>
            </Surface>
          ))}
          <More pages={pages} />
        </>
      )}
    </Loaded>
  )
}

// How the account signs in, its sessions, its phrase and its servers.
function AccountFacts({ account }: { account: AdminAccount }) {
  const facts: [string, string][] = [
    ['Created', new Date(account.created_at * 1000).toLocaleDateString()],
    ['Sign-in', signInLine(account, Math.floor(time().now() / 1000))],
    ['Sessions', account.sessions.toLocaleString()],
    ['Backup phrase', account.phrase ? 'Set' : 'None'],
    ['Servers', account.servers.toLocaleString()],
  ]
  return (
    <Surface tone="base" radius="lg" pad="lg">
      <Grid as="dl" cols={{ base: 1, sm: 2 }} gap="sm">
        {facts.map(([label, value]) => (
          <Row key={label} gap="sm" wrap align="baseline">
            <dt className="shrink-0 text-sm text-on-surface-variant">{label}</dt>
            <dd className="min-w-0 text-sm break-words">{value}</dd>
          </Row>
        ))}
      </Grid>
    </Surface>
  )
}

// An account's name and tools. `facts` is how it signs in; `mine` leaves out what an account
// cannot do to itself.
export function AccountBody({
  user,
  mine,
  facts,
}: {
  user: UserRef
  mine: boolean
  facts: ReactNode
}) {
  const openDialog = useStore(s => s.openDialog)
  return (
    <>
      <Row gap="md">
        <UserAvatar person={asAccount(user, 'administration')} size={40} />
        <Stack as="span" gap="none">
          <Name of={personCalled(user.display_name)} look="truncate font-medium" />
          <Name of={handleName(user.username)} look="truncate text-sm text-on-surface-variant" />
        </Stack>
      </Row>
      {facts}
      <Row gap="sm" wrap>
        {!mine && (
          <>
            <Button
              onClick={() => openDialog({ kind: 'new_password_confirm', username: user.username })}
            >
              New temporary password
            </Button>
            <Button
              onClick={() => openDialog({ kind: 'sign_out_confirm', username: user.username })}
            >
              Sign out everywhere
            </Button>
          </>
        )}
        <Button
          onClick={() => openDialog({ kind: 'admin_add_to_server', username: user.username })}
        >
          Add to server
        </Button>
      </Row>
      <div>
        <PageGroup label="Servers they created">
          <UserServers username={user.username} />
        </PageGroup>
        {!mine && (
          <PageGroup label="Danger">
            <Row gap="sm" wrap>
              <Button
                variant="danger"
                onClick={() =>
                  openDialog({ kind: 'remove_phrase_confirm', username: user.username })
                }
              >
                Remove backup phrase
              </Button>
              <Button
                variant="danger"
                onClick={() => openDialog({ kind: 'ban_confirm', username: user.username })}
              >
                Ban site-wide
              </Button>
              <Button
                variant="danger"
                onClick={() => openDialog({ kind: 'delete_user_confirm', username: user.username })}
              >
                Delete account
              </Button>
            </Row>
          </PageGroup>
        )}
      </div>
    </>
  )
}

// One account: how it signs in, the account actions and the servers it created.
export function UserPage({ username }: { username: string }) {
  const openAdmin = useStore(s => s.openAdmin)
  const mine = useStore(s => s.me?.username === username)
  const rev = useAccountChanges(s => s.rev)
  const [load, source] = useAccountSource(
    () => asked(ask.adminAccount(username), found => found as AdminAccount | null, orMissing(null)),
    [username]
  )
  useRefreshWhen(source, rev)
  useRefreshOn(source, { front: true })
  return (
    <Stack gap="lg">
      <Button onClick={() => openAdmin('users')} place="hidden md:inline-flex self-start">
        Back to users
      </Button>
      <Loaded load={load} what="this account">
        {account =>
          account ? (
            <AccountBody
              user={account.user}
              mine={mine}
              facts={<AccountFacts account={account} />}
            />
          ) : (
            <p className="text-sm text-on-surface-variant">No such account.</p>
          )
        }
      </Loaded>
    </Stack>
  )
}

// A page of accounts, each opening its page, and the way to the next one.
export function AccountRows({ pages }: { pages: Pages<UserRef> }) {
  return (
    <Stack gap="2xs">
      {pages.items.map(u => (
        <AccountRow key={u.username} user={u} />
      ))}
      <More pages={pages} auto />
    </Stack>
  )
}

function AccountRow({ user }: { user: UserRef }) {
  const acct = useAccount()
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <ListRow
      variant="card"
      chevron
      onClick={() => openAdmin('users', user.username)}
      {...longPress((x, y) =>
        openActionMenu(
          x,
          y,
          { kind: 'member', user, server: null, where: 'admin' },
          undefined,
          acct
        )
      )}
      leading={<UserAvatar person={asAccount(user, 'administration')} size={28} />}
      label={
        <>
          <Name of={personCalled(user.display_name, user.username)} />{' '}
          <Name
            of={handleName(user.username)}
            before="("
            after=")"
            look="text-on-surface-variant"
          />
        </>
      }
    />
  )
}

// The accounts whose password is temporary or expired, a page at a time. The whole list of
// accounts is the store's.
const NO_ACCOUNTS: Record<AccountFilter, string> = {
  all: 'No account matches that name.',
  temporary: 'No account has a temporary password.',
  expired: 'No account has an expired temporary password.',
}

// The accounts of the instance under one filter, a page at a time. A change to an account asks
// again and keeps the rows on screen meanwhile.
function Accounts({ q, filter }: { q: string; filter: AccountFilter }) {
  const rev = useAccountChanges(s => s.rev)
  const [load, source] = useAccountPages(
    cursor => ask.adminUsers(cursor, q, filter),
    (u: UserRef) => u.username,
    [q, filter],
    { delayMs: 300 }
  )
  useRefreshWhen(source, rev)
  return (
    <Loaded load={load} what="the accounts" empty={NO_ACCOUNTS[filter]}>
      {pages => <AccountRows pages={pages} />}
    </Loaded>
  )
}

export function UsersSection() {
  const overview = useStore(s => s.adminOverview)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const openDialog = useStore(s => s.openDialog)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<AccountFilter>('all')
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  return (
    <Stack gap="md">
      <Row gap="sm" wrap>
        {overview && (
          <p className="min-w-0 flex-1 text-sm text-on-surface-variant">
            {overview.user_count.toLocaleString()}{' '}
            {overview.user_count === 1 ? 'account' : 'accounts'}
          </p>
        )}
        <Button
          variant="filled"
          size="md"
          onClick={() => openDialog({ kind: 'admin_create_account' })}
          place="shrink-0"
        >
          Create account
        </Button>
      </Row>
      <Row gap="none">
        <NameInput
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search users"
          aria-label="Search users"
        />
      </Row>
      <Chips label="Show accounts" value={filter} options={ACCOUNT_FILTERS} onChange={setFilter} />
      <Accounts q={q} filter={filter} />
    </Stack>
  )
}
