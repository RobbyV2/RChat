'use client'
import { asAccount } from '../../lib/people'
import { useAccount } from '../../lib/client/react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { ACCOUNT_FILTERS, signInLine } from '../../lib/admin_accounts'
import { ApiError } from '../../lib/api'
import { errorText, useStore } from '../../lib/store'
import type { AccountFilter, AdminAccount, ServerSummaryLite, UserRef } from '../../lib/types'
import { openActionMenu } from '../../lib/actions/menu'
import { longPress } from '../context_menu'
import { UserAvatar } from '../user_avatar'
import { PageGroup } from '../settings_page'
import { Button, ListRow } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { Chips, Sentinel, fieldCls } from '../ui'
import { useAccountChanges } from './account_state'
import { time } from '../../lib/platform/time'

function UserServers({ username }: { username: string }) {
  const ownerSession = useAccount()
  const setError = useStore(s => s.setError)
  const openServer = useStore(s => s.openServer)
  const openAdmin = useStore(s => s.openAdmin)
  const [list, setList] = useState<ServerSummaryLite[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const busy = useRef(false)
  const fetchFrom = useCallback(
    (cursor: string | null) => {
      if (busy.current && cursor !== null) return Promise.resolve()
      busy.current = true
      setLoading(true)
      return ownerSession.api
        .adminUserServers(username, cursor)
        .then(page => {
          setList(cur => {
            const base = cursor === null ? [] : (cur ?? [])
            const seen = new Set(base.map(sv => sv.name))
            return [...base, ...page.items.filter(sv => !seen.has(sv.name))]
          })
          setNext(page.next)
        })
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e))))
        .finally(() => {
          busy.current = false
          setLoading(false)
        })
    },
    [ownerSession, username, setError]
  )
  useEffect(() => {
    void fetchFrom(null)
  }, [fetchFrom])
  if (!list) return null
  return (
    <>
      {list.length === 0 && <p className="text-sm text-on-surface-variant">No servers created.</p>}
      {list.map(sv => (
        <Surface key={sv.name} tone="base" radius="lg" pad="md">
          <Row gap="sm" wrap>
            <span className="streamer min-w-24 flex-1 truncate text-sm">
              {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
            </span>
            <Button onClick={() => void openServer(sv.name)}>Open</Button>
            <Button onClick={() => openAdmin('servers', sv.name)}>Manage</Button>
          </Row>
        </Surface>
      ))}
      {next !== null && (
        <Button onClick={() => void fetchFrom(next)} disabled={loading}>
          {loading ? 'Loading' : 'Show more'}
        </Button>
      )}
    </>
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

// One account: how it signs in, the account actions and the servers it created.
export function UserPage({ username }: { username: string }) {
  const ownerSession = useAccount()
  const openDialog = useStore(s => s.openDialog)
  const openAdmin = useStore(s => s.openAdmin)
  const setError = useStore(s => s.setError)
  const mine = useStore(s => s.me?.username === username)
  const listed = useStore(s => s.adminUsers.list.find(u => u.username === username))
  const rev = useAccountChanges(s => s.rev)
  const [account, setAccount] = useState<AdminAccount | null | undefined>(undefined)
  useEffect(() => {
    let live = true
    const load = () =>
      ownerSession.api
        .adminAccount(username)
        .then(found => {
          if (live) setAccount(found)
        })
        .catch(
          ownerSession.lifetime.inSession((e: unknown) => {
            if (!live) return
            if (e instanceof ApiError && e.status === 404) return setAccount(null)
            setError(errorText(e))
          })
        )
    void load()
    const again = () => {
      if (document.visibilityState === 'visible') void load()
    }
    window.addEventListener('focus', again)
    document.addEventListener('visibilitychange', again)
    return () => {
      live = false
      window.removeEventListener('focus', again)
      document.removeEventListener('visibilitychange', again)
    }
  }, [ownerSession, username, rev, setError])
  const user = account?.user ?? listed
  return (
    <Stack gap="lg">
      <Button onClick={() => openAdmin('users')} place="hidden md:inline-flex self-start">
        Back to users
      </Button>
      {account === null && !listed && (
        <p className="text-sm text-on-surface-variant">No such account.</p>
      )}
      {user && (
        <>
          <Row gap="md">
            <UserAvatar person={asAccount(user, 'administration')} size={40} />
            <Stack as="span" gap="none">
              <span className="streamer truncate font-medium">{user.display_name}</span>
              <span className="streamer truncate text-sm text-on-surface-variant">
                {user.username}
              </span>
            </Stack>
          </Row>
          {account && <AccountFacts account={account} />}
          <Row gap="sm" wrap>
            {!mine && (
              <>
                <Button
                  onClick={() =>
                    openDialog({ kind: 'new_password_confirm', username: user.username })
                  }
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
                    onClick={() =>
                      openDialog({ kind: 'delete_user_confirm', username: user.username })
                    }
                  >
                    Delete account
                  </Button>
                </Row>
              </PageGroup>
            )}
          </div>
        </>
      )}
    </Stack>
  )
}

// The accounts whose password is temporary or expired, a page at a time. The whole list of
// accounts is the store's.
const useFiltered = (q: string, filter: AccountFilter, rev: number) => {
  const ownerSession = useAccount()
  const setError = useStore(s => s.setError)
  const [page, setPage] = useState<{ list: UserRef[]; next: string | null }>({
    list: [],
    next: null,
  })
  const busy = useRef(false)
  const fetchFrom = useCallback(
    (cursor: string | null) => {
      if (filter === 'all' || (busy.current && cursor !== null)) return
      busy.current = true
      ownerSession.api
        .adminUsers(cursor, q, filter)
        .then(found =>
          setPage(cur => {
            const base = cursor === null ? [] : cur.list
            const seen = new Set(base.map(u => u.username))
            return {
              list: [...base, ...found.items.filter(u => !seen.has(u.username))],
              next: found.next,
            }
          })
        )
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e))))
        .finally(() => {
          busy.current = false
        })
    },
    [ownerSession, q, filter, setError]
  )
  useEffect(() => {
    const t = time().after(300, () => fetchFrom(null))
    return () => t?.()
  }, [fetchFrom, rev])
  return { ...page, more: () => fetchFrom(page.next) }
}

