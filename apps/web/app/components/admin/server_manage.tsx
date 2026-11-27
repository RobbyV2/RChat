'use client'
import { useAccount } from '../../lib/client/react'
import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import type { ServerDetail } from '../../lib/types'
import { errorText, useStore } from '../../lib/store'
import { isBuiltin } from '../../lib/admin_servers'
import { canDeleteChannel } from '../../lib/rules'
import { UserAvatar } from '../user_avatar'
import {
  AdminPermsEditor,
  BanList,
  ChannelControls,
  MemberSearchField,
  RolesEditor,
  ServerAppearance,
  ServerPasswordField,
  useMemberSearch,
} from '../server_settings'
import { Sentinel, sectionCls } from '../ui'
import { dangerBtn, fieldCls, textBtn } from './touch'

function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
  streamer = false,
}: {
  initial?: string
  placeholder: string
  submitLabel: string
  onSubmit: (value: string) => void
  streamer?: boolean
}) {
  const [value, setValue] = useState(initial ?? '')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const trimmed = value.trim()
        if (!trimmed) return
        onSubmit(trimmed)
        if (initial === undefined) setValue('')
      }}
      className="flex min-w-0 flex-1 gap-2"
    >
      <input
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className={`${fieldCls} min-w-24 ${streamer ? 'streamer' : ''}`}
      />
      <button className={`${textBtn} shrink-0`}>{submitLabel}</button>
    </form>
  )
}

