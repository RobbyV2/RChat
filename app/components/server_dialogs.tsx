'use client'

import { useEffect, useState } from 'react'
import { Lock, X } from 'lucide-react'
import * as api from '../lib/api'
import { useStore } from '../lib/store'
import type { ServerMatch } from '../lib/types'

function Dialog({ title, children }: { title: string; children: React.ReactNode }) {
  const closeDialog = useStore(s => s.closeDialog)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDialog()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeDialog])
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-scrim/60 p-4"
      onMouseDown={closeDialog}
    >
      <div
        className="w-full max-w-sm rounded-3xl bg-surface-container-high p-6 shadow-elevation-3"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-medium">{title}</h2>
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

function AddServerDialog() {
  const guest = useStore(s => s.guest)
  const guestGrants = useStore(s => s.guestGrants)
  const createServer = useStore(s => s.createServer)
  const joinServer = useStore(s => s.joinServer)
  const guestJoinServer = useStore(s => s.guestJoinServer)
  const closeDialog = useStore(s => s.closeDialog)
  const [tab, setTab] = useState<'create' | 'join'>(guest ? 'join' : 'create')
  const [name, setName] = useState('')
  const [password, setPassword] = useState('')
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

  const submit = () => {
    const trimmed = name.trim()
    if (!trimmed) return
    closeDialog()
    const pw = password.trim() || undefined
    if (guest) {
      void guestJoinServer(trimmed, pw)
      return
    }
    switch (tab) {
      case 'create':
        void createServer(trimmed, pw)
        return
      case 'join':
        void joinServer(trimmed, pw)
        return
    }
  }

  return (
    <Dialog title={guest ? 'Join a server' : 'Add a server'}>
      {!guest && (
        <div className="mb-4 flex rounded-full bg-surface-container p-1">
          {(['create', 'join'] as const).map(t => (
            <button
              key={t}
              onClick={() => setTab(t)}
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
          if (e.key === 'Enter') submit()
        }}
        placeholder="server name"
        className="w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
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
            if (e.key === 'Enter') submit()
          }}
          placeholder={creating ? 'password (optional)' : 'password'}
          className="mt-3 w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-sm outline-none focus:border-primary"
        />
      )}
      <div className="mt-5 flex justify-end gap-2">
        <button
          onClick={closeDialog}
          className="rounded-full px-4 py-2 text-sm text-primary hover:bg-surface-container"
        >
          Cancel
        </button>
        <button
          onClick={submit}
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
  return dialog?.kind === 'add_server' ? <AddServerDialog /> : null
}
