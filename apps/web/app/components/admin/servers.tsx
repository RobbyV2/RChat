'use client'
import { ask, sendTo } from '../../lib/asks'
import { Name, NameInput } from '../name'
import { serverCalled, serverName } from '../../lib/names'
import { useAccount } from '../../lib/client/react'
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronUp, X } from 'lucide-react'
import { controlOf } from '../../lib/admin_config'
import { adminRow } from '../../lib/admin_rows'
import {
  BUILTIN_SERVER,
  DEFAULT_SERVERS_MAX,
  addDefaultServer,
  addTypedServer,
  createServerError,
  isBuiltin,
  listOf,
  moveEntry,
  removeEntry,
  type CreateServerForm,
} from '../../lib/admin_servers'
import { missing } from '../../lib/api_errors'
import { errorText, useStore } from '../../lib/store'
import { PageGroup, PageRow } from '../settings_page'
import { Button, IconButton, ListRow } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { FieldError, Sentinel, fieldCls } from '../ui'
import { useControl } from './config_state'
import { ServerMatches } from './server_matches'
import { ServerManage } from './server_manage'
import { SourceNote } from './source'
import { time } from '../../lib/platform/time'

// Whether a server has the key `key`.
const serverExists = (session: ReturnType<typeof useAccount>, key: string) =>
  sendTo(session, ask.getServer(key)).then(
    () => true,
    (e: unknown) => {
      if (missing(e)) return false
      throw e
    }
  )

const defaultControl = (account: ReturnType<typeof useAccount>) =>
  controlOf(account.adminConfig.getState().config, 'default_servers')

// One server: what its managers can change, and deleting it.
export function ServerPage({ name }: { name: string }) {
  const openAdmin = useStore(s => s.openAdmin)
  const openServer = useStore(s => s.openServer)
  const adminDeleteServer = useStore(s => s.adminDeleteServer)
  const askConfirm = useStore(s => s.askConfirm)
  const builtin = useStore(s => isBuiltin(name, s.settings))
  const defaults = useControl('default_servers')
  const kept = builtin && listOf(defaults?.value).includes(name)
  return (
    <Stack gap="sm">
      <Row gap="sm" wrap>
        <Button onClick={() => openAdmin('servers')} place="hidden md:inline-flex">
          Back to servers
        </Button>
        <Button onClick={() => void openServer(name)} place="ml-auto">
          Open
        </Button>
        <Button
          variant="danger"
          disabled={kept}
          onClick={() =>
            askConfirm({
              title: 'Delete Server',
              body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
              confirm: 'Delete',
              action: () => void adminDeleteServer(name).then(() => openAdmin('servers')),
            })
          }
        >
          Delete server
        </Button>
      </Row>
      {kept && (
        <p className="text-xs text-on-surface-variant">
          This is the built-in server. Take it off the default servers to delete it.
        </p>
      )}
      <Surface tone="base" radius="lg" pad="none">
        <ServerManage name={name} onCollapse={() => openAdmin('servers')} />
      </Surface>
    </Stack>
  )
}

