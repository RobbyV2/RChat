'use client'

import { useEffect, useId, useState } from 'react'
import { Lock, X } from 'lucide-react'
import * as api from '../lib/api'
import { errorText, useStore } from '../lib/store'
import type { ServerMatch } from '../lib/types'
import { enterKey } from '../lib/keys'
import { FieldError, useBackdrop, useEscape } from './server_settings'

function Dialog({ title, children }: { title: string; children: React.ReactNode }) {
  const closeDialog = useStore(s => s.closeDialog)
  const titleId = useId()
  const backdrop = useBackdrop(closeDialog)
  useEscape(closeDialog)
  return (
    <div
      className="fixed inset-x-0 top-0 z-50 flex h-app items-center justify-center bg-scrim/60 px-safe-4 py-4"
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="max-h-full w-full max-w-sm overflow-y-auto rounded-3xl bg-surface-container-high p-6 shadow-elevation-3"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id={titleId} className="text-lg font-medium">
            {title}
          </h2>
          <button
            title="Close"
            onClick={closeDialog}
            className="rounded-full p-1 text-on-surface-variant hover:bg-surface-container-highest"
          >
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  )
}

function AddServerDialog({ join }: { join?: string }) {
  const guest = useStore(s => s.guest)
  const guestGrants = useStore(s => s.guestGrants)
  const createServer = useStore(s => s.createServer)
  const joinServer = useStore(s => s.joinServer)
  const guestJoinServer = useStore(s => s.guestJoinServer)
  const closeDialog = useStore(s => s.closeDialog)
  const [tab, setTab] = useState<'create' | 'join'>(guest || join ? 'join' : 'create')
  const [name, setName] = useState(join ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [protectedServer, setProtectedServer] = useState(false)
  const [suggestions, setSuggestions] = useState<ServerMatch[]>([])
  const creating = tab === 'create' && !guest
  const joining = !creating
  const id = name.trim().toLowerCase()
  const hasGrant = guest && Boolean(guestGrants[id])

  useEffect(() => {
    if (!joining || !id) {
      setProtectedServer(false)
      setSuggestions([])
      return
    }
    const t = setTimeout(() => {
      api
        .serverExists(id)
        .then(r => setProtectedServer(r.has_password))
        .catch(() => setProtectedServer(false))
      api
        .searchServers(id)
        .then(setSuggestions)
        .catch(() => setSuggestions([]))
    }, 400)
    return () => clearTimeout(t)
  }, [id, joining])

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    const pw = password.trim() || undefined
    setBusy(true)
    setError(null)
    try {
      if (guest) await guestJoinServer(trimmed, pw)
      else if (tab === 'create') await createServer(trimmed, pw)
      else await joinServer(trimmed, pw)
      closeDialog()
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <Dialog title={guest ? 'Join a server' : 'Add a server'}>
      {!guest && (
        <div className="mb-4 flex rounded-full bg-surface-container p-1">
          {(['create', 'join'] as const).map(t => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setError(null)
              }}
              className={`flex-1 rounded-full py-1.5 text-sm capitalize ${
                tab === t
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface-variant'
              }`}
            >
              {t}
            </button>
          ))}
        </div>
      )}
      <p className="mb-3 text-sm text-on-surface-variant">
        {creating
          ? 'The server name doubles as its invite code.'
          : 'Enter a server name to join it. The name is the invite code.'}
      </p>
      <input
        autoFocus
        value={name}
        onChange={e => setName(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) void submit()
        }}
        placeholder="server name"
        className="w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none focus:border-primary md:text-sm"
      />
      {joining && suggestions.some(s => s.name !== id) && (
        <div className="mt-2 flex flex-col gap-1">
          {suggestions
            .filter(s => s.name !== id)
            .slice(0, 5)
            .map(s => (
              <button
                key={s.name}
                onClick={() => {
                  setName(s.name)
                  setProtectedServer(s.has_password)
                }}
                className="streamer flex items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm text-on-surface-variant hover:bg-surface-container"
              >
                <span className="truncate">{s.display_name}</span>
                {s.has_password && <Lock size={12} className="shrink-0" />}
              </button>
            ))}
        </div>
      )}
      {(creating || (protectedServer && !hasGrant)) && (
        <input
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => {
            if (enterKey(e)) void submit()
          }}
          placeholder={creating ? 'password (optional)' : 'password'}
          className="mt-3 w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none focus:border-primary md:text-sm"
        />
      )}
      <FieldError message={error} />
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={closeDialog}
          className="rounded-full px-4 py-2 text-sm text-primary hover:bg-surface-container"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !name.trim()}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          {creating ? 'Create' : 'Join'}
        </button>
      </div>
    </Dialog>
  )
}

export function ServerDialogs() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'add_server' ? <AddServerDialog join={dialog.join} /> : null
}
