'use client'

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react'
import { Hash, Trash2, X } from 'lucide-react'
import * as api from '../lib/api'
import {
  errorText,
  revokeAdminFor,
  roleMenuItems,
  serverAdminPerms,
  useStore,
  type ConfirmRequest,
} from '../lib/store'
import { SLOWMODE_MAX, passwordDone, passwordPrompt } from '../lib/rules'
import { inviteUrl } from '../lib/invite'
import { ALL_PERMS, Perm, hasPerm } from '../lib/types'
import type { Channel, ChannelPerm, Member, Role } from '../lib/types'
import { UserAvatar } from './user_avatar'

export const fieldCls =
  'min-w-0 flex-1 rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm'
export const filledBtn =
  'rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary hover:opacity-90 disabled:opacity-40'
export const textBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-primary hover:bg-surface-container-highest'
export const dangerBtn =
  'rounded-full px-3 py-1.5 text-sm font-medium text-error hover:bg-surface-container-highest disabled:opacity-40'
export const sectionCls =
  'pb-2 pt-5 text-xs font-medium uppercase tracking-wide text-on-surface-variant first:pt-0'

export function FieldError({ message }: { message: string | null }) {
  if (!message) return null
  return (
    <p role="alert" className="pt-1.5 text-xs text-error">
      {message}
    </p>
  )
}

export type EscapeLayer = 'panel' | 'dialog' | 'confirm'

const covered = (layer: EscapeLayer) => {
  const s = useStore.getState()
  if (s.contextMenu) return true
  if (layer === 'confirm') return false
  if (s.confirm) return true
  if (layer === 'dialog') return false
  return (
    s.activeDialog !== null ||
    s.profile !== null ||
    s.invite !== null ||
    document.querySelector('[aria-modal="true"]') !== null
  )
}

export function useEscape(onEscape: () => void, layer: EscapeLayer = 'dialog') {
  const ref = useRef(onEscape)
  useEffect(() => {
    ref.current = onEscape
  })
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.isComposing && !covered(layer)) ref.current()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [layer])
}

export function useBackdrop(onClose: () => void) {
  const pressed = useRef(false)
  return {
    onMouseDown: (e: React.MouseEvent) => {
      pressed.current = e.target === e.currentTarget
    },
    onClick: (e: React.MouseEvent) => {
      const hit = pressed.current && e.target === e.currentTarget
      pressed.current = false
      if (hit) onClose()
    },
  }
}

export function Sentinel({ onVisible }: { onVisible: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const observer = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) onVisible()
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [onVisible])
  return <div ref={ref} className="h-px" />
}

