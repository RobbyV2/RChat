'use client'

import { Fragment, useCallback, useEffect, useId, useRef, useState } from 'react'
import { Trash2 } from 'lucide-react'
import { api } from '../lib/instances'
import type { InstanceAuditEntry, RelayStatus, ServerDetail, ServerSummaryLite } from '../lib/types'
import { instanceAuditLine } from '../lib/instance_audit'
import { confirmKick, errorText, revokeAdminFor, useStore } from '../lib/store'
import {
  PROFANITY_TARGETS,
  canDeleteChannel,
  profanityTargetLocked,
  profanityTargetOn,
} from '../lib/rules'
import { UserAvatar } from './user_avatar'
import {
  AdminPermsEditor,
  BanList,
  ChannelControls,
  MemberSearchField,
  RolesEditor,
  ServerAppearance,
  ServerPasswordField,
  useMemberSearch,
} from './server_settings'
import { FEATURE_ROWS, NEW_ACCOUNTS } from '../lib/features'
import {
  Chips,
  Dialog,
  Sentinel,
  dangerBtn,
  fieldCls,
  filledDangerBtn,
  sectionCls,
  textBtn,
} from './ui'

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
    case 'remove_phrase_confirm':
      return <RemovePhraseConfirm username={dialog.username} />
    default:
      return null
  }
}

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

