'use client'

import { useCallback, useEffect, useState } from 'react'
import { Trash2 } from 'lucide-react'
import * as api from '../lib/api'
import type { ServerDetail, ServerSummaryLite } from '../lib/types'
import { useStore } from '../lib/store'
import { UserAvatar } from './user_avatar'
import {
  AdminPermsEditor,
  ChannelControls,
  Dialog,
  RolesEditor,
  Sentinel,
  ServerPasswordField,
  dangerBtn,
  fieldCls,
  sectionCls,
  textBtn,
} from './server_settings'

export default function AdminPanel() {
  const dialog = useStore(s => s.activeDialog)
  const isSiteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  if (!isSiteAdmin || !dialog) return null
  switch (dialog.kind) {
    case 'admin_panel':
      return <Panel />
    case 'ban_confirm':
      return <BanConfirm username={dialog.username} />
    case 'delete_user_confirm':
      return <DeleteUserConfirm username={dialog.username} />
    default:
      return null
  }
}

function NameForm({
  initial,
  placeholder,
  submitLabel,
  onSubmit,
}: {
  initial?: string
  placeholder: string
  submitLabel: string
  onSubmit: (value: string) => void
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
        className={fieldCls}
      />
      <button className={textBtn}>{submitLabel}</button>
    </form>
  )
}

export function SettingSwitch({
  label,
  value,
  onChange,
}: {
  label: string
  value: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <button
      role="switch"
      aria-checked={value}
      title={label}
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between rounded-xl px-2 py-1.5 hover:bg-surface-container"
    >
      <span className="text-sm">{label}</span>
      <span
        className={`flex h-7 w-12 items-center rounded-full p-1 transition-colors ${
          value
            ? 'justify-end bg-primary'
            : 'justify-start border border-outline bg-surface-container-highest'
        }`}
      >
        <span className={`h-5 w-5 rounded-full ${value ? 'bg-on-primary' : 'bg-outline'}`} />
      </span>
    </button>
  )
}

export function SiteSwitches() {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  return (
    <div className="space-y-1">
      <SettingSwitch
        label="Profanity filter"
        value={settings.profanity_filter}
        onChange={v => void updateSettings({ profanity_filter: v })}
      />
      <SettingSwitch
        label="Asset previews"
        value={settings.asset_previews}
        onChange={v => void updateSettings({ asset_previews: v })}
      />
      <SettingSwitch
        label="File uploads"
        value={settings.asset_uploads}
        onChange={v => void updateSettings({ asset_uploads: v })}
      />
      <SettingSwitch
        label="Enable guests"
        value={settings.guests_enabled}
        onChange={v => void updateSettings({ guests_enabled: v })}
      />
    </div>
  )
}

function DangerTools() {
  const adminDeleteMessage = useStore(s => s.adminDeleteMessage)
  const [id, setId] = useState('')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const n = Number(id.trim())
        if (Number.isInteger(n) && n > 0) void adminDeleteMessage(n).then(() => setId(''))
      }}
      className="flex gap-2"
    >
      <input
        value={id}
        onChange={e => setId(e.target.value)}
        inputMode="numeric"
        placeholder="Message id"
        className={fieldCls}
      />
      <button className={dangerBtn}>Delete message</button>
    </form>
  )
}