// Everything a server's managers can change, for the site admin.
export function ServerManage({ name, onCollapse }: { name: string; onCollapse: () => void }) {
  const ownerSession = useAccount()
  const setError = useStore(s => s.setError)
  const renameServer = useStore(s => s.renameServer)
  const createChannel = useStore(s => s.createChannel)
  const renameChannel = useStore(s => s.renameChannel)
  const deleteChannel = useStore(s => s.deleteChannel)
  const askConfirm = useStore(s => s.askConfirm)
  const banMember = useStore(s => s.banMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const cache = useStore(s => s.members[name])
  const loadMembers = useStore(s => s.loadMembers)
  const me = useStore(s => s.me)
  const builtin = useStore(s => isBuiltin(name, s.settings))
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  const [banning, setBanning] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const found = useMemberSearch(name, q)

  const refresh = useCallback(
    () =>
      ownerSession.api
        .getServer(name)
        .then(setDetail)
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e)))),
    [ownerSession, name, setError]
  )
  useEffect(() => {
    void refresh()
    void loadMembers(name)
  }, [refresh, name, loadMembers])
  const moreMembers = useCallback(() => void loadMembers(name), [name, loadMembers])
  const reloadSearch = found.reload
  const reloadMembers = useCallback(() => {
    void loadMembers(name, true)
    reloadSearch()
  }, [name, loadMembers, reloadSearch])

  if (!detail) return null
  const run = (fn: () => Promise<void>) => void fn().then(ownerSession.lifetime.inSession(refresh))

  return (
    <div className="space-y-2 px-3 py-3">
      <NameForm
        initial={detail.display_name}
        placeholder="Server name"
        submitLabel="Rename"
        streamer
        onSubmit={v =>
          renameServer(name, v).then(
            onCollapse,
            ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e)))
          )
        }
      />
      {builtin ? (
        <p className="text-xs text-on-surface-variant">
          The built-in server keeps its address and has no password.
        </p>
      ) : (
        <>
          <ServerPasswordField
            server={name}
            hasPassword={detail.has_password}
            canRemove
            publicRead={detail.public_read ?? null}
            refresh={() => {
              void refresh()
              reloadMembers()
            }}
          />
        </>
      )}
      <ServerAppearance server={name} detail={detail} refresh={() => void refresh()} />
      <p className={sectionCls}>Roles</p>
      <RolesEditor
        server={name}
        roles={detail.roles}
        version={detail.roles_version}
        refresh={refresh}
      />
      <p className={sectionCls}>Channels</p>
      {detail.channels.map(c => {
        const deletable = canDeleteChannel(detail.channels, c)
        return (
          <ChannelControls
            key={c.id}
            server={name}
            channel={c}
            roles={detail.roles}
            refresh={refresh}
            lead={
              <div className="flex w-full min-w-0 items-center gap-2">
                <NameForm
                  initial={c.name}
                  placeholder="Channel name"
                  submitLabel="Rename"
                  onSubmit={v => run(() => renameChannel(c.id, v))}
                />
                <button
                  disabled={!deletable}
                  onClick={() =>
                    askConfirm({
                      title: 'Delete Channel',
                      body:
                        c.kind === 'text'
                          ? `Delete #${c.name}? Its messages are deleted for everyone.`
                          : `Delete the voice channel ${c.name}?`,
                      confirm: 'Delete',
                      action: () => run(() => deleteChannel(c.id)),
                    })
                  }
                  aria-label={`Delete ${c.name}`}
                  title={
                    deletable
                      ? `Delete ${c.name}`
                      : c.kind === 'text'
                        ? 'Cannot delete the only text channel'
                        : 'Cannot delete the only channel'
                  }
                  className={`${dangerBtn} shrink-0`}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            }
          />
        )
      })}
      <NameForm
        placeholder="New channel"
        submitLabel="Add"
        onSubmit={v => run(() => createChannel(name, v))}
      />
      <p className={sectionCls}>Bans</p>
      <BanList server={name} />
      <p className={sectionCls}>Members ({detail.member_count})</p>
      <MemberSearchField value={q} onChange={setQ} />
      {found.active && !found.loading && found.list.length === 0 && (
        <p className="px-2 text-sm text-on-surface-variant">No matching members.</p>
      )}
      {(found.active ? found.list : (cache?.list ?? [])).map(m => (
        <div key={m.username} className="rounded-xl px-1 py-1">
          <div className="flex flex-wrap items-center justify-end gap-2">
            <UserAvatar
              username={m.username}
              avatarKind={m.avatar_kind}
              avatarColor={m.avatar_color}
              size={24}
            />
            <span className="streamer min-w-24 flex-1 truncate text-sm">{m.display_name}</span>
            {m.is_admin && (
              <button
                onClick={() => setEditingAdmin(editingAdmin === m.username ? null : m.username)}
                className={textBtn}
              >
                Perms
              </button>
            )}
            <button
              onClick={() =>
                m.is_admin
                  ? ownerSession.store.menu.revokeAdminFor(name, m.username, reloadMembers)
                  : void grantAdmin(name, m.username).then(
                      ownerSession.lifetime.inSession(reloadMembers)
                    )
              }
              className={textBtn}
            >
              {m.is_admin ? 'Revoke Admin' : 'Grant Admin'}
            </button>
            {banning === m.username ? (
              <>
                <button onClick={() => setBanning(null)} className={textBtn}>
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setBanning(null)
                    run(() =>
                      banMember(name, m.username).then(
                        ownerSession.lifetime.inSession(reloadMembers)
                      )
                    )
                  }}
                  className={dangerBtn}
                >
                  Confirm ban
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() =>
                    ownerSession.store.menu.confirmKick(name, m.username, reloadMembers)
                  }
                  className={dangerBtn}
                >
                  Kick
                </button>
                {m.username !== me?.username && (
                  <button onClick={() => setBanning(m.username)} className={dangerBtn}>
                    Ban from server
                  </button>
                )}
              </>
            )}
          </div>
          {m.is_admin && editingAdmin === m.username && (
            <div className="mt-1.5 pl-8">
              <AdminPermsEditor
                server={name}
                username={m.username}
                perms={m.perms}
                refresh={reloadMembers}
              />
            </div>
          )}
        </div>
      ))}
      {found.active
        ? found.hasMore && <Sentinel key={`q${found.list.length}`} onVisible={found.more} />
        : (cache?.hasMore ?? false) && (
            <Sentinel key={cache?.list.length ?? 0} onVisible={moreMembers} />
          )}
    </div>
  )
}