export function SettingSwitch({
  label,
  hint,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  const hintId = useId()
  return (
    <button
      role="switch"
      aria-checked={value}
      aria-label={label}
      aria-describedby={hint ? hintId : undefined}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className="flex w-full items-center justify-between gap-3 rounded-xl px-2 py-1.5 text-left enabled:hover:bg-surface-container disabled:opacity-50"
    >
      {hint ? (
        <span className="flex min-w-0 flex-col">
          <span className="text-sm">{label}</span>
          <span id={hintId} className="text-xs text-on-surface-variant">
            {hint}
          </span>
        </span>
      ) : (
        <span className="text-sm">{label}</span>
      )}
      <span
        className={`flex h-7 w-12 shrink-0 items-center rounded-full p-1 transition-colors ${
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

function ProfanityTargetChecks() {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  return (
    <fieldset
      aria-label="Profanity filter applies to"
      className={`mx-2 mb-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-surface-container px-3 py-2 ${
        settings.profanity_filter ? '' : 'opacity-60'
      }`}
    >
      {PROFANITY_TARGETS.map(({ key, label }) => {
        const locked = profanityTargetLocked(settings, key)
        return (
          <label
            key={key}
            title={label}
            className={`flex min-w-0 items-start gap-2 py-1 text-sm leading-5 ${
              locked
                ? 'cursor-not-allowed text-on-surface-variant'
                : 'cursor-pointer text-on-surface'
            }`}
          >
            <input
              type="checkbox"
              checked={profanityTargetOn(settings, key)}
              disabled={locked}
              onChange={e =>
                void updateSettings({ profanity_targets: { [key]: e.target.checked } })
              }
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="min-w-0 break-words">{label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function NewAccounts({ line }: { line: string }) {
  const registration = useStore(s => s.settings.registration)
  const updateSettings = useStore(s => s.updateSettings)
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5">
      <span className="flex flex-col">
        <span className="text-sm">New accounts</span>
        <span className="text-xs text-on-surface-variant">{line}</span>
      </span>
      <Chips
        label="New accounts"
        value={registration}
        options={NEW_ACCOUNTS}
        onChange={v => void updateSettings({ registration: v })}
      />
    </div>
  )
}

function FeatureSwitches() {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  return (
    <div className="space-y-1">
      {FEATURE_ROWS.map(({ key, label, line }) => {
        if (key === 'registration') return <NewAccounts key={key} line={line} />
        return (
          <Fragment key={key}>
            <SettingSwitch
              label={label}
              hint={line}
              value={settings[key] ?? false}
              onChange={v => void updateSettings({ [key]: v })}
            />
            {key === 'profanity_filter' && <ProfanityTargetChecks />}
            {key === 'p2p_attachments' && !settings.asset_uploads && !settings.p2p_attachments && (
              <p className="px-2 pb-1 text-xs text-on-surface-variant">
                Text only: no attachments, in P2P conversations too.
              </p>
            )}
          </Fragment>
        )
      })}
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

function InstanceAudit() {
  const setError = useStore(s => s.setError)
  const [list, setList] = useState<InstanceAuditEntry[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const busy = useRef(false)
  const fetchFrom = useCallback(
    (cursor: string | null) => {
      if (busy.current) return
      busy.current = true
      api
        .adminAudit(cursor)
        .then(page => {
          setList(cur => {
            const base = cursor === null ? [] : (cur ?? [])
            const seen = new Set(base.map(e => e.id))
            return [...base, ...page.items.filter(e => !seen.has(e.id))]
          })
          setNext(page.next)
        })
        .catch((e: unknown) => setError(errorText(e)))
        .finally(() => {
          busy.current = false
        })
    },
    [setError]
  )
  useEffect(() => {
    fetchFrom(null)
  }, [fetchFrom])
  if (!list) return null
  return (
    <div className="space-y-1">
      {list.length === 0 && <p className="text-sm text-on-surface-variant">Nothing yet.</p>}
      {list.map(e => (
        <div
          key={e.id}
          className="flex flex-wrap items-baseline gap-x-2 rounded-xl bg-surface-container px-2 py-1.5 text-sm"
        >
          <span className="min-w-0 flex-1 break-words">
            {instanceAuditLine(e).map((p, i) =>
              p.name ? (
                <span key={i} className="streamer">
                  {p.text}
                </span>
              ) : (
                <Fragment key={i}>{p.text}</Fragment>
              )
            )}
          </span>
          <time
            dateTime={new Date(e.at * 1000).toISOString()}
            className="shrink-0 text-xs text-on-surface-variant"
          >
            {new Date(e.at * 1000).toLocaleString()}
          </time>
        </div>
      ))}
      {next && <Sentinel key={list.length} onVisible={() => fetchFrom(next)} />}
    </div>
  )
}

function UserServers({ username }: { username: string }) {
  const setError = useStore(s => s.setError)
  const openServer = useStore(s => s.openServer)
  const closeDialog = useStore(s => s.closeDialog)
  const [list, setList] = useState<ServerSummaryLite[] | null>(null)
  const [next, setNext] = useState<string | null>(null)
  const [managing, setManaging] = useState<string | null>(null)
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
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)))
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
      {next !== null && (
        <button onClick={() => void fetchFrom(next)} disabled={loading} className={textBtn}>
          {loading ? 'Loading…' : 'Show more'}
        </button>
      )}
    </div>
  )
}

function RelayStatusRow({ relay }: { relay: RelayStatus }) {
  const rows: [string, string][] = relay.enabled
    ? [
        ['Status', relay.turn ? 'On (STUN and TURN)' : 'On (STUN only)'],
        ['UDP port', relay.port === null ? 'Unknown' : String(relay.port)],
        [
          'Active allocations',
          relay.allocations === null ? 'Runs in another process' : String(relay.allocations),
        ],
      ]
    : [['Status', 'Off']]
  return (
    <>
      <p className={sectionCls}>Relay</p>
      <dl className="mb-2 space-y-1 rounded-xl bg-surface-container px-3 py-2 text-sm">
        {rows.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between gap-3">
            <dt className="text-on-surface-variant">{label}</dt>
            <dd className="text-right">{value}</dd>
          </div>
        ))}
      </dl>
    </>
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
  const askConfirm = useStore(s => s.askConfirm)
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
      <p className={sectionCls}>Features</p>
      <FeatureSwitches />
      {overview?.relay && <RelayStatusRow relay={overview.relay} />}
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
                <button
                  onClick={() =>
                    askConfirm({
                      title: 'Delete Server',
                      body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
                      confirm: 'Delete',
                      action: () => void adminDeleteServer(sv.name),
                    })
                  }
                  className={dangerBtn}
                >
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
              <span className="streamer min-w-24 flex-1 truncate text-sm">
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
                      openDialog({ kind: 'remove_phrase_confirm', username: u.username })
                    }
                    className={dangerBtn}
                  >
                    Remove backup phrase
                  </button>
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
                    Ban site-wide
                  </button>
                </>
              )}
            </div>
            {userSel === u.username && <UserServers username={u.username} />}
          </div>
        ))}
        {adminUsers.hasMore && <Sentinel key={adminUsers.list.length} onVisible={moreUsers} />}
      </div>
      <p className={sectionCls}>Audit log</p>
      <InstanceAudit />
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
  const askConfirm = useStore(s => s.askConfirm)
  const banMember = useStore(s => s.banMember)
  const grantAdmin = useStore(s => s.grantAdmin)
  const cache = useStore(s => s.members[name])
  const loadMembers = useStore(s => s.loadMembers)
  const me = useStore(s => s.me)
  const [detail, setDetail] = useState<ServerDetail | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  const [banning, setBanning] = useState<string | null>(null)
  const [q, setQ] = useState('')
  const found = useMemberSearch(name, q)

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
  const reloadSearch = found.reload
  const reloadMembers = useCallback(() => {
    void loadMembers(name, true)
    reloadSearch()
  }, [name, loadMembers, reloadSearch])

  if (!detail) return null
  const run = (fn: () => Promise<void>) => void fn().then(refresh)

  return (
    <div className="space-y-2 border-t border-outline-variant px-3 py-3">
      {name !== 'rchat' && (
        <>
          <NameForm
            initial={detail.display_name}
            placeholder="Server name"
            submitLabel="Rename"
            streamer
            onSubmit={v =>
              renameServer(name, v).then(onCollapse, (e: unknown) => setError(errorText(e)))
            }
          />
          <ServerPasswordField
            server={name}
            hasPassword={detail.has_password}
            canRemove
            refresh={() => {
              void refresh()
              reloadMembers()
            }}
          />
        </>
      )}
      <ServerAppearance server={name} detail={detail} refresh={() => void refresh()} />
      <p className={sectionCls}>Roles</p>
      <RolesEditor server={name} roles={detail.roles} refresh={refresh} />
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
                  ? revokeAdminFor(name, m.username, reloadMembers)
                  : void grantAdmin(name, m.username).then(reloadMembers)
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
                    run(() => banMember(name, m.username).then(reloadMembers))
                  }}
                  className={dangerBtn}
                >
                  Confirm ban
                </button>
              </>
            ) : (
              <>
                <button
                  onClick={() => confirmKick(name, m.username, reloadMembers)}
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

function UserConfirm({
  title,
  confirm,
  run,
  children,
}: {
  title: string
  confirm: string
  run: () => Promise<unknown>
  children: React.ReactNode
}) {
  const closeDialog = useStore(s => s.closeDialog)
  return (
    <Dialog title={title} onClose={closeDialog}>
      <p className="text-sm text-on-surface-variant">{children}</p>
      <div className="mt-6 flex justify-end gap-2">
        <button onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button onClick={() => void run().then(closeDialog)} className={filledDangerBtn}>
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}

function DeleteUserConfirm({ username }: { username: string }) {
  const adminDeleteUser = useStore(s => s.adminDeleteUser)
  return (
    <UserConfirm title="Delete User" confirm="Delete" run={() => adminDeleteUser(username)}>
      Delete the account of <span className="streamer">{username}</span>? Every message they sent
      and their DMs are deleted. Servers they created are kept. The username becomes free to
      register again; use Ban site-wide to also block the name.
    </UserConfirm>
  )
}

function RemovePhraseConfirm({ username }: { username: string }) {
  const adminRemovePhrase = useStore(s => s.adminRemovePhrase)
  return (
    <UserConfirm
      title="Remove Backup Phrase"
      confirm="Remove"
      run={() => adminRemovePhrase(username)}
    >
      Remove the backup phrase of <span className="streamer">{username}</span>? They stay signed in
      and keep their password. This only removes a way back in, and they can set a new phrase.
    </UserConfirm>
  )
}

function BanConfirm({ username }: { username: string }) {
  const banUser = useStore(s => s.banUser)
  return (
    <UserConfirm title="Ban Site-wide" confirm="Ban" run={() => banUser(username)}>
      Ban <span className="streamer">{username}</span> site-wide? This deletes their account and
      every message they have sent, and permanently blocks the username.
    </UserConfirm>
  )
}