// The servers every new account joins, in order.
function DefaultServers() {
  const ownerSession = useAccount()
  const row = adminRow('default_servers')
  const control = useControl('default_servers')
  const updateSettings = useStore(s => s.updateSettings)
  const setError = useStore(s => s.setError)
  const [q, setQ] = useState('')
  const [wrong, setWrong] = useState<string | null>(null)
  const pinned = control?.pinned ?? false
  const list = listOf(control?.value)
  const full = list.length >= DEFAULT_SERVERS_MAX
  const save = (next: string[]) => {
    setWrong(null)
    void updateSettings({ default_servers: next })
  }
  const add = (name: string) => {
    const edit = addDefaultServer(list, name)
    setWrong(edit.error)
    if (edit.error !== null) return
    setQ('')
    save(edit.list)
  }
  return (
    <PageRow id="default_servers" className="bg-surface-container">
      <Surface tone="plain" pad="md" gap="sm">
        <p className="text-sm text-on-surface-variant">
          New accounts join these, in order. Guests start in the ones anyone can read.
        </p>
        {control === null ? (
          <p className="text-sm text-on-surface-variant">Loading</p>
        ) : (
          <>
            {list.length === 0 && <p className="text-sm">New accounts join no server.</p>}
            <Stack as="ol" gap="2xs">
              {list.map((name, i) => (
                <Row as="li" key={name} gap="md">
                  <span className="w-5 shrink-0 text-right text-xs text-on-surface-variant">
                    {i + 1}
                  </span>
                  <Name of={serverCalled(name)} look="min-w-0 flex-1 truncate text-sm" />
                  <Row gap="2xs">
                    <IconButton
                      icon={ChevronUp}
                      label="Move up"
                      size="lg"
                      data-icon-only
                      disabled={pinned || i === 0}
                      onClick={() => save(moveEntry(list, i, -1))}
                    />
                    <IconButton
                      icon={ChevronDown}
                      label="Move down"
                      size="lg"
                      data-icon-only
                      disabled={pinned || i === list.length - 1}
                      onClick={() => save(moveEntry(list, i, 1))}
                    />
                    <IconButton
                      icon={X}
                      label="Remove from the list"
                      size="lg"
                      data-icon-only
                      disabled={pinned}
                      onClick={() => save(removeEntry(list, i))}
                    />
                  </Row>
                </Row>
              ))}
            </Stack>
            <Row
              as="form"
              key={ownerSession.renderKey}
              onSubmit={e => {
                e.preventDefault()
                const form = e.currentTarget
                const mark = ownerSession.lifetime.sessionMark()
                const active = () =>
                  form.isConnected && mark === ownerSession.lifetime.sessionMark()
                const typed = q
                void addTypedServer(
                  () => listOf(defaultControl(ownerSession)?.value),
                  typed,
                  key => serverExists(ownerSession, key)
                )
                  .then(edit => {
                    const current = defaultControl(ownerSession)
                    if (!active() || !current || current.pinned) return
                    setWrong(edit.error)
                    if (edit.error !== null) return
                    setQ(now => (now === typed ? '' : now))
                    save(edit.list)
                  })
                  .catch((error: unknown) => {
                    if (active()) setError(errorText(error))
                  })
              }}
              gap="sm"
            >
              <NameInput
                value={q}
                disabled={pinned || full}
                onChange={e => {
                  setWrong(null)
                  setQ(e.target.value)
                }}
                placeholder={full ? 'The list is full' : 'Add a server by name'}
                aria-label="Add a default server"
                className={`${fieldCls} disabled:opacity-50`}
              />
              <Button type="submit" disabled={pinned || full} place="shrink-0">
                Add
              </Button>
            </Row>
            <ServerMatches
              q={q}
              limit={8}
              row={sv => (
                <ListRow
                  key={sv.name}
                  disabled={pinned || full || list.includes(sv.name)}
                  onClick={() => add(sv.name)}
                  label={
                    <>
                      <Name of={serverName(sv)} />{' '}
                      <Name
                        of={serverCalled(sv.name)}
                        before="("
                        after=")"
                        look="text-on-surface-variant"
                      />
                    </>
                  }
                  trailing={<span className="shrink-0 text-primary">Add</span>}
                />
              )}
            />
            <FieldError message={wrong} />
          </>
        )}
        {row && <SourceNote row={row} flush />}
      </Surface>
    </PageRow>
  )
}

const EMPTY_FORM: CreateServerForm = { name: '', owner: '', password: '' }

