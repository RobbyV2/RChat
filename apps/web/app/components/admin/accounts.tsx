'use client'

import { Name, NameInput } from '../name'
import { handleName, serverCalled } from '../../lib/names'
import { useId, useState } from 'react'
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
import type { AccountServer, AddedServer, IssuedPassword, ServerSummaryLite } from '../../lib/types'
import { Button, Chip, IconButton, ListRow } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { Dialog, FieldError, fieldCls, useCopied } from '../ui'
import { useAccountChanges } from './account_state'
import { useControl } from './config_state'
import { ServerMatches } from './server_matches'
import { Loaded, useAccountRequest } from '../loaded'
import { time } from '../../lib/platform/time'

const now = () => Math.floor(time().now() / 1000)

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
    <Stack gap="lg">
      <Stack gap="md">
        <p className="text-sm text-on-surface-variant">
          <Name of={handleName(username)} look="text-on-surface" /> can sign in with this temporary
          password. It is shown only now.
        </p>
        <div className="rounded-2xl border border-primary bg-primary-container/30">
          <Surface tone="plain" pad="md">
            <Row gap="sm">
              <code
                data-temp-password
                className="streamer min-w-0 flex-1 font-mono text-base break-all text-on-surface select-all"
              >
                {issued.temp_password}
              </code>
              <IconButton
                icon={copied ? Check : Copy}
                label={copied ? 'Copied' : 'Copy the password'}
                size="lg"
                data-icon-only
                onClick={() => void sharing().copyText(issued.temp_password).then(flash)}
              />
            </Row>
          </Surface>
        </div>
        <p className="text-sm text-on-surface-variant">
          {expiryLine(issued.expires_at, now())} {changeLine(mode)}
        </p>
        {failed.length > 0 && (
          <Stack as="ul" gap="2xs">
            {failed.map((s, i) => (
              <li key={`${s.server}:${i}`} className="text-sm break-words text-error">
                Not added to <Name of={serverCalled(s.server)} />: {s.error ?? 'It failed.'}
              </li>
            ))}
          </Stack>
        )}
      </Stack>
      <Row gap="sm" wrap justify="end">
        <Button
          size="md"
          onClick={() =>
            void sharing()
              .copyText(signInDetails(address, username, issued.temp_password))
              .then(flashDetails)
          }
        >
          {detailsCopied ? 'Copied' : 'Copy sign-in details'}
        </Button>
        <Button variant="filled" size="md" onClick={onDone}>
          Done
        </Button>
      </Row>
    </Stack>
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
  const [q, setQ] = useState('')
  return (
    <Stack gap="2xs">
      <Row gap="none">
        <NameInput
          value={q}
          disabled={disabled}
          onChange={e => setQ(e.target.value)}
          placeholder={disabled ? 'The list is full' : 'Add a server by name'}
          aria-label="Add a server"
          className={`${fieldCls} disabled:opacity-50`}
        />
      </Row>
      <ServerMatches
        q={q}
        limit={6}
        row={sv =>
          taken.includes(sv.name) ? null : (
            <ListRow
              key={sv.name}
              variant="card"
              onClick={() => {
                setQ('')
                onPick(sv)
              }}
              streamer
              label={
                <>
                  {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
                </>
              }
            />
          )
        }
      />
    </Stack>
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
  const load = useAccountRequest(async api => (await api.getServer(server)).roles, [server], {
    empty: all => all.length === 0,
  })
  return (
    <Loaded load={load} skeleton={null} empty={null} what="this server's roles">
      {all => (
        <Row role="group" aria-label="Roles" gap="xs" wrap>
          {all.map(role => {
            const on = roles.includes(role.id)
            return (
              <Chip key={role.id} on={on} onClick={() => onChange(toggledRole(roles, role.id))}>
                <span className="streamer">{role.name}</span>
              </Chip>
            )
          })}
        </Row>
      )}
    </Loaded>
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
    <Stack gap="sm">
      {servers.length > 0 && (
        <Stack as="ul" gap="sm">
          {servers.map(entry => (
            <Surface as="li" key={entry.server} tone="base" radius="lg" pad="md" gap="sm">
              <Row gap="sm">
                <Name of={serverCalled(entry.server)} look="min-w-0 flex-1 truncate text-sm" />
                <IconButton
                  icon={X}
                  label="Remove the server"
                  size="lg"
                  data-icon-only
                  onClick={() => onChange(withoutServer(servers, entry.server))}
                />
              </Row>
              <RoleToggles
                server={entry.server}
                roles={entry.roles}
                onChange={roles => onChange(withServer(servers, entry.server, roles))}
              />
            </Surface>
          ))}
        </Stack>
      )}
      <ServerSearch
        taken={servers.map(s => s.server)}
        disabled={servers.length >= ACCOUNT_SERVERS_MAX}
        onPick={sv => onChange(withServer(servers, sv.name))}
      />
    </Stack>
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
      <Stack
        as="form"
        gap="lg"
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
      >
        {!passwords && (
          <Surface tone="error" radius="lg" pad="md">
            <p className="text-sm">Password sign-in is off, so a new account could not sign in.</p>
          </Surface>
        )}
        <Stack gap="xs">
          <label htmlFor={nameId} className={labelCls}>
            Username
          </label>
          <Row gap="none">
            <NameInput
              id={nameId}
              value={form.username}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              onChange={e => setForm({ ...form, username: e.target.value })}
            />
          </Row>
          <FieldError message={shown('username')} />
        </Stack>
        <Stack gap="xs">
          <label htmlFor={displayId} className={labelCls}>
            Display name <span className="font-normal text-on-surface-variant">(optional)</span>
          </label>
          <Row gap="none">
            <NameInput
              id={displayId}
              value={form.displayName}
              autoComplete="off"
              onChange={e => setForm({ ...form, displayName: e.target.value })}
            />
          </Row>
          <FieldError message={shown('displayName')} />
        </Stack>
        <Stack gap="xs">
          <p className={labelCls}>Servers</p>
          {defaults.length > 0 && (
            <p className="text-sm break-words text-on-surface-variant">
              Joins the default servers: <Name of={serverCalled(defaults.join(', '))} />.
            </p>
          )}
          <ServerEntries
            servers={form.servers}
            onChange={servers => setForm({ ...form, servers })}
          />
          <FieldError message={shown('servers')} />
        </Stack>
        <p className="text-sm text-on-surface-variant">{changeLine(mode)}</p>
        <FieldError message={refused} />
        <Row gap="sm" wrap justify="end">
          <Button size="md" onClick={closeDialog}>
            Cancel
          </Button>
          <Button type="submit" variant="filled" size="md" disabled={busy || !passwords}>
            Create account
          </Button>
        </Row>
      </Stack>
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
      <Stack gap="xl">
        <Stack gap="none">
          <p className="text-sm text-on-surface-variant">
            Give <Name of={handleName(username)} /> a new temporary password? Their password stops
            working and they are signed out everywhere. Their backup phrase stays.
          </p>
          <FieldError message={refused} />
        </Stack>
        <Row gap="sm" wrap justify="end">
          <Button size="md" onClick={closeDialog}>
            Cancel
          </Button>
          <Button
            variant="filled-danger"
            size="md"
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
          >
            New password
          </Button>
        </Row>
      </Stack>
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
      <Stack
        as="form"
        gap="lg"
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
      >
        <p className="text-sm text-on-surface-variant">
          Add <Name of={handleName(username)} /> to a server. It works whatever the instance lets
          people join by themselves.
        </p>
        <ServerEntries servers={servers} onChange={next => setServers(next.slice(-1))} />
        <FieldError message={refused} />
        <Row gap="sm" wrap justify="end">
          <Button size="md" onClick={closeDialog}>
            Cancel
          </Button>
          <Button type="submit" variant="filled" size="md" disabled={busy || !entry}>
            Add
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}