export function Dialog({
  title,
  onClose,
  children,
  full = false,
  layer = 'dialog',
}: {
  title: string
  onClose: () => void
  children: ReactNode
  full?: boolean
  layer?: EscapeLayer
}) {
  const titleId = useId()
  const backdrop = useBackdrop(onClose)
  useEscape(onClose, layer)
  return (
    <div
      className={`fixed inset-x-0 top-0 ${layer === 'confirm' ? 'z-50' : 'z-40'} flex h-app items-center justify-center bg-scrim/60 ${full ? 'px-safe sm:px-safe-4 sm:py-4' : 'px-safe-4 py-4'}`}
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={`w-full overflow-y-auto bg-surface-container-high p-6 shadow-elevation-3 ${
          full
            ? 'h-full max-h-none sm:h-auto sm:max-h-[min(85vh,100%)] sm:max-w-lg sm:rounded-2xl'
            : 'max-h-[min(85vh,100%)] max-w-lg rounded-2xl'
        }`}
      >
        <div
          className={`flex items-center justify-between ${
            full
              ? 'sticky -top-6 z-10 -mx-6 -mt-6 mb-4 bg-surface-container-high px-6 py-4'
              : 'mb-4'
          }`}
        >
          <h2 id={titleId} className="text-lg font-medium text-on-surface">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            title="Close"
            className="rounded-full p-1.5 text-on-surface-variant hover:bg-surface-container-highest"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

const PERM_ITEMS: { label: string; bit: number }[] = [
  { label: 'Manage channels', bit: Perm.ManageChannels },
  { label: 'Delete messages', bit: Perm.DeleteMessages },
  { label: 'Kick', bit: Perm.Kick },
  { label: 'Delete server', bit: Perm.DeleteServer },
  { label: 'Manage admins', bit: Perm.ManageAdmins },
]

function PermChecks({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {PERM_ITEMS.map(({ label, bit }) => (
        <label key={bit} className="flex items-center gap-1.5 text-sm">
          <input
            type="checkbox"
            checked={hasPerm(value, bit)}
            onChange={() => onChange(value ^ bit)}
            className="accent-primary"
          />
          {label}
        </label>
      ))}
    </div>
  )
}

function ColorSwatch({
  initial,
  onCommit,
}: {
  initial: string
  onCommit: (color: string) => void
}) {
  const [color, setColor] = useState(initial)
  useEffect(() => setColor(initial), [initial])
  return (
    <input
      type="color"
      value={color}
      title="Role color"
      onChange={e => setColor(e.target.value)}
      onBlur={() => {
        if (color !== initial) onCommit(color)
      }}
      className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5"
    />
  )
}

function RoleRow({ server, role, refresh }: { server: string; role: Role; refresh?: () => void }) {
  const updateRole = useStore(s => s.updateRole)
  const deleteRole = useStore(s => s.deleteRole)
  const [name, setName] = useState(role.name)
  useEffect(() => setName(role.name), [role.name])
  const after = () => refresh?.()
  return (
    <div className="space-y-1.5 rounded-xl bg-surface-container p-2">
      <div className="flex items-center gap-2">
        <ColorSwatch
          initial={role.color}
          onCommit={color => void updateRole(server, role.id, { color }).then(after)}
        />
        <form
          onSubmit={e => {
            e.preventDefault()
            const trimmed = name.trim()
            if (trimmed && trimmed !== role.name)
              void updateRole(server, role.id, { name: trimmed }).then(after)
          }}
          className="flex min-w-0 flex-1 gap-2"
        >
          <input
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Role name"
            className={fieldCls}
          />
          <button className={textBtn}>Rename</button>
        </form>
        <button
          onClick={() => void deleteRole(server, role.id).then(after)}
          aria-label={`Delete ${role.name}`}
          title={`Delete ${role.name}`}
          className={dangerBtn}
        >
          <Trash2 size={16} />
        </button>
      </div>
      <PermChecks
        value={role.perms}
        onChange={v => void updateRole(server, role.id, { perms: v }).then(after)}
      />
    </div>
  )
}

export function RolesEditor({
  server,
  roles,
  refresh,
}: {
  server: string
  roles: Role[]
  refresh?: () => void
}) {
  return (
    <div className="space-y-2">
      {roles.map(r => (
        <RoleRow key={r.id} server={server} role={r} refresh={refresh} />
      ))}
      <RoleCreate server={server} refresh={refresh} />
    </div>
  )
}

function RoleCreate({ server, refresh }: { server: string; refresh?: () => void }) {
  const createRole = useStore(s => s.createRole)
  const [name, setName] = useState('')
  const [color, setColor] = useState('#7c4dff')
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        void createRole(server, { name: trimmed, color, perms: 0 }).then(() => {
          setName('')
          refresh?.()
        })
      }}
      className="flex items-center gap-2"
    >
      <input
        type="color"
        value={color}
        title="Role color"
        onChange={e => setColor(e.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5"
      />
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="New role"
        className={fieldCls}
      />
      <button className={textBtn}>Add</button>
    </form>
  )
}

export function ChannelPermsEditor({
  channelId,
  server,
  roles,
}: {
  channelId: number
  server: string
  roles: Role[]
}) {
  const members = useStore(s => s.members[server]?.list)
  const setChannelPerm = useStore(s => s.setChannelPerm)
  const clearChannelPerm = useStore(s => s.clearChannelPerm)
  const setError = useStore(s => s.setError)
  const [rows, setRows] = useState<ChannelPerm[]>([])
  const [subject, setSubject] = useState('')

  const reload = useCallback(
    () =>
      api
        .channelPerms(channelId)
        .then(setRows)
        .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e))),
    [channelId, setError]
  )
  useEffect(() => {
    void reload()
  }, [reload])

  const save = (perm: ChannelPerm) => void setChannelPerm(channelId, perm).then(reload)
  const label = (subj: string) =>
    subj.startsWith('u:') ? subj.slice(2) : (roles.find(r => `r:${r.id}` === subj)?.name ?? subj)
  const flag = (
    perm: ChannelPerm,
    key: 'can_view' | 'can_send' | 'can_read_history',
    text: string
  ) => (
    <label className="flex items-center gap-1 text-xs">
      <input
        type="checkbox"
        checked={perm[key]}
        onChange={() => save({ ...perm, [key]: !perm[key] })}
        className="accent-primary"
      />
      {text}
    </label>
  )

  return (
    <div className="mt-1.5 space-y-1.5 rounded-xl bg-surface-container-low p-2">
      {rows.length === 0 && (
        <p className="text-xs text-on-surface-variant">
          No overrides. The channel is visible to everyone.
        </p>
      )}
      {rows.map(perm => (
        <div key={perm.subject} className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="streamer min-w-0 flex-1 truncate text-sm">{label(perm.subject)}</span>
          {flag(perm, 'can_view', 'View')}
          {flag(perm, 'can_send', 'Send')}
          {flag(perm, 'can_read_history', 'History')}
          <button
            onClick={() => void clearChannelPerm(channelId, perm.subject).then(reload)}
            aria-label={`Clear ${label(perm.subject)}`}
            title="Clear override"
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest hover:text-error"
          >
            <X size={14} />
          </button>
        </div>
      ))}
      <div className="flex gap-2">
        <select
          value={subject}
          onChange={e => setSubject(e.target.value)}
          title="Add user or role"
          className={fieldCls}
        >
          <option value="">Add user or role…</option>
          {roles.length > 0 && (
            <optgroup label="Roles">
              {roles.map(r => (
                <option key={r.id} value={`r:${r.id}`}>
                  {r.name}
                </option>
              ))}
            </optgroup>
          )}
          <optgroup label="Members">
            {(members ?? []).map(m => (
              <option key={m.username} value={`u:${m.username}`}>
                {m.display_name}
              </option>
            ))}
          </optgroup>
        </select>
        <button
          onClick={() => {
            if (!subject || rows.some(r => r.subject === subject)) return
            save({ subject, can_view: true, can_send: true, can_read_history: true })
            setSubject('')
          }}
          className={textBtn}
        >
          Add
        </button>
      </div>
    </div>
  )
}

