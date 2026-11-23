'use client'
import { useAccount } from '../../lib/client/react'
import { useCallback, useEffect, useState } from 'react'
import { ChevronDown, ChevronRight, ChevronUp, X } from 'lucide-react'
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
import { ApiError } from '../../lib/api'
import { errorText, useStore } from '../../lib/store'
import type { ServerSummaryLite } from '../../lib/types'
import { PageGroup, PageRow } from '../settings_page'
import { FieldError, Sentinel } from '../ui'
import { useControl } from './config_state'
import { ServerManage } from './server_manage'
import { SourceNote } from './source'
import { dangerBtn, fieldCls, filledBtn, textBtn } from './touch'
import { rowBtnCls } from './users'

// Whether a server has the key `key`.
const serverExists = (api: ReturnType<typeof useAccount>['api'], key: string) =>
  api.getServer(key).then(
    () => true,
    (e: unknown) => {
      if (e instanceof ApiError && e.status === 404) return false
      throw e
    }
  )

const defaultControl = (account: ReturnType<typeof useAccount>) =>
  controlOf(account.adminConfig.getState().config, 'default_servers')

const stepBtn =
  'flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant enabled:hover:bg-surface-container-high disabled:opacity-40 md:h-9 md:w-9'

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
    <div>
      <div className="flex flex-wrap items-center gap-2 pb-2">
        <button onClick={() => openAdmin('servers')} className={`${textBtn} -ml-3 hidden md:block`}>
          Back to servers
        </button>
        <span className="flex-1" />
        <button onClick={() => void openServer(name)} className={textBtn}>
          Open
        </button>
        <button
          disabled={kept}
          onClick={() =>
            askConfirm({
              title: 'Delete Server',
              body: 'Delete this server for everyone? All of its channels and messages are deleted. This cannot be undone.',
              confirm: 'Delete',
              action: () => void adminDeleteServer(name).then(() => openAdmin('servers')),
            })
          }
          className={dangerBtn}
        >
          Delete server
        </button>
      </div>
      {kept && (
        <p className="pb-2 text-xs text-on-surface-variant">
          This is the built-in server. Take it off the default servers to delete it.
        </p>
      )}
      <div className="rounded-xl bg-surface-container">
        <ServerManage name={name} onCollapse={() => openAdmin('servers')} />
      </div>
    </div>
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
  const [found, setFound] = useState<ServerSummaryLite[]>([])
  const [wrong, setWrong] = useState<string | null>(null)
  const pinned = control?.pinned ?? false
  const list = listOf(control?.value)
  const full = list.length >= DEFAULT_SERVERS_MAX
  useEffect(() => {
    const text = q.trim()
    let live = true
    const t = setTimeout(() => {
      if (text === '') return setFound([])
      ownerSession.api
        .adminServers(null, text)
        .then(page => {
          if (live) setFound(page.items.slice(0, 8))
        })
        .catch(ownerSession.lifetime.inSession((e: unknown) => setError(errorText(e))))
    }, 300)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [ownerSession, q, setError])
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
    <PageRow id="default_servers" className="flex flex-col gap-2 bg-surface-container px-3 py-3">
      <p className="text-sm text-on-surface-variant">
        New accounts join these, in order. Guests start in the ones anyone can read.
      </p>
      {control === null ? (
        <p className="text-sm text-on-surface-variant">Loading</p>
      ) : (
        <>
          {list.length === 0 && <p className="text-sm">New accounts join no server.</p>}
          <ol className="flex flex-col gap-1">
            {list.map((name, i) => (
              <li key={name} className="flex min-w-0 items-center gap-1">
                <span className="w-5 shrink-0 text-right text-xs text-on-surface-variant">
                  {i + 1}
                </span>
                <span className="streamer min-w-0 flex-1 truncate px-2 text-sm">{name}</span>
                <button
                  type="button"
                  data-icon-only
                  title="Move up"
                  aria-label="Move up"
                  disabled={pinned || i === 0}
                  onClick={() => save(moveEntry(list, i, -1))}
                  className={stepBtn}
                >
                  <ChevronUp size={18} />
                </button>
                <button
                  type="button"
                  data-icon-only
                  title="Move down"
                  aria-label="Move down"
                  disabled={pinned || i === list.length - 1}
                  onClick={() => save(moveEntry(list, i, 1))}
                  className={stepBtn}
                >
                  <ChevronDown size={18} />
                </button>
                <button
                  type="button"
                  data-icon-only
                  title="Remove from the list"
                  aria-label="Remove from the list"
                  disabled={pinned}
                  onClick={() => save(removeEntry(list, i))}
                  className={stepBtn}
                >
                  <X size={18} />
                </button>
              </li>
            ))}
          </ol>
          <form
            key={ownerSession.renderKey}
            onSubmit={e => {
              e.preventDefault()
              const form = e.currentTarget
              const mark = ownerSession.lifetime.sessionMark()
              const active = () => form.isConnected && mark === ownerSession.lifetime.sessionMark()
              const typed = q
              void addTypedServer(
                () => listOf(defaultControl(ownerSession)?.value),
                typed,
                key => serverExists(ownerSession.api, key)
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
            className="flex gap-2"
          >
            <input
              value={q}
              disabled={pinned || full}
              onChange={e => {
                setWrong(null)
                setQ(e.target.value)
              }}
              placeholder={full ? 'The list is full' : 'Add a server by name'}
              aria-label="Add a default server"
              className={`${fieldCls} streamer disabled:opacity-50`}
            />
            <button disabled={pinned || full} className={`${textBtn} shrink-0 disabled:opacity-50`}>
              Add
            </button>
          </form>
          {found.length > 0 && (
            <div className="flex flex-col gap-1">
              {found.map(sv => (
                <button
                  key={sv.name}
                  type="button"
                  disabled={pinned || full || list.includes(sv.name)}
                  onClick={() => add(sv.name)}
                  className="flex min-h-11 w-full min-w-0 items-center gap-2 rounded-xl px-3 py-1.5 text-left text-sm enabled:hover:bg-surface-container-high disabled:opacity-50 md:min-h-0"
                >
                  <span className="streamer min-w-0 flex-1 truncate">
                    {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
                  </span>
                  <span className="shrink-0 text-primary">Add</span>
                </button>
              ))}
            </div>
          )}
          <FieldError message={wrong} />
        </>
      )}
      {row && (
        <div className="-mx-2">
          <SourceNote row={row} />
        </div>
      )}
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
    <PageRow id="create_server" className="bg-surface-container px-3 py-3">
      <form
        onSubmit={e => {
          e.preventDefault()
          const error = createServerError(form)
          setWrong(error)
          if (error !== null || busy) return
          setBusy(true)
          ownerSession.api
            .adminCreateServer({
              name: form.name.trim(),
              owner: form.owner.trim().replace(/^@+/, ''),
              ...(form.password === '' ? {} : { password: form.password }),
            })
            .then(detail => {
              setForm(EMPTY_FORM)
              showToast('Server created:', detail.display_name)
              onCreated()
            })
            .catch(ownerSession.lifetime.inSession((e: unknown) => setWrong(errorText(e))))
            .finally(() => setBusy(false))
        }}
        className="flex flex-col gap-2"
      >
        <p className="text-sm text-on-surface-variant">
          The owner gets the server with every permission. This works whoever can create servers.
        </p>
        <div className="flex">
          <input
            value={form.name}
            onChange={field('name')}
            placeholder="Server name"
            aria-label="Server name"
            className={`${fieldCls} streamer`}
          />
        </div>
        <div className="flex">
          <input
            value={form.owner}
            onChange={field('owner')}
            placeholder="Owner's username"
            aria-label="Owner's username"
            autoCapitalize="none"
            className={`${fieldCls} streamer`}
          />
        </div>
        <div className="flex">
          <input
            type="password"
            value={form.password}
            onChange={field('password')}
            placeholder="Password (optional)"
            aria-label="Password (optional)"
            autoComplete="new-password"
            className={fieldCls}
          />
        </div>
        <FieldError message={wrong} />
        <div className="flex justify-end">
          <button disabled={busy} className={filledBtn}>
            Create server
          </button>
        </div>
      </form>
    </PageRow>
  )
}

function Builtin() {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <PageRow id="builtin_server">
      <button onClick={() => openAdmin('servers', BUILTIN_SERVER)} className={rowBtnCls}>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-sm">Manage the built-in server</span>
          <span className="text-xs text-on-surface-variant">
            Rename it, or delete it once it is not a default server. Its address stays the same.
          </span>
        </span>
        <ChevronRight size={18} className="shrink-0 text-on-surface-variant" />
      </button>
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
    const t = setTimeout(() => void loadAdminServers(q, true), 300)
    return () => clearTimeout(t)
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
        <div className="flex pb-1">
          <input
            value={q}
            onChange={e => setQ(e.target.value)}
            placeholder="Search servers"
            aria-label="Search servers"
            className={`${fieldCls} streamer`}
          />
        </div>
        {adminServers.list.map(sv => (
          <button key={sv.name} onClick={() => openAdmin('servers', sv.name)} className={rowBtnCls}>
            <span className="streamer min-w-0 flex-1 truncate text-sm">
              {sv.display_name} <span className="text-on-surface-variant">({sv.name})</span>
            </span>
            <ChevronRight size={18} className="shrink-0 text-on-surface-variant" />
          </button>
        ))}
        {adminServers.hasMore && <Sentinel key={adminServers.list.length} onVisible={more} />}
      </PageGroup>
    </div>
  )
}
