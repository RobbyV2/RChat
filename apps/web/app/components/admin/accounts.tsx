'use client'

import { useEffect, useId, useState } from 'react'
import { Check, Copy, X } from 'lucide-react'
import {
  ACCOUNT_SERVERS_MAX,
  accountFormError,
  accountRequest,
  changeLine,
  emptyAccountForm,
  expiryLine,
  signInDetails,
  toggledRole,
  withServer,
  withoutServer,
  type AccountForm,
} from '../../lib/admin_accounts'
import { listOf } from '../../lib/admin_servers'
import { useAccount } from '../../lib/client/react'
import { sharing } from '../../lib/platform'
import { errorText, useStore } from '../../lib/store'
import type {
  AccountServer,
  AddedServer,
  IssuedPassword,
  Role,
  ServerSummaryLite,
} from '../../lib/types'
import { Dialog, FieldError, filledDangerBtn, iconBtn, useCopied } from '../ui'
import { useAccountChanges } from './account_state'
import { useControl } from './config_state'
import { fieldCls, filledBtn, textBtn } from './touch'

const now = () => Math.floor(Date.now() / 1000)

// A temporary password, shown once. It lives in this component only: closing the dialog
// forgets it.
export function PasswordReveal({
  username,
  issued,
  servers = [],
  onDone,
}: {
  username: string
  issued: IssuedPassword
  servers?: AddedServer[]
  onDone: () => void
}) {
  const { conn, shareOrigin } = useAccount()
  const address = conn.info?.public_url ?? shareOrigin
  const [copied, flash] = useCopied()
  const [detailsCopied, flashDetails] = useCopied()
  const mode = useStore(s => s.settings.password_change)
  const failed = servers.filter(s => !s.ok)
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-on-surface-variant">
        <span className="streamer text-on-surface">{username}</span> can sign in with this temporary
        password. It is shown only now.
      </p>
      <div className="flex items-center gap-2 rounded-2xl border border-primary bg-primary-container/30 p-3">
        <code
          data-temp-password
          className="streamer min-w-0 flex-1 font-mono text-base break-all text-on-surface select-all"
        >
          {issued.temp_password}
        </code>
        <button
          type="button"
          data-icon-only
          title={copied ? 'Copied' : 'Copy the password'}
          aria-label={copied ? 'Copied' : 'Copy the password'}
          onClick={() => void sharing().copyText(issued.temp_password).then(flash)}
          className={`${iconBtn} flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center md:h-9 md:w-9`}
        >
          {copied ? <Check size={18} /> : <Copy size={18} />}
        </button>
      </div>
      <p className="text-sm text-on-surface-variant">
        {expiryLine(issued.expires_at, now())} {changeLine(mode)}
      </p>
      {failed.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm text-error">
          {failed.map((s, i) => (
            <li key={`${s.server}:${i}`} className="break-words">
              Not added to <span className="streamer">{s.server}</span>: {s.error ?? 'It failed.'}
            </li>
          ))}
        </ul>
      )}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <button
          type="button"
          onClick={() =>
            void sharing()
              .copyText(signInDetails(address, username, issued.temp_password))
              .then(flashDetails)
          }
          className={`${textBtn} cursor-pointer`}
        >
          {detailsCopied ? 'Copied' : 'Copy sign-in details'}
        </button>
        <button type="button" onClick={onDone} className={`${filledBtn} cursor-pointer`}>
          Done
        </button>
      </div>
    </div>
  )
}