export function ChannelControls({
  server,
  channel,
  roles,
  refresh,
  lead,
}: {
  server: string
  channel: Channel
  roles: Role[]
  refresh?: () => void
  lead?: ReactNode
}) {
  const setSlowmode = useStore(s => s.setSlowmode)
  const [slow, setSlow] = useState(String(channel.slowmode_seconds))
  const [open, setOpen] = useState(false)
  useEffect(() => setSlow(String(channel.slowmode_seconds)), [channel.slowmode_seconds])
  return (
    <div className="rounded-xl px-2 py-1.5">
      <div className="flex flex-wrap items-center gap-2">
        {lead ?? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-sm">
            <Hash size={14} className="shrink-0 text-on-surface-variant" />
            <span className="truncate">{channel.name}</span>
          </span>
        )}
        {channel.kind === 'text' && (
          <form
            onSubmit={e => {
              e.preventDefault()
              const n = Number(slow)
              if (Number.isInteger(n) && n !== channel.slowmode_seconds)
                void setSlowmode(channel.id, n).then(() => refresh?.())
            }}
            className="flex items-center gap-1.5"
          >
            <label
              title={`0 to ${SLOWMODE_MAX} seconds`}
              className="flex items-center gap-1.5 text-xs text-on-surface-variant"
            >
              Slow mode (s)
              <input
                value={slow}
                onChange={e => setSlow(e.target.value)}
                inputMode="numeric"
                className="w-16 rounded-lg border border-outline bg-transparent px-2 py-1 text-base text-on-surface outline-none focus:border-primary md:text-sm"
              />
            </label>
            <button className={textBtn}>Set</button>
          </form>
        )}
        <button onClick={() => setOpen(!open)} className={textBtn}>
          {open ? 'Hide perms' : 'Perms'}
        </button>
      </div>
      {open && <ChannelPermsEditor channelId={channel.id} server={server} roles={roles} />}
    </div>
  )
}