function UserServers({ username }: { username: string }) {
  const setError = useStore(s => s.setError)
  const openServer = useStore(s => s.openServer)
  const closeDialog = useStore(s => s.closeDialog)
  const [list, setList] = useState<ServerSummaryLite[] | null>(null)
  const [managing, setManaging] = useState<string | null>(null)
  useEffect(() => {
    api
      .adminUserServers(username)
      .then(setList)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [username, setError])
  if (!list) return null
  return (
    <div className="space-y-1 border-t border-outline-variant px-3 py-2">
      {list.length === 0 && <p className="text-sm text-on-surface-variant">No servers created.</p>}
      {list.map(sv => (
        <div key={sv.name}>
          <div className="flex items-center gap-2">
            <span className="min-w-0 flex-1 truncate text-sm">
              {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
            </span>
            <button
              onClick={() => {
                closeDialog()
                void openServer(sv.name)
              }}
              className={textBtn}
            >
              Open
            </button>
            <button
              onClick={() => setManaging(managing === sv.name ? null : sv.name)}
              className={textBtn}
            >
              {managing === sv.name ? 'Close' : 'Manage'}
            </button>
          </div>
          {managing === sv.name && (
            <ServerManage name={sv.name} onCollapse={() => setManaging(null)} />
          )}
        </div>
      ))}
    </div>
  )
}

function Panel() {
  const overview = useStore(s => s.adminOverview)
  const adminUsers = useStore(s => s.adminUsers)
  const adminServers = useStore(s => s.adminServers)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const loadAdminUsers = useStore(s => s.loadAdminUsers)
  const loadAdminServers = useStore(s => s.loadAdminServers)
  const adminDeleteServer = useStore(s => s.adminDeleteServer)
  const closeDialog = useStore(s => s.closeDialog)
  const openDialog = useStore(s => s.openDialog)
  const me = useStore(s => s.me)
  const [selected, setSelected] = useState<string | null>(null)
  const [userSel, setUserSel] = useState<string | null>(null)
  const [serverQ, setServerQ] = useState('')
  const [userQ, setUserQ] = useState('')
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  useEffect(() => {
    const t = setTimeout(() => void loadAdminServers(serverQ, true), 300)
    return () => clearTimeout(t)
  }, [serverQ, loadAdminServers])
  useEffect(() => {
    const t = setTimeout(() => void loadAdminUsers(userQ, true), 300)
    return () => clearTimeout(t)
  }, [userQ, loadAdminUsers])
  const moreServers = useCallback(() => void loadAdminServers(serverQ), [serverQ, loadAdminServers])
  const moreUsers = useCallback(() => void loadAdminUsers(userQ), [userQ, loadAdminUsers])
  return (
    <Dialog full title="Site Administration" onClose={closeDialog}>
      <p className={sectionCls}>Settings</p>
      <SiteSwitches />
      <p className={sectionCls}>Servers{overview ? ` (${overview.server_count})` : ''}</p>
      <div className="mb-2 flex">
        <input
          value={serverQ}
          onChange={e => setServerQ(e.target.value)}
          placeholder="Search servers"
          className={fieldCls}
        />
      </div>
      <div className="space-y-1">
        {adminServers.list.map(sv => (
          <div key={sv.name} className="rounded-xl bg-surface-container">
            <div className="flex items-center gap-2 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-sm">
                {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
              </span>
              <button
                onClick={() => setSelected(selected === sv.name ? null : sv.name)}
                className={textBtn}
              >
                {selected === sv.name ? 'Close' : 'Manage'}
              </button>
              {sv.name !== 'rchat' && (
                <button onClick={() => void adminDeleteServer(sv.name)} className={dangerBtn}>
                  Delete
                </button>
              )}
            </div>
            {selected === sv.name && (
              <ServerManage name={sv.name} onCollapse={() => setSelected(null)} />
            )}
          </div>
        ))}
        {adminServers.hasMore && (
          <Sentinel key={adminServers.list.length} onVisible={moreServers} />
        )}
      </div>
      <p className={sectionCls}>Users{overview ? ` (${overview.user_count})` : ''}</p>
      <div className="mb-2 flex">
        <input
          value={userQ}
          onChange={e => setUserQ(e.target.value)}
          placeholder="Search users"
          className={fieldCls}
        />
      </div>
      <div className="space-y-1">
        {adminUsers.list.map(u => (
          <div key={u.username} className="rounded-xl bg-surface-container">
            <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
              <UserAvatar
                username={u.username}
                avatarKind={u.avatar_kind}
                avatarColor={u.avatar_color}
                size={28}
              />
              <span className="streamer min-w-0 flex-1 truncate text-sm">
                {u.display_name} <span className="text-on-surface-variant">({u.username})</span>
              </span>
              <button
                onClick={() => setUserSel(userSel === u.username ? null : u.username)}
                className={textBtn}
              >
                {userSel === u.username ? 'Close' : 'Servers'}
              </button>
              {u.username !== me?.username && (
                <>
                  <button
                    onClick={() =>
                      openDialog({ kind: 'delete_user_confirm', username: u.username })
                    }
                    className={dangerBtn}
                  >
                    Delete
                  </button>
                  <button
                    onClick={() => openDialog({ kind: 'ban_confirm', username: u.username })}
                    className={dangerBtn}
                  >
                    Ban
                  </button>
                </>
              )}
            </div>
            {userSel === u.username && <UserServers username={u.username} />}
          </div>
        ))}
        {adminUsers.hasMore && <Sentinel key={adminUsers.list.length} onVisible={moreUsers} />}
      </div>
      <p className={sectionCls}>Danger Tools</p>
      <DangerTools />
    </Dialog>
  )
}

function ServerManage({ name, onCollapse }: { name: string; onCollapse: () => void }) {
  const setError = useStore(s => s.setError)
  const renameServer = useStore(s => s.renameServer)
  const createChannel = useStore(s => s.createChannel)
  const renameChannel = useStore(s => s.renameChannel)
  const deleteChannel = useStore(s => s.deleteChannel)
  const kickMember = useStore(s => s.kickMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const revokeAdmin = useStore(s => s.revokeAdmin)
  const cache = useStore(s => s.members[name])
  const loadMembers = useStore(s => s.loadMembers)
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)

  const refresh = useCallback(
    () =>
      api
        .getServer(name)
        .then(setDetail)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [name, setError]
  )
  useEffect(() => {
    void refresh()
    void loadMembers(name)
  }, [refresh, name, loadMembers])
  const moreMembers = useCallback(() => void loadMembers(name), [name, loadMembers])
  const reloadMembers = useCallback(() => void loadMembers(name, true), [name, loadMembers])

  if (!detail) return null
  const run = (fn: () => Promise<void>) => void fn().then(refresh)
  const soleChannel = detail.channels.length === 1

  return (
    <div className="space-y-2 border-t border-outline-variant px-3 py-3">
      {name !== 'rchat' && (
        <>
          <NameForm
            initial={detail.display_name}
            placeholder="Server name"
            submitLabel="Rename"
            onSubmit={v => void renameServer(name, v).then(onCollapse)}
          />
          <ServerPasswordField server={name} hasPassword={detail.has_password} refresh={refresh} />
        </>
      )}
      <p className={sectionCls}>Roles</p>
      <RolesEditor server={name} roles={detail.roles} refresh={refresh} />
      <p className={sectionCls}>Channels</p>
      {detail.channels.map(c => (
        <ChannelControls
          key={c.id}
          server={name}
          channel={c}
          roles={detail.roles}
          refresh={refresh}
          lead={
            <>
              <NameForm
                initial={c.name}
                placeholder="Channel name"
                submitLabel="Rename"
                onSubmit={v => run(() => renameChannel(c.id, v))}
              />
              <button
                disabled={soleChannel}
                onClick={() => run(() => deleteChannel(c.id))}
                aria-label={`Delete ${c.name}`}
                title={soleChannel ? 'Cannot delete the only channel' : `Delete ${c.name}`}
                className={dangerBtn}
              >
                <Trash2 size={16} />
              </button>
            </>
          }
        />
      ))}
      <NameForm
        placeholder="New channel"
        submitLabel="Add"
        onSubmit={v => run(() => createChannel(name, v))}
      />
      <p className={sectionCls}>Members ({detail.member_count})</p>
      {(cache?.list ?? []).map(m => (
        <div key={m.username} className="rounded-xl px-1 py-1">
          <div className="flex items-center gap-2">
            <UserAvatar
              username={m.username}
              avatarKind={m.avatar_kind}
              avatarColor={m.avatar_color}
              size={24}
            />
            <span className="min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
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
                void (
                  m.is_admin ? revokeAdmin(name, m.username) : grantAdmin(name, m.username)
                ).then(reloadMembers)
              }
              className={textBtn}
            >
              {m.is_admin ? 'Revoke Admin' : 'Grant Admin'}
            </button>
            <button
              onClick={() => void kickMember(name, m.username).then(reloadMembers)}
              className={dangerBtn}
            >
              Kick
            </button>
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
      {(cache?.hasMore ?? false) && (
        <Sentinel key={cache?.list.length ?? 0} onVisible={moreMembers} />
      )}
    </div>
  )
}

function DeleteUserConfirm({ username }: { username: string }) {
  const adminDeleteUser = useStore(s => s.adminDeleteUser)
  const closeDialog = useStore(s => s.closeDialog)
  return (
    <Dialog title="Delete User" onClose={closeDialog}>
      <p className="text-sm text-on-surface-variant">
        Delete the account of {username}? Their messages and created servers are kept, and the
        username stays available. Use Ban to also erase messages and blacklist the name.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button
          onClick={() => void adminDeleteUser(username).then(closeDialog)}
          className="rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error hover:opacity-90"
        >
          Delete
        </button>
      </div>
    </Dialog>
  )
}

function BanConfirm({ username }: { username: string }) {
  const banUser = useStore(s => s.banUser)
  const closeDialog = useStore(s => s.closeDialog)
  return (
    <Dialog title="Ban User" onClose={closeDialog}>
      <p className="text-sm text-on-surface-variant">
        Ban {username} site-wide? This deletes their account and every message they have sent, and
        permanently blocks the username.
      </p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button
          onClick={() => void banUser(username).then(closeDialog)}
          className="rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error hover:opacity-90"
        >
          Ban
        </button>
      </div>
    </Dialog>
  )
}