// A server by name, found among every server of the instance.
function ServerSearch({
  taken,
  disabled,
  onPick,
}: {
  taken: string[]
  disabled: boolean
  onPick: (server: ServerSummaryLite) => void
}) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const setError = useStore(s => s.setError)
  const [q, setQ] = useState('')
  const [found, setFound] = useState<ServerSummaryLite[]>([])
  useEffect(() => {
    const text = q.trim()
    let live = true
    const t = setTimeout(() => {
      if (text === '') return setFound([])
      api
        .adminServers(null, text)
        .then(page => {
          if (live) setFound(page.items.slice(0, 6))
        })
        .catch(inSession((e: unknown) => setError(errorText(e))))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [q, setError])
  const open = found.filter(sv => !taken.includes(sv.name))
  return (
    <div className="flex flex-col gap-1">
      <div className="flex">
        <input
          value={q}
          disabled={disabled}
          onChange={e => setQ(e.target.value)}
          placeholder={disabled ? 'The list is full' : 'Add a server by name'}
          aria-label="Add a server"
          className={`${fieldCls} streamer disabled:opacity-50`}
        />
      </div>
      {open.length > 0 && (
        <ul className="flex flex-col gap-1">
          {open.map(sv => (
            <li key={sv.name}>
              <button
                type="button"
                onClick={() => {
                  setQ('')
                  setFound([])
                  onPick(sv)
                }}
                className="streamer flex min-h-11 w-full min-w-0 cursor-pointer items-center rounded-xl bg-surface-container px-3 py-2 text-left text-sm hover:bg-surface-container-highest md:min-h-0"
              >
                <span className="min-w-0 truncate">
                  {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

// The roles of `server`, each a toggle.
function RoleToggles({
  server,
  roles,
  onChange,
}: {
  server: string
  roles: number[]
  onChange: (roles: number[]) => void
}) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const setError = useStore(s => s.setError)
  const [all, setAll] = useState<Role[] | null>(null)
  useEffect(() => {
    let live = true
    api
      .getServer(server)
      .then(detail => {
        if (live) setAll(detail.roles)
      })
      .catch(inSession((e: unknown) => setError(errorText(e))))
    return () => {
      live = false
    }
  }, [server, setError])
  if (all === null || all.length === 0) return null
  return (
    <div role="group" aria-label="Roles" className="flex flex-wrap gap-1.5">
      {all.map(role => {
        const on = roles.includes(role.id)
        return (
          <button
            key={role.id}
            type="button"
            aria-pressed={on}
            onClick={() => onChange(toggledRole(roles, role.id))}
            className={`streamer min-h-11 max-w-full cursor-pointer truncate rounded-full border px-3 py-1.5 text-sm md:min-h-0 ${
              on
                ? 'border-transparent bg-secondary-container text-on-secondary-container'
                : 'border-outline text-on-surface-variant hover:bg-surface-container-highest'
            }`}
          >
            {role.name}
          </button>
        )
      })}
    </div>
  )
}

// The servers an account is added to, each with its roles.
function ServerEntries({
  servers,
  onChange,
}: {
  servers: AccountServer[]
  onChange: (servers: AccountServer[]) => void
}) {
  return (
    <div className="flex flex-col gap-2">
      {servers.length > 0 && (
        <ul className="flex flex-col gap-2">
          {servers.map(entry => (
            <li
              key={entry.server}
              className="flex flex-col gap-2 rounded-xl bg-surface-container px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2">
                <span className="streamer min-w-0 flex-1 truncate text-sm">{entry.server}</span>
                <button
                  type="button"
                  data-icon-only
                  title="Remove the server"
                  aria-label="Remove the server"
                  onClick={() => onChange(withoutServer(servers, entry.server))}
                  className={`${iconBtn} flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center md:h-9 md:w-9`}
                >
                  <X size={18} />
                </button>
              </div>
              <RoleToggles
                server={entry.server}
                roles={entry.roles}
                onChange={roles => onChange(withServer(servers, entry.server, roles))}
              />
            </li>
          ))}
        </ul>
      )}
      <ServerSearch
        taken={servers.map(s => s.server)}
        disabled={servers.length >= ACCOUNT_SERVERS_MAX}
        onPick={sv => onChange(withServer(servers, sv.name))}
      />
    </div>
  )
}

const labelCls = 'text-sm font-medium text-on-surface'

// Makes an account, then shows its temporary password once.
export function CreateAccountDialog() {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const closeDialog = useStore(s => s.closeDialog)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const passwords = useStore(s => s.settings.password_login)
  const mode = useStore(s => s.settings.password_change)
  const defaults = listOf(useControl('default_servers')?.value)
  const changed = useAccountChanges(s => s.changed)
  const [form, setForm] = useState<AccountForm>(emptyAccountForm)
  const [tried, setTried] = useState(false)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [made, setMade] = useState<{
    username: string
    issued: IssuedPassword
    servers: AddedServer[]
  } | null>(null)
  const nameId = useId()
  const displayId = useId()
  const wrong = accountFormError(form)
  const shown = (field: 'username' | 'displayName' | 'servers') =>
    tried && wrong?.field === field ? wrong.message : null
  if (made)
    return (
      <Dialog title="Account Created" onClose={closeDialog} full>
        <PasswordReveal
          username={made.username}
          issued={made.issued}
          servers={made.servers}
          onDone={closeDialog}
        />
      </Dialog>
    )
  return (
    <Dialog title="Create Account" onClose={closeDialog} full>
      <form
        onSubmit={e => {
          e.preventDefault()
          setTried(true)
          if (wrong || busy) return
          setBusy(true)
          setRefused(null)
          api
            .adminCreateUser(accountRequest(form))
            .then(created => {
              setMade({
                username: created.user.username,
                issued: { temp_password: created.temp_password, expires_at: created.expires_at },
                servers: created.servers,
              })
              changed()
              void loadAdminOverview()
            })
            .catch(inSession((e: unknown) => setRefused(errorText(e))))
            .finally(() => setBusy(false))
        }}
        className="flex flex-col gap-4"
      >
        {!passwords && (
          <p className="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container">
            Password sign-in is off, so a new account could not sign in.
          </p>
        )}
        <div className="flex flex-col gap-1.5">
          <label htmlFor={nameId} className={labelCls}>
            Username
          </label>
          <div className="flex">
            <input
              id={nameId}
              value={form.username}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={e => setForm({ ...form, username: e.target.value })}
              className={`${fieldCls} streamer`}
            />
          </div>
          <FieldError message={shown('username')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <label htmlFor={displayId} className={labelCls}>
            Display name <span className="font-normal text-on-surface-variant">(optional)</span>
          </label>
          <div className="flex">
            <input
              id={displayId}
              value={form.displayName}
              autoComplete="off"
              onChange={e => setForm({ ...form, displayName: e.target.value })}
              className={`${fieldCls} streamer`}
            />
          </div>
          <FieldError message={shown('displayName')} />
        </div>
        <div className="flex flex-col gap-1.5">
          <p className={labelCls}>Servers</p>
          {defaults.length > 0 && (
            <p className="text-sm break-words text-on-surface-variant">
              Joins the default servers: <span className="streamer">{defaults.join(', ')}</span>.
            </p>
          )}
          <ServerEntries
            servers={form.servers}
            onChange={servers => setForm({ ...form, servers })}
          />
          <FieldError message={shown('servers')} />
        </div>
        <p className="text-sm text-on-surface-variant">{changeLine(mode)}</p>
        <FieldError message={refused} />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={closeDialog} className={`${textBtn} cursor-pointer`}>
            Cancel
          </button>
          <button
            disabled={busy || !passwords}
            className={`${filledBtn} cursor-pointer disabled:cursor-default`}
          >
            Create account
          </button>
        </div>
      </form>
    </Dialog>
  )
}

// Asks before replacing an account's password, then shows the new temporary one once.
export function TempPasswordDialog({ username }: { username: string }) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const closeDialog = useStore(s => s.closeDialog)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const changed = useAccountChanges(s => s.changed)
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const [issued, setIssued] = useState<IssuedPassword | null>(null)
  if (issued)
    return (
      <Dialog title="New Temporary Password" onClose={closeDialog}>
        <PasswordReveal username={username} issued={issued} onDone={closeDialog} />
      </Dialog>
    )
  return (
    <Dialog title="New Temporary Password" onClose={closeDialog}>
      <p className="text-sm text-on-surface-variant">
        Give <span className="streamer">{username}</span> a new temporary password? Their password
        stops working and they are signed out everywhere. Their backup phrase stays.
      </p>
      <FieldError message={refused} />
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        <button type="button" onClick={closeDialog} className={`${textBtn} cursor-pointer`}>
          Cancel
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => {
            setBusy(true)
            setRefused(null)
            api
              .adminResetPassword(username)
              .then(made => {
                setIssued(made)
                changed()
                void loadAdminOverview()
              })
              .catch(inSession((e: unknown) => setRefused(errorText(e))))
              .finally(() => setBusy(false))
          }}
          className={`${filledDangerBtn} min-h-11 cursor-pointer disabled:opacity-40 md:min-h-0`}
        >
          New password
        </button>
      </div>
    </Dialog>
  )
}

// Adds an account to one server, with roles.
export function AddToServerDialog({ username }: { username: string }) {
  const {
    api,
    lifetime: { inSession },
  } = useAccount()
  const closeDialog = useStore(s => s.closeDialog)
  const showToast = useStore(s => s.showToast)
  const changed = useAccountChanges(s => s.changed)
  const [servers, setServers] = useState<AccountServer[]>([])
  const [busy, setBusy] = useState(false)
  const [refused, setRefused] = useState<string | null>(null)
  const entry = servers[0]
  return (
    <Dialog title="Add to Server" onClose={closeDialog} full>
      <form
        onSubmit={e => {
          e.preventDefault()
          if (!entry || busy) return
          setBusy(true)
          setRefused(null)
          api
            .adminAddToServer(username, entry)
            .then(() => {
              changed()
              showToast('Added to the server')
              closeDialog()
            })
            .catch(inSession((e: unknown) => setRefused(errorText(e))))
            .finally(() => setBusy(false))
        }}
        className="flex flex-col gap-4"
      >
        <p className="text-sm text-on-surface-variant">
          Add <span className="streamer">{username}</span> to a server. It works whatever the
          instance lets people join by themselves.
        </p>
        <ServerEntries servers={servers} onChange={next => setServers(next.slice(-1))} />
        <FieldError message={refused} />
        <div className="flex flex-wrap justify-end gap-2">
          <button type="button" onClick={closeDialog} className={`${textBtn} cursor-pointer`}>
            Cancel
          </button>
          <button
            disabled={busy || !entry}
            className={`${filledBtn} cursor-pointer disabled:cursor-default`}
          >
            Add
          </button>
        </div>
      </form>
    </Dialog>
  )
}