export function ServerPasswordField({
  server,
  hasPassword,
  canRemove,
  refresh,
}: {
  server: string
  hasPassword: boolean
  canRemove: boolean
  refresh?: () => void
}) {
  const setServerPassword = useStore(s => s.setServerPassword)
  const askConfirm = useStore(s => s.askConfirm)
  const siteAdmin = useStore(s => s.me?.is_site_admin ?? false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  return (
    <>
      <p className={sectionCls}>Password</p>
      <form
        onSubmit={e => {
          e.preventDefault()
          const next = password.trim()
          setError(null)
          setDone(null)
          const prompt = passwordPrompt(hasPassword, next, canRemove, siteAdmin)
          askConfirm({
            ...prompt,
            action: choice => {
              const members = choice === 'remove' ? 'remove' : 'keep'
              setServerPassword(server, next, members).then(
                res => {
                  setPassword('')
                  setDone(passwordDone(prompt.confirm, members, res.removed, res.kept))
                  refresh?.()
                },
                (err: unknown) => setError(errorText(err))
              )
            },
          })
        }}
        className="flex gap-2"
      >
        <input
          type="password"
          value={password}
          onChange={e => {
            setPassword(e.target.value)
            setDone(null)
          }}
          placeholder={hasPassword ? 'New password (blank clears)' : 'Set a join password'}
          className={fieldCls}
        />
        <button disabled={!password.trim() && !hasPassword} className={filledBtn}>
          {password.trim() ? 'Set' : hasPassword ? 'Clear' : 'Set'}
        </button>
      </form>
      <FieldError message={error} />
      {done && (
        <p role="status" className="pt-1.5 text-xs text-on-surface">
          {done}
        </p>
      )}
      <p className="pt-1.5 text-xs text-on-surface-variant">
        {hasPassword
          ? 'Joining requires the password; guests cannot view this server.'
          : 'Anyone can join with the server name.'}
      </p>
    </>
  )
}

export function InviteLinkField({ server, hasPassword }: { server: string; hasPassword: boolean }) {
  const [password, setPassword] = useState('')
  const [copied, setCopied] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const link = inviteUrl(server, hasPassword ? password : null)
  const withPassword = hasPassword && password.trim() !== ''
  return (
    <>
      <p className={sectionCls}>Invite</p>
      <div className="flex gap-2">
        <input
          readOnly
          value={link}
          aria-label="Invite link"
          onFocus={e => e.currentTarget.select()}
          className={`${fieldCls} streamer text-on-surface-variant`}
        />
        <button
          onClick={() => {
            setError(null)
            navigator.clipboard.writeText(link).then(
              () => setCopied(link),
              (err: unknown) => setError(errorText(err))
            )
          }}
          className={filledBtn}
        >
          {copied === link ? 'Copied' : 'Copy'}
        </button>
      </div>
      <FieldError message={error} />
      {hasPassword && (
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          placeholder="Server password (optional)"
          autoComplete="off"
          aria-label="Include the server password in the link"
          className={`${fieldCls} mt-2 w-full`}
        />
      )}
      <p className="pt-1.5 text-xs text-on-surface-variant">
        {withPassword
          ? 'Anyone with this link joins without typing the password.'
          : hasPassword
            ? 'People with this link are asked for the password. Type it above to include it in the link.'
            : 'Paste this link in a chat to show an invite card.'}
      </p>
    </>
  )
}

export function AdminPermsEditor({
  server,
  username,
  perms,
  refresh,
}: {
  server: string
  username: string
  perms: number
  refresh?: () => void
}) {
  const setAdminPerms = useStore(s => s.setAdminPerms)
  const [lastBlocked, setLastBlocked] = useState(false)
  return (
    <>
      <PermChecks
        value={perms === 0 ? ALL_PERMS : perms}
        onChange={v => {
          setLastBlocked(v === 0)
          if (v !== 0)
            void setAdminPerms(server, username, v === ALL_PERMS ? 0 : v).then(() => refresh?.())
        }}
      />
      {lastBlocked && (
        <p className="pt-1.5 text-xs text-on-surface-variant">
          An admin keeps at least one permission. To take every permission away, remove them as
          admin instead.
        </p>
      )}
    </>
  )
}

export function BanList({ server }: { server: string }) {
  const cache = useStore(s => s.bans[server])
  const loadBans = useStore(s => s.loadBans)
  const unbanMember = useStore(s => s.unbanMember)
  useEffect(() => {
    void loadBans(server, true)
  }, [server, loadBans])
  const more = useCallback(() => void loadBans(server), [server, loadBans])
  const list = cache?.list ?? []
  return (
    <div className="space-y-1">
      {list.map(b => (
        <div key={b.username} className="flex items-center gap-2 rounded-xl px-2 py-1.5">
          <UserAvatar
            username={b.username}
            avatarKind={b.avatar_kind}
            avatarColor={b.avatar_color}
            size={28}
          />
          <span className="min-w-0 flex-1 truncate text-sm">
            <span className="streamer">{b.display_name}</span>
            <span className="text-xs text-on-surface-variant">
              {' '}
              · banned {new Date(b.banned_at * 1000).toLocaleDateString()}
            </span>
          </span>
          <button onClick={() => void unbanMember(server, b.username)} className={textBtn}>
            Unban
          </button>
        </div>
      ))}
      {cache && !cache.loading && list.length === 0 && (
        <p className="px-2 text-sm text-on-surface-variant">No one is banned.</p>
      )}
      {(cache?.hasMore ?? false) && <Sentinel key={list.length} onVisible={more} />}
    </div>
  )
}

export function ConfirmDialog() {
  const request = useStore(s => s.confirm)
  const seq = useStore(s => s.confirmSeq)
  const closeConfirm = useStore(s => s.closeConfirm)
  if (!request) return null
  return <ConfirmBody key={seq} request={request} onClose={closeConfirm} />
}

function ConfirmBody({ request, onClose }: { request: ConfirmRequest; onClose: () => void }) {
  const { title, body, confirm, action, choices } = request
  const name = useId()
  const [choice, setChoice] = useState(choices?.[0]?.value ?? '')
  const danger = choices?.find(c => c.value === choice)?.danger ?? true
  return (
    <Dialog title={title} onClose={onClose} layer="confirm">
      <p className="text-sm text-on-surface-variant">{body}</p>
      {choices && (
        <fieldset className="mt-4 space-y-2">
          <legend className="sr-only">{title}</legend>
          {choices.map(c => (
            <label
              key={c.value}
              className={`flex cursor-pointer gap-3 rounded-xl border px-3 py-2.5 ${
                c.value === choice
                  ? 'border-primary bg-surface-container-highest'
                  : 'border-outline-variant hover:bg-surface-container-highest'
              }`}
            >
              <input
                type="radio"
                name={name}
                value={c.value}
                checked={c.value === choice}
                onChange={() => setChoice(c.value)}
                className="mt-0.5 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium text-on-surface">{c.label}</span>
                <span className="block pt-0.5 text-xs text-on-surface-variant">{c.detail}</span>
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div className="mt-6 flex justify-end gap-2">
        <button autoFocus onClick={onClose} className={textBtn}>
          Cancel
        </button>
        <button
          onClick={() => {
            onClose()
            action(choice)
          }}
          className={
            danger
              ? 'rounded-full bg-error px-4 py-2 text-sm font-medium text-on-error hover:opacity-90'
              : filledBtn
          }
        >
          {confirm}
        </button>
      </div>
    </Dialog>
  )
}

export default function ServerSettings() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'server_settings' ? <Settings server={dialog.server} /> : null
}

function Settings({ server }: { server: string }) {
  const detail = useStore(s => s.servers[server])
  const me = useStore(s => s.me)
  const perms = useStore(s => serverAdminPerms(s, server))
  const cache = useStore(s => s.members[server])
  const loadMembers = useStore(s => s.loadMembers)
  const closeDialog = useStore(s => s.closeDialog)
  const renameServer = useStore(s => s.renameServer)
  const deleteServer = useStore(s => s.deleteServer)
  const askConfirm = useStore(s => s.askConfirm)
  const grantAdmin = useStore(s => s.grantAdmin)
  const openContextMenu = useStore(s => s.openContextMenu)
  const [name, setName] = useState(detail?.display_name ?? '')
  const [renameError, setRenameError] = useState<string | null>(null)
  const [editingAdmin, setEditingAdmin] = useState<string | null>(null)
  useEffect(() => {
    void loadMembers(server)
  }, [server, loadMembers])
  const more = useCallback(() => void loadMembers(server), [server, loadMembers])
  if (!detail || !me || perms === 0) return null
  const loaded = cache?.list ?? []
  const admins = loaded.filter(m => m.is_admin)
  const others = loaded.filter(m => !m.is_admin)

  const rolesButton = (m: Member) =>
    detail.roles.length > 0 && hasPerm(perms, Perm.ManageAdmins) ? (
      <button
        onClick={e => openContextMenu(e.clientX, e.clientY, roleMenuItems(server, m.username))}
        className={textBtn}
      >
        Roles
      </button>
    ) : null

  const memberRow = (m: Member, action: ReactNode, extra?: ReactNode) => (
    <div key={m.username} className="rounded-xl px-2 py-1.5">
      <div className="flex items-center gap-2">
        <UserAvatar
          username={m.username}
          avatarKind={m.avatar_kind}
          avatarColor={m.avatar_color}
          size={28}
        />
        <span className="streamer min-w-0 flex-1 truncate text-sm">{m.display_name}</span>
        {rolesButton(m)}
        {action}
      </div>
      {extra}
    </div>
  )

  return (
    <Dialog full title="Server Settings" onClose={closeDialog}>
      <InviteLinkField server={server} hasPassword={detail.has_password} />
      {server !== 'rchat' && hasPerm(perms, Perm.DeleteServer) && (
        <>
          <p className={sectionCls}>Rename Server</p>
          <form
            onSubmit={e => {
              e.preventDefault()
              const trimmed = name.trim()
              if (!trimmed) return
              setRenameError(null)
              renameServer(server, trimmed).then(closeDialog, (err: unknown) =>
                setRenameError(errorText(err))
              )
            }}
            className="flex gap-2"
          >
            <input
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="Server name"
              className={`${fieldCls} streamer`}
            />
            <button className={filledBtn}>Rename</button>
          </form>
          <FieldError message={renameError} />
          <ServerPasswordField
            server={server}
            hasPassword={detail.has_password}
            canRemove={hasPerm(perms, Perm.Kick)}
          />
          <p className={sectionCls}>Delete Server</p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p className="min-w-48 flex-1 text-xs text-on-surface-variant">
              Deletes the server with all of its channels and messages for everyone. This cannot be
              undone.
            </p>
            <button
              onClick={() =>
                askConfirm({
                  title: 'Delete Server',
                  body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
                  confirm: 'Delete',
                  action: () => {
                    closeDialog()
                    void deleteServer(server)
                  },
                })
              }
              className="rounded-full border border-error px-4 py-2 text-sm font-medium text-error hover:bg-error-container hover:text-on-error-container"
            >
              Delete server
            </button>
          </div>
        </>
      )}
      {hasPerm(perms, Perm.ManageAdmins) && (
        <>
          <p className={sectionCls}>Roles</p>
          <RolesEditor server={server} roles={detail.roles} />
        </>
      )}
      {hasPerm(perms, Perm.ManageChannels) && (
        <>
          <p className={sectionCls}>Channels</p>
          {detail.channels.map(c => (
            <ChannelControls key={c.id} server={server} channel={c} roles={detail.roles} />
          ))}
        </>
      )}
      {hasPerm(perms, Perm.Kick) && (
        <>
          <p className={sectionCls}>Bans</p>
          <BanList server={server} />
        </>
      )}
      {hasPerm(perms, Perm.ManageAdmins) && (
        <>
          <p className={sectionCls}>Admins</p>
          {admins.map(m =>
            memberRow(
              m,
              <>
                <button
                  onClick={() => setEditingAdmin(editingAdmin === m.username ? null : m.username)}
                  className={textBtn}
                >
                  Perms
                </button>
                <button onClick={() => revokeAdminFor(server, m.username)} className={dangerBtn}>
                  Remove
                </button>
              </>,
              editingAdmin === m.username && (
                <div className="mt-1.5 pl-9">
                  <AdminPermsEditor server={server} username={m.username} perms={m.perms} />
                </div>
              )
            )
          )}
          <p className={sectionCls}>Members</p>
          {others.length ? (
            others.map(m =>
              memberRow(
                m,
                <button onClick={() => void grantAdmin(server, m.username)} className={textBtn}>
                  Make Admin
                </button>
              )
            )
          ) : (
            <p className="px-2 text-sm text-on-surface-variant">Everyone here is an admin.</p>
          )}
        </>
      )}
      {(cache?.hasMore ?? false) && <Sentinel key={loaded.length} onVisible={more} />}
    </Dialog>
  )
}