export function UsersSection() {
  const acct = useAccount()

  const overview = useStore(s => s.adminOverview)
  const adminUsers = useStore(s => s.adminUsers)
  const loadAdminUsers = useStore(s => s.loadAdminUsers)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const openAdmin = useStore(s => s.openAdmin)
  const openDialog = useStore(s => s.openDialog)
  const rev = useAccountChanges(s => s.rev)
  const [q, setQ] = useState('')
  const [filter, setFilter] = useState<AccountFilter>('all')
  const filtered = useFiltered(q, filter, rev)
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  useEffect(() => {
    const t = acct.time.after(300, () => void loadAdminUsers(q, true))
    return () => t?.()
  }, [q, loadAdminUsers])
  const more = useCallback(() => void loadAdminUsers(q), [q, loadAdminUsers])
  const all = filter === 'all'
  const list = all ? adminUsers.list : filtered.list
  const hasMore = all ? adminUsers.hasMore : filtered.next !== null
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
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search users"
          aria-label="Search users"
          className={`${fieldCls} streamer`}
        />
      </Row>
      <Chips label="Show accounts" value={filter} options={ACCOUNT_FILTERS} onChange={setFilter} />
      <Stack gap="2xs">
        {list.length === 0 && !hasMore && !all && (
          <p className="text-sm text-on-surface-variant">
            {filter === 'expired'
              ? 'No account has an expired temporary password.'
              : 'No account has a temporary password.'}
          </p>
        )}
        {list.map(u => (
          <ListRow
            key={u.username}
            variant="card"
            chevron
            onClick={() => openAdmin('users', u.username)}
            {...longPress((x, y) =>
              openActionMenu(
                x,
                y,
                { kind: 'member', user: u, server: null, where: 'admin' },
                undefined,
                acct
              )
            )}
            leading={<UserAvatar person={asAccount(u, 'administration')} size={28} />}
            streamer
            label={
              <>
                {u.display_name} <span className="text-on-surface-variant">({u.username})</span>
              </>
            }
          />
        ))}
        {hasMore && (
          <Sentinel key={`${filter}:${list.length}`} onVisible={all ? more : filtered.more} />
        )}
      </Stack>
    </Stack>
  )
}
