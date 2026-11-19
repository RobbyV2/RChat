'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { ChevronRight } from 'lucide-react'
import { api } from '../../lib/instances'
import { errorText, inSession, useStore } from '../../lib/store'
import type { ServerSummaryLite, UserRef } from '../../lib/types'
import { UserAvatar } from '../user_avatar'
import { PageGroup } from '../settings_page'
import { Sentinel } from '../ui'
import { dangerBtn, fieldCls, textBtn } from './touch'

export const rowBtnCls =
  'flex min-h-11 w-full min-w-0 items-center gap-3 rounded-xl bg-surface-container px-3 py-2 text-left hover:bg-surface-container-high'

function UserServers({ username }: { username: string }) {
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
      return api
        .adminUserServers(username, cursor)
        .then(page => {
          setList(cur => {
            const base = cursor === null ? [] : (cur ?? [])
            const seen = new Set(base.map(sv => sv.name))
            return [...base, ...page.items.filter(sv => !seen.has(sv.name))]
          })
          setNext(page.next)
        })
        .catch(inSession((e: unknown) => setError(errorText(e))))
        .finally(() => {
          busy.current = false
          setLoading(false)
        })
    },
    [username, setError]
  )
  useEffect(() => {
    void fetchFrom(null)
  }, [fetchFrom])
  if (!list) return null
  return (
    <>
      {list.length === 0 && <p className="text-sm text-on-surface-variant">No servers created.</p>}
      {list.map(sv => (
        <div
          key={sv.name}
          className="flex flex-wrap items-center gap-2 rounded-xl bg-surface-container px-3 py-2"
        >
          <span className="streamer min-w-24 flex-1 truncate text-sm">
            {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
          </span>
          <button onClick={() => void openServer(sv.name)} className={textBtn}>
            Open
          </button>
          <button onClick={() => openAdmin('servers', sv.name)} className={textBtn}>
            Manage
          </button>
        </div>
      ))}
      {next !== null && (
        <button onClick={() => void fetchFrom(next)} disabled={loading} className={textBtn}>
          {loading ? 'Loading' : 'Show more'}
        </button>
      )}
    </>
  )
}

// One account: the servers it created and the account actions.
export function UserPage({ username }: { username: string }) {
  const openDialog = useStore(s => s.openDialog)
  const openAdmin = useStore(s => s.openAdmin)
  const setError = useStore(s => s.setError)
  const mine = useStore(s => s.me?.username === username)
  const listed = useStore(s => s.adminUsers.list.find(u => u.username === username))
  const [found, setFound] = useState<UserRef | null | undefined>(undefined)
  useEffect(() => {
    if (listed) return
    let live = true
    api
      .adminUsers(null, username)
      .then(page => {
        if (live) setFound(page.items.find(u => u.username === username) ?? null)
      })
      .catch(inSession((e: unknown) => setError(errorText(e))))
    return () => {
      live = false
    }
  }, [listed, username, setError])
  const user = listed ?? found
  return (
    <div>
      <button
        onClick={() => openAdmin('users')}
        className={`${textBtn} mb-3 -ml-3 hidden md:block`}
      >
        Back to users
      </button>
      {user === null && <p className="text-sm text-on-surface-variant">No such account.</p>}
      {user && (
        <>
          <div className="flex min-w-0 items-center gap-3 pb-5">
            <UserAvatar
              username={user.username}
              avatarKind={user.avatar_kind}
              avatarColor={user.avatar_color}
              size={40}
            />
            <span className="streamer flex min-w-0 flex-col">
              <span className="truncate font-medium">{user.display_name}</span>
              <span className="truncate text-sm text-on-surface-variant">{user.username}</span>
            </span>
          </div>
          <PageGroup label="Servers they created">
            <UserServers username={user.username} />
          </PageGroup>
          {!mine && (
            <PageGroup label="Danger">
              <div className="flex flex-wrap gap-2">
                <button
                  onClick={() =>
                    openDialog({ kind: 'remove_phrase_confirm', username: user.username })
                  }
                  className={dangerBtn}
                >
                  Remove backup phrase
                </button>
                <button
                  onClick={() => openDialog({ kind: 'ban_confirm', username: user.username })}
                  className={dangerBtn}
                >
                  Ban site-wide
                </button>
                <button
                  onClick={() =>
                    openDialog({ kind: 'delete_user_confirm', username: user.username })
                  }
                  className={dangerBtn}
                >
                  Delete account
                </button>
              </div>
            </PageGroup>
          )}
        </>
      )}
    </div>
  )
}

export function UsersSection() {
  const overview = useStore(s => s.adminOverview)
  const adminUsers = useStore(s => s.adminUsers)
  const loadAdminUsers = useStore(s => s.loadAdminUsers)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const openAdmin = useStore(s => s.openAdmin)
  const [q, setQ] = useState('')
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  useEffect(() => {
    const t = setTimeout(() => void loadAdminUsers(q, true), 300)
    return () => clearTimeout(t)
  }, [q, loadAdminUsers])
  const more = useCallback(() => void loadAdminUsers(q), [q, loadAdminUsers])
  return (
    <div className="space-y-2">
      {overview && (
        <p className="text-sm text-on-surface-variant">
          {overview.user_count.toLocaleString()}{' '}
          {overview.user_count === 1 ? 'account' : 'accounts'}
        </p>
      )}
      <div className="flex">
        <input
          value={q}
          onChange={e => setQ(e.target.value)}
          placeholder="Search users"
          aria-label="Search users"
          className={`${fieldCls} streamer`}
        />
      </div>
      <div className="space-y-1">
        {adminUsers.list.map(u => (
          <button
            key={u.username}
            onClick={() => openAdmin('users', u.username)}
            className={rowBtnCls}
          >
            <UserAvatar
              username={u.username}
              avatarKind={u.avatar_kind}
              avatarColor={u.avatar_color}
              size={28}
            />
            <span className="streamer min-w-0 flex-1 truncate text-sm">
              {u.display_name} <span className="text-on-surface-variant">({u.username})</span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-on-surface-variant" />
          </button>
        ))}
        {adminUsers.hasMore && <Sentinel key={adminUsers.list.length} onVisible={more} />}
      </div>
    </div>
  )
}
