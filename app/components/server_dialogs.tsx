'use client'

import { useEffect, useState } from 'react'
import { api } from '../lib/instances'
import { errorText, useStore } from '../lib/store'
import type { ServerMatch } from '../lib/types'
import { enterKey } from '../lib/keys'
import { JOIN_NOTE, runJoinStep, type JoinStep } from '../lib/join_flow'
import { SHORT_PASSWORD, tooShort } from '../lib/passwords'
import { Dialog, FieldError } from './ui'

function AddServerDialog({ join, locked }: { join?: string; locked?: boolean }) {
  const guest = useStore(s => s.guest)
  const createServer = useStore(s => s.createServer)
  const joinServer = useStore(s => s.joinServer)
  const guestJoinServer = useStore(s => s.guestJoinServer)
  const closeDialog = useStore(s => s.closeDialog)
  const [tab, setTab] = useState<'create' | 'join'>(guest || join ? 'join' : 'create')
  const [name, setName] = useState(join ?? '')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [step, setStep] = useState<JoinStep>(join && locked ? 'password' : 'name')
  const [taken, setTaken] = useState<{ id: string; taken: boolean } | null>(null)
  const [suggestions, setSuggestions] = useState<ServerMatch[]>([])
  const creating = tab === 'create' && !guest
  const joining = !creating
  const id = name.trim().toLowerCase()
  const nameTaken = creating && taken?.id === id && taken.taken

  useEffect(() => {
    if (!joining || !id) {
      setSuggestions([])
      return
    }
    const t = setTimeout(() => {
      api
        .searchServers(id)
        .then(setSuggestions)
        .catch(() => setSuggestions([]))
    }, 400)
    return () => clearTimeout(t)
  }, [id, joining])

  useEffect(() => {
    if (!creating || !id) return
    const t = setTimeout(() => {
      api
        .serverAvailable(id)
        .then(r => setTaken({ id, taken: !r.available }))
        .catch(() => setTaken(null))
    }, 400)
    return () => clearTimeout(t)
  }, [id, creating])

  const rename = (value: string) => {
    setName(value)
    setStep('name')
    setPassword('')
    setError(null)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (!trimmed || busy) return
    setBusy(true)
    setError(null)
    if (creating) {
      if (tooShort(password)) {
        setError(SHORT_PASSWORD)
        setBusy(false)
        return
      }
      try {
        await createServer(trimmed, password.trim() || undefined)
        closeDialog()
      } catch (e) {
        setError(errorText(e))
        setBusy(false)
      }
      return
    }
    const out = await runJoinStep(
      step,
      password,
      pw => (guest ? guestJoinServer(trimmed, pw) : joinServer(trimmed, pw)),
      errorText
    )
    if (out.done) {
      closeDialog()
      return
    }
    setStep(out.step)
    setError(out.error)
    setBusy(false)
  }

  return (
    <Dialog compact title={guest ? 'Join a server' : 'Add a server'} onClose={closeDialog}>
      {!guest && (
        <div className="mb-4 flex rounded-full bg-surface-container p-1">
          {(['create', 'join'] as const).map(t => (
            <button
              key={t}
              onClick={() => {
                setTab(t)
                setStep('name')
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
        autoFocus={step === 'name'}
        value={name}
        onChange={e => rename(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) void submit()
        }}
        placeholder="server name"
        aria-label="Server name"
        aria-invalid={nameTaken}
        className="streamer w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none focus:border-primary md:text-sm"
      />
      {nameTaken && <p className="mt-1 text-xs text-error">That name is taken</p>}
      {joining && step === 'name' && suggestions.some(s => s.name !== id) && (
        <div className="mt-2 flex flex-col gap-1">
          {suggestions
            .filter(s => s.name !== id)
            .slice(0, 5)
            .map(s => (
              <button
                key={s.name}
                onClick={() => rename(s.name)}
                className="streamer flex items-center gap-1.5 rounded-lg px-2 py-1 text-left text-sm text-on-surface-variant hover:bg-surface-container"
              >
                <span className="truncate">{s.display_name}</span>
              </button>
            ))}
        </div>
      )}
      {(creating || step === 'password') && (
        <input
          autoFocus={step === 'password'}
          type="password"
          value={password}
          onChange={e => setPassword(e.target.value)}
          onKeyDown={e => {
            if (enterKey(e)) void submit()
          }}
          placeholder={creating ? 'password (optional)' : 'password'}
          aria-label={creating ? 'Password (optional)' : 'Server password'}
          className="mt-3 w-full rounded-xl border border-outline bg-transparent px-3 py-2 text-base outline-none focus:border-primary md:text-sm"
        />
      )}
      {joining && <p className="mt-3 text-xs text-on-surface-variant">{JOIN_NOTE}</p>}
      <FieldError message={error} />
      <div className="mt-5 flex justify-end gap-2">
        {joining && step === 'password' && (
          <button
            onClick={() => rename(name)}
            className="mr-auto rounded-full px-4 py-2 text-sm text-primary hover:bg-surface-container"
          >
            Back
          </button>
        )}
        <button
          onClick={closeDialog}
          className="rounded-full px-4 py-2 text-sm text-primary hover:bg-surface-container"
        >
          Cancel
        </button>
        <button
          onClick={() => void submit()}
          disabled={busy || !name.trim() || (step === 'password' && !password.trim())}
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
  return dialog?.kind === 'add_server' ? (
    <AddServerDialog join={dialog.join} locked={dialog.locked} />
  ) : null
}
