'use client'

import { PeerCodeDialog } from './p2p/peer_code_dialog'
import { openPeerLink, peerCode } from '../lib/client/peer_links'
import { SwitcherDialog } from './account_switcher'
import { AddInstanceDialog, AddInstanceFlow, useAddingAllowed } from './add_instance'
import { submittedLinkTarget, routeInstanceLink } from '../lib/client/instance_links'
import { allowsAccountOrigin } from '../lib/client/hosted_policy'
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
import { JOIN_NOTE, runJoinStep, type JoinStep } from '../lib/join_flow'
import { SHORT_PASSWORD, tooShort } from '../lib/passwords'
import { Dialog, FieldError, Masked } from './ui'

function AddServerDialog({
  join,
  locked,
  initial,
  owner,
  selecting,
  selectedAs,
  selection,
  picker,
}: {
  owner: AccountSession
  selection: React.RefObject<number>
  selecting: boolean
  selectedAs: AccountSession | null
  picker: ReactNode
  join?: string
  locked?: boolean
  initial?: 'create' | 'join'
}) {
  const acting = selectedAs ?? owner
  const {
    api,
    lifetime: { inSession },
  } = acting
  const { guest, createServer, joinServer, guestJoinServer } = acting.store.getState()
  const closeDialog = owner.store.getState().closeDialog
  const [initiatingIdentity] = useState(() =>
    acting === owner && owner.identities.coversView() ? (owner.identities.viewed() ?? null) : null
  )
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

  useEffect(() => {
    setSuggestions([])
    setTaken(null)
    if (selecting || !id || /^(?:rci1|rcp1)\./i.test(id) || (joining && id.includes('/'))) return
    const controller = new AbortController()
    const mark = selection.current
    const valid = () =>
      !controller.signal.aborted &&
      selection.current === mark &&
      allowsAccountOrigin(acting.conn.origin) &&
      client.live().includes(acting)
    const timer = setTimeout(async () => {
      if (!valid()) return
      try {
        if (joining) {
          const matches = await api.searchServers(id, controller.signal)
          if (valid()) setSuggestions(matches)
        } else {
          const result = await api.serverAvailable(id, controller.signal)
          if (valid()) setTaken({ id, taken: !result.available })
        }
      } catch {
        /* Availability is optional. Submit still checks with the server. */
      }
    }, 400)
    return () => {
      clearTimeout(timer)
      controller.abort()
    }
  }, [id, joining, selecting, selection, acting, api])

  const rename = (value: string) => {
    setName(value)
    setStep('name')
    setPassword('')
    setError(null)
  }

  const submit = async () => {
    const trimmed = name.trim()
    if (
      !trimmed ||
      busy ||
      selecting ||
      !allowsAccountOrigin(acting.conn.origin) ||
      !client.live().includes(acting)
    )
      return
    if (/^(?:rci1|rcp1)\./i.test(trimmed)) {
      const peer = peerCode(trimmed)
      if (joining && peer) {
        openPeerLink(acting, peer, acting === owner ? initiatingIdentity : null, owner)
      } else setError('Enter a valid P2P code in the Join tab.')
      return
    }
    if (joining && trimmed.includes('/')) {
      const target = submittedLinkTarget(acting, trimmed)
      if (target) {
        closeDialog()
        await routeInstanceLink(owner, target, selectedAs)
        return
      }
    }
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
    const out = await runJoinStep(step, password, pw => join(trimmed, pw), errorText)
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
  const [selectedAs, setSelectedAs] = useState<AccountSession | null>(null)
  const acting = selectedAs ?? owner
  const selection = useRef(0)
  const [switching, setSwitching] = useState<AccountSession | null>(null)
  const [switchError, setSwitchError] = useState('')
  const [adding, setAdding] = useState(false)
  const choices = sessions.filter(a => {
    if (!allowsAccountOrigin(a.conn.origin)) return false
    if (a === owner || a.store.getState().me || a.store.getState().guest) return true
    const target = a.credentialTarget
    const keys = accountStorage(a.conn)
    return target === null
      ? readLocal(keys.key('rchat_guest')) === '1'
      : typeof target === 'string' && !!readLocal(keys.token(target))
  })
  const close = owner.store.getState().closeDialog
  const dialog = owner.store.getState().activeDialog
  const lostActor = !choices.includes(acting) || (!!switching && !choices.includes(switching))
  useEffect(() => {
    if (lostActor && owner.store.getState().activeDialog === dialog) {
      selection.current++
      close()
    }
  }, [lostActor, close, owner, dialog])
  if (lostActor) return null
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
            if (!next || !allowsAccountOrigin(next.conn.origin)) return
            setSwitching(next)
            if (!next.store.getState().me && !next.store.getState().guest)
              await next.store.getState().bootstrap()
            if (mark !== selection.current) return
            setSwitching(null)
            if (
              allowsAccountOrigin(next.conn.origin) &&
              client.live().includes(next) &&
              (next.store.getState().me || next.store.getState().guest)
            )
              setSelectedAs(next)
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
          selectedAs={selectedAs}
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
  if (dialog?.kind === 'peer_code')
    return <PeerCodeDialog key={dialog.request.id} request={dialog.request} />
  if (dialog?.kind === 'account_switcher') return <SwitcherDialog initialManage={!!dialog.manage} />
  if (dialog?.kind === 'add_instance')
    return <AddInstanceDialog initialOrigin={dialog.origin} initialUsername={dialog.username} />
  return dialog?.kind === 'add_server' ? (
    <AccountServerDialog
      key={`${dialog.join ?? ''}:${dialog.locked ? 1 : 0}:${dialog.tab ?? ''}`}
      join={dialog.join}
      locked={dialog.locked}
      initial={dialog.tab}
    />
  ) : null
}
