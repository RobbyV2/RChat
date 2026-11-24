'use client'

import { AddInstanceDialog, AddInstanceFlow, useAddingAllowed } from './add_instance'
import { client } from '../lib/client/client'
import type { AccountSession } from '../lib/client/session'
import { accountStorage } from '../lib/client/keys'
import { readLocal } from '../lib/instances'
import type { ReactNode } from 'react'
import { useLiveSessions, useAccount } from '../lib/client/react'

import { Activity, useRef, useEffect, useState } from 'react'
import { errorText, useStore } from '../lib/store'
import type { ServerMatch } from '../lib/types'
import { enterKey } from '../lib/keys'
import { JOIN_NOTE, joinByCode, joinInput, runJoinStep, type JoinStep } from '../lib/join_flow'
import { SHORT_PASSWORD, tooShort } from '../lib/passwords'
import { Dialog, FieldError, Masked } from './ui'

function AddServerDialog({
  join,
  locked,
  initial,
  owner,
  acting,
  selecting,
  selection,
  picker,
}: {
  owner: AccountSession
  acting: AccountSession
  selection: React.RefObject<number>
  selecting: boolean
  picker: ReactNode
  join?: string
  locked?: boolean
  initial?: 'create' | 'join'
}) {
  const {
    api,
    shareOrigin,
    lifetime: { inSession },
  } = acting
  const { guest, createServer, joinServer, guestJoinServer } = acting.store.getState()
  const closeDialog = owner.store.getState().closeDialog
  const [tab, setTab] = useState<'create' | 'join'>(guest || join ? 'join' : (initial ?? 'create'))
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
  const link = joining ? joinInput(name, shareOrigin) : null

  useEffect(() => {
    if (!joining || !id || id.includes('/')) {
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
    if (!trimmed || busy || selecting) return
    setBusy(true)
    setError(null)
    const dialog = owner.store.getState().activeDialog
    const selected = selection.current
    const close = inSession(() => {
      setBusy(false)
      if (
        owner !== client.shown() ||
        owner.store.getState().activeDialog !== dialog ||
        selected !== selection.current
      )
        return
      closeDialog()
      if (acting !== owner) client.show(acting)
    })
    if (creating) {
      if (tooShort(password)) {
        setError(SHORT_PASSWORD)
        setBusy(false)
        return
      }
      try {
        await createServer(trimmed, password.trim() || undefined)
        close()
      } catch (e) {
        setError(errorText(e))
        setBusy(false)
      }
      return
    }
    const join = (server: string, pw?: string) =>
      guest ? guestJoinServer(server, pw) : joinServer(server, pw)
    if (link?.code) {
      const failed = await joinByCode(
        link.code,
        code => api.inviteByCode(code).then(card => card.server.name),
        join,
        errorText
      )
      if (failed === null) close()
      else {
        setError(failed)
        setBusy(false)
      }
      return
    }
    const target = link?.server ?? trimmed
    if (link) {
      setName(link.server)
      if (link.password) setPassword(link.password)
    }
    const out = await runJoinStep(
      link?.password ? 'password' : step,
      link?.password ?? password,
      pw => join(target, pw),
      errorText
    )
    if (out.done) {
      close()
      return
    }
    setStep(out.step)
    setError(out.error)
    setBusy(false)
  }

  return (
    <Dialog compact title={guest ? 'Join a server' : 'Add a server'} onClose={closeDialog}>
      {picker}
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
          : 'Enter a server name, or paste an invite link.'}
      </p>
      <input
        autoFocus={step === 'name'}
        value={name}
        onChange={e => rename(e.target.value)}
        onKeyDown={e => {
          if (enterKey(e)) void submit()
        }}
        placeholder={joining ? 'server name or invite link' : 'server name'}
        aria-label={joining ? 'Server name or invite link' : 'Server name'}
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
                <span className="truncate">
                  <Masked text={s.display_name} />
                </span>
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
          disabled={busy || selecting || !name.trim() || (step === 'password' && !password.trim())}
          className="rounded-full bg-primary px-4 py-2 text-sm text-on-primary hover:opacity-90 disabled:opacity-40"
        >
          {creating ? 'Create' : 'Join'}
        </button>
      </div>
    </Dialog>
  )
}

function AccountServerDialog({
  join,
  locked,
  initial,
}: {
  join?: string
  locked?: boolean
  initial?: 'create' | 'join'
}) {
  const owner = useAccount()
  const sessions = useLiveSessions()
  const allowed = useAddingAllowed()
  const [acting, setActing] = useState(owner)
  const selection = useRef(0)
  const [switching, setSwitching] = useState<AccountSession | null>(null)
  const [switchError, setSwitchError] = useState('')
  const [adding, setAdding] = useState(false)
  const choices = sessions.filter(a => {
    if (a === owner || a.store.getState().me || a.store.getState().guest) return true
    const target = a.credentialTarget
    const keys = accountStorage(a.conn)
    return target === null
      ? readLocal(keys.key('rchat_guest')) === '1'
      : typeof target === 'string' && !!readLocal(keys.token(target))
  })
  const close = owner.store.getState().closeDialog
  const addModal = adding && (
    <Dialog full title="Add an instance" onClose={() => setAdding(false)}>
      <AddInstanceFlow
        stay
        onCancel={() => setAdding(false)}
        onDone={a => {
          setAdding(false)
          close()
          client.show(a)
        }}
      />
    </Dialog>
  )
  const picker =
    !locked && (choices.length > 1 || allowed) ? (
      <label className="mb-3 flex items-center gap-2 text-sm">
        As{' '}
        <select
          aria-label="As"
          value={(switching ?? acting).renderKey}
          className="streamer min-w-0 flex-1 rounded-lg bg-surface-container px-2 py-1"
          onChange={async e => {
            const mark = ++selection.current
            setSwitchError('')
            setSwitching(null)
            if (e.target.value === 'another') {
              setAdding(true)
              return
            }
            const next = choices.find(s => s.renderKey === Number(e.target.value))
            if (!next) return
            setSwitching(next)
            if (!next.store.getState().me && !next.store.getState().guest)
              await next.store.getState().bootstrap()
            if (mark !== selection.current) return
            setSwitching(null)
            if (
              client.live().includes(next) &&
              (next.store.getState().me || next.store.getState().guest)
            )
              setActing(next)
            else setSwitchError('Sign in again to use that account.')
          }}
        >
          {choices.map(a => (
            <option key={a.renderKey} value={a.renderKey}>
              {a.store.getState().me?.username ?? a.credentialTarget ?? 'Guest'} · {a.conn.host}
            </option>
          ))}
          {allowed && <option value="another">Another instance…</option>}
        </select>
        {switchError && (
          <span role="alert" className="text-error">
            {switchError}
          </span>
        )}
      </label>
    ) : null
  return (
    <>
      {addModal}
      <Activity mode={adding ? 'hidden' : 'visible'}>
        <AddServerDialog
          key={acting.renderKey}
          owner={owner}
          acting={acting}
          selecting={!!switching}
          selection={selection}
          picker={picker}
          join={join}
          locked={locked}
          initial={initial}
        />
      </Activity>
    </>
  )
}
export function ServerDialogs() {
  const dialog = useStore(s => s.activeDialog)
  if (dialog?.kind === 'add_instance') return <AddInstanceDialog initialOrigin={dialog.origin} />
  return dialog?.kind === 'add_server' ? (
    <AccountServerDialog
      key={`${dialog.join ?? ''}:${dialog.locked ? 1 : 0}:${dialog.tab ?? ''}`}
      join={dialog.join}
      locked={dialog.locked}
      initial={dialog.tab}
    />
  ) : null
}