// Makes a server for an account, whatever "Who can create servers" says.
function CreateServer({ onCreated }: { onCreated: () => void }) {
  const ownerSession = useAccount()
  const showToast = useStore(s => s.showToast)
  const [form, setForm] = useState(EMPTY_FORM)
  const [wrong, setWrong] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const field = (key: keyof CreateServerForm) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(f => ({ ...f, [key]: e.target.value }))
  return (
    <PageRow id="create_server" className="bg-surface-container">
      <Surface
        as="form"
        tone="plain"
        pad="md"
        gap="sm"
        onSubmit={e => {
          e.preventDefault()
          const error = createServerError(form)
          setWrong(error)
          if (error !== null || busy) return
          setBusy(true)
          sendTo(
            ownerSession,
            ask.adminCreateServer({
              name: form.name.trim(),
              owner: form.owner.trim().replace(/^@+/, ''),
              ...(form.password === '' ? {} : { password: form.password }),
            })
          )
            .then(detail => {
              setForm(EMPTY_FORM)
              showToast('Server created:', detail.display_name)
              onCreated()
            })
            .catch(ownerSession.lifetime.inSession((e: unknown) => setWrong(errorText(e))))
            .finally(() => setBusy(false))
        }}
      >
        <p className="text-sm text-on-surface-variant">
          The owner gets the server with every permission. This works whoever can create servers.
        </p>
        <Row gap="none">
          <NameInput
            value={form.name}
            onChange={field('name')}
            placeholder="Server name"
            aria-label="Server name"
          />
        </Row>
        <Row gap="none">
          <NameInput
            value={form.owner}
            onChange={field('owner')}
            placeholder="Owner's username"
            aria-label="Owner's username"
            autoCapitalize="none"
          />
        </Row>
        <Row gap="none">
          <input
            type="password"
            value={form.password}
            onChange={field('password')}
            placeholder="Password (optional)"
            aria-label="Password (optional)"
            autoComplete="new-password"
            className={fieldCls}
          />
        </Row>
        <FieldError message={wrong} />
        <Button type="submit" variant="filled" size="md" disabled={busy} place="self-end">
          Create server
        </Button>
      </Surface>
    </PageRow>
  )
}

function Builtin() {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <PageRow id="builtin_server">
      <ListRow
        variant="card"
        chevron
        onClick={() => openAdmin('servers', BUILTIN_SERVER)}
        label="Manage the built-in server"
        description="Rename it, or delete it once it is not a default server. Its address stays the same."
      />
    </PageRow>
  )
}

export function ServersSection() {
  const overview = useStore(s => s.adminOverview)
  const adminServers = useStore(s => s.adminServers)
  const loadAdminServers = useStore(s => s.loadAdminServers)
  const loadAdminOverview = useStore(s => s.loadAdminOverview)
  const openAdmin = useStore(s => s.openAdmin)
  const builtin = useStore(s => isBuiltin(BUILTIN_SERVER, s.settings))
  const [q, setQ] = useState('')
  useEffect(() => {
    void loadAdminOverview()
  }, [loadAdminOverview])
  useEffect(() => {
    const t = time().after(300, () => void loadAdminServers(q, true))
    return () => t?.()
  }, [q, loadAdminServers])
  const more = useCallback(() => void loadAdminServers(q), [q, loadAdminServers])
  return (
    <div>
      <PageGroup label="Default servers">
        <DefaultServers />
        {builtin && <Builtin />}
      </PageGroup>
      <PageGroup label="Create a server">
        <CreateServer
          onCreated={() => {
            void loadAdminServers(q, true)
            void loadAdminOverview()
          }}
        />
      </PageGroup>
      <PageGroup
        label={overview ? `All servers (${overview.server_count.toLocaleString()})` : 'All servers'}
      >
        <Stack gap="sm">
          <Row gap="none">
            <NameInput
              value={q}
              onChange={e => setQ(e.target.value)}
              placeholder="Search servers"
              aria-label="Search servers"
            />
          </Row>
          <Stack gap="2xs">
            {adminServers.list.map(sv => (
              <ListRow
                key={sv.name}
                variant="card"
                chevron
                onClick={() => openAdmin('servers', sv.name)}
                label={
                  <>
                    <Name of={serverName(sv)} />{' '}
                    <Name
                      of={serverCalled(sv.name)}
                      before="("
                      after=")"
                      look="text-on-surface-variant"
                    />
                  </>
                }
              />
            ))}
            {adminServers.hasMore && <Sentinel key={adminServers.list.length} onVisible={more} />}
          </Stack>
        </Stack>
      </PageGroup>
    </div>
  )
}
