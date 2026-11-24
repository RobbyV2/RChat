'use client'

import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Shield } from 'lucide-react'
import { canAddInstance } from '../lib/client/adding'
import { client } from '../lib/client/client'
import { AccountSession } from '../lib/client/session'
import { createSavedSession } from '../lib/client/saved_session'
import { AccountProvider, useAccount, useLiveSessions, useStore } from '../lib/client/react'
import { accountStorage } from '../lib/client/keys'
import { afterProbe, alreadySignedIn, trustText, type AddStep } from '../lib/add_instance'
import {
  InstanceConnection,
  ownInstance,
  endpointsFrom,
  knownInstances,
  normalizeOrigin,
  readLocal,
  rememberInstance,
  resolveInstance,
} from '../lib/instances'
import { passwordSignup, siteSettings } from '../lib/features'
import { shellInfo } from '../lib/platform'
import type { InstanceInfo, SiteSettings } from '../lib/types'
import { Dialog } from './ui'
import { SignInStep } from './sign_in_step'
export { SignInStep } from './sign_in_step'

const primary =
  'rounded-full bg-primary px-4 py-2 text-sm font-medium text-on-primary disabled:opacity-50'
const secondary = 'rounded-full border border-outline px-4 py-2 text-sm text-primary'
export function useAddingAllowed() {
  const sessions = useLiveSessions()
  const own = sessions.find(a => a.conn.isDefault)
  return useSyncExternalStore(own?.store.subscribe ?? (() => () => {}), canAddInstance, () => true)
}
interface Target {
  origin: string
  info: InstanceInfo
  conn: InstanceConnection
  settings: SiteSettings
}
function userFor(account: AccountSession) {
  const state = account.store.getState()
  return state.me?.username ?? (state.guest ? null : account.credentialTarget)
}
export function TrustNotice({
  host,
  onTrust,
  onCancel,
}: {
  host: string
  onTrust: () => void
  onCancel: () => void
}) {
  const pageHost = shellInfo() ? null : window.location.host
  const words = trustText(host, pageHost)
  const hosts = [...new Set([host, ...(pageHost ? [pageHost] : [])])].sort(
    (a, b) => b.length - a.length
  )
  const escaped = hosts.map(h => h.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const pattern = new RegExp('(' + escaped.join('|') + ')')
  return (
    <section className="flex flex-col gap-4">
      <Shield aria-hidden="true" />
      <h3 className="text-lg font-semibold">Only add instances in an app you trust</h3>
      <p>
        {words.split(pattern).map((part, i) =>
          hosts.includes(part) ? (
            <strong key={i} className="streamer">
              {part}
            </strong>
          ) : (
            part
          )
        )}
      </p>
      <div className="flex justify-end gap-2">
        <button className={secondary} onClick={onCancel}>
          Cancel
        </button>
        <button autoFocus className={primary} onClick={onTrust}>
          I trust this app
        </button>
      </div>
    </section>
  )
}
export function AddInstanceFlow({
  initialOrigin,
  initialUsername,
  linkTarget = false,
  stay = false,
  onCancel,
  onDone,
}: {
  initialOrigin?: string
  initialUsername?: string
  linkTarget?: boolean
  stay?: boolean
  onCancel?: () => void
  onDone: (a: AccountSession) => void
}) {
  const streamer = useStore(s => s.streamer)
  const allowed = useAddingAllowed()
  const [step, setStep] = useState<AddStep>('address')
  const [address, setAddress] = useState(initialOrigin ?? '')
  const [target, setTarget] = useState<Target | null>(null)
  const [session, setSession] = useState<AccountSession | null>(null)
  const [duplicate, setDuplicate] = useState<string | null | undefined>()
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  const temp = useRef<AccountSession | null>(null)
  const book = useSyncExternalStore(
    client.book.subscribe,
    client.book.getState,
    client.book.getInitialState
  )
  const entry = book.instances.find(i => i.origin === target?.origin)
  const signed =
    entry?.accounts.filter(
      a => target && readLocal(accountStorage(target.conn).token(a.username))
    ) ?? []
  const guest =
    !!entry?.guest &&
    !!target?.settings.guests_enabled &&
    readLocal(accountStorage(target.conn).key('rchat_guest')) === '1'
  function discard() {
    const t = temp.current
    temp.current = null
    if (t && !t.store.getState().me && !t.store.getState().guest) t.store.dispose()
  }
  useEffect(
    () => () => {
      generation.current++
      discard()
    },
    []
  )
  function authenticate(t: Target) {
    discard()
    accountStorage(t.conn)
    rememberInstance(t.origin, t.info)
    const acct = new AccountSession(t.conn)
    temp.current = acct
    acct.store.setState({ instance: t.info, instanceHost: t.conn.host, settings: t.settings })
    setSession(acct)
    setDuplicate(undefined)
    setStep('signin')
  }
  async function probe(raw: string, direct = false) {
    if (!raw.trim()) return
    const token = ++generation.current
    setBusy(true)
    setError('')
    try {
      const own = ownInstance()
      if (own && !canAddInstance() && normalizeOrigin(raw) !== own.origin)
        throw new Error(`This site's app only connects to ${new URL(own.origin).host}.`)
      const { origin, info } = await resolveInstance(raw)
      if (token !== generation.current) return
      if (own && !canAddInstance() && origin !== own.origin)
        throw new Error(`This site's app only connects to ${new URL(own.origin).host}.`)
      const result = afterProbe(client.book.getState(), origin, info.id, {
        shell: !!shellInfo(),
        pageOrigin: window.location.origin,
        ownOrigin: own?.origin ?? null,
        knownAccountEntry: direct,
      })
      if (result.error) throw new Error(result.error)
      const conn = new InstanceConnection(
        origin === own?.origin ? own : endpointsFrom(origin, info),
        info,
        origin === own?.origin
      )
      const settings = siteSettings(await conn.api.getSettings())
      if (token !== generation.current) return
      const t = { origin, info, conn, settings }
      setTarget(t)
      if (linkTarget && (shellInfo() || origin !== window.location.origin)) setStep('trust')
      else if (result.step === 'signin') authenticate(t)
      else setStep(result.step)
    } catch (e) {
      if (token === generation.current) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (token === generation.current) setBusy(false)
    }
  }
  useEffect(() => {
    if (initialOrigin) void probe(initialOrigin, true)
  }, [initialOrigin])
  function back() {
    generation.current++
    discard()
    setSession(null)
    setTarget(null)
    setStep('address')
    setDuplicate(undefined)
    setError('')
    setBusy(false)
  }
  function complete(a: AccountSession) {
    if (temp.current !== a) discard()
    temp.current = null
    setSession(a)
    if (stay) setStep('done')
    else onDone(a)
  }
  function useExisting(user: string | null) {
    if (!target) return
    const a =
      client
        .live()
        .find(s => s !== temp.current && s.conn.origin === target.origin && userFor(s) === user) ??
      createSavedSession(target.origin, user)
    discard()
    onDone(a)
  }
  const cancel = onCancel ?? back
  return (
    <div className="flex flex-col gap-4" data-add-instance-step={step}>
      {step === 'address' && (
        <form
          className="flex flex-col gap-3"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void probe(address)
          }}
        >
          <label className="flex flex-col gap-1">
            Instance address
            <input
              autoFocus
              required
              disabled={busy || linkTarget}
              value={address}
              onChange={e => setAddress(e.target.value)}
              placeholder="chat.example.com"
              inputMode="url"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className="streamer rounded-lg border border-outline bg-transparent px-3 py-2"
            />
          </label>
          {!streamer && !linkTarget && (
            <div className="flex flex-wrap gap-2">
              {knownInstances()
                .filter(i => allowed || i.origin === ownInstance()?.origin)
                .map(({ origin, info }) => (
                  <button
                    type="button"
                    key={origin}
                    disabled={busy}
                    className={secondary}
                    onClick={() => {
                      setAddress(origin)
                      void probe(origin)
                    }}
                  >
                    {info.name} · {new URL(origin).host}
                  </button>
                ))}
            </div>
          )}
          <div className="flex justify-end gap-2">
            {onCancel && (
              <button type="button" onClick={onCancel} className={secondary}>
                Cancel
              </button>
            )}
            <button className={primary} disabled={busy || !address.trim()}>
              {busy ? 'Checking…' : 'Connect'}
            </button>
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="streamer text-error">
          {error}
        </p>
      )}
      {target && (
        <div className="rounded-xl bg-surface-container p-3">
          <div className="flex items-center gap-3">
            <span aria-hidden="true" className="streamer rounded-lg bg-primary-container p-2">
              {target.info.name.slice(0, 1)}
            </span>
            <div>
              <strong className="streamer">{target.info.name}</strong>
              <p className="streamer text-xs">
                {target.conn.host} · {target.info.version}
              </p>
            </div>
          </div>
          <p className="mt-2 text-xs">
            {passwordSignup(target.settings) ? 'Sign-up open' : 'Sign-up closed'} ·{' '}
            {target.settings.guests_enabled ? 'Guests allowed' : 'Guests off'} ·{' '}
            {target.settings.p2p ? 'P2P on' : 'P2P off'}
          </p>
        </div>
      )}
      {step === 'trust' && target && (
        <TrustNotice
          host={target.conn.host}
          onTrust={() => authenticate(target)}
          onCancel={cancel}
        />
      )}
      {step === 'known' && target && (
        <>
          {signed.map(a => (
            <div key={a.username} className="flex items-center justify-between gap-2">
              <p>
                You're signed in on <span className="streamer">{target.conn.host}</span> as{' '}
                <span className="streamer">{a.username}</span>.
              </p>
              <button className={secondary} onClick={() => useExisting(a.username)}>
                Switch
              </button>
            </div>
          ))}
          {guest && (
            <button className={secondary} onClick={() => useExisting(null)}>
              Switch to guest
            </button>
          )}
          <button className={primary} onClick={() => authenticate(target)}>
            Add another account on <span className="streamer">{target.conn.host}</span>
          </button>
        </>
      )}
      {step === 'signin' &&
        session &&
        target &&
        (duplicate !== undefined ? (
          <>
            <p role="status" className="streamer">
              {alreadySignedIn(duplicate ?? 'guest', target.conn.host)}
            </p>
            <button className={primary} onClick={() => useExisting(duplicate)}>
              Switch
            </button>
            <button className={secondary} onClick={() => setDuplicate(undefined)}>
              Use a different account
            </button>
          </>
        ) : (
          <AccountProvider session={session}>
            <SignInStep
              key={session.renderKey}
              adding
              owner={initialUsername ? { username: initialUsername, host: target.conn.host } : null}
              selectAccount={(name, mode) => {
                const keys = accountStorage(target.conn)
                if (
                  name === null
                    ? readLocal(keys.key('rchat_guest')) === '1'
                    : !!readLocal(keys.token(name))
                ) {
                  setDuplicate(name)
                  return null
                }
                // Registration creates a new owner. Its connection has no saved login to restore.
                if (mode === 'register') {
                  session.credentialTarget = undefined
                  return session
                }
                const targetAccount =
                  client
                    .live()
                    .find(
                      a => a !== session && a.conn.origin === target.origin && userFor(a) === name
                    ) ?? session
                targetAccount.credentialTarget = name
                return targetAccount
              }}
              onSuccess={complete}
            />
          </AccountProvider>
        ))}
      {!linkTarget && (step === 'known' || step === 'signin') && (
        <button className={secondary} onClick={back}>
          Change instance
        </button>
      )}
      {step === 'done' && session && (
        <>
          <p>Added. Switch now?</p>
          <div className="flex gap-2">
            <button className={primary} onClick={() => onDone(session)}>
              Switch
            </button>
            <button className={secondary} onClick={onCancel}>
              Later
            </button>
          </div>
        </>
      )}
    </div>
  )
}
export function AddInstanceDialog({
  initialOrigin,
  initialUsername,
}: {
  initialOrigin?: string
  initialUsername?: string
}) {
  const actor = useAccount()
  const close = actor.store.getState().closeDialog
  return (
    <Dialog full title={initialOrigin ? 'Add an account' : 'Add an instance'} onClose={close}>
      <AddInstanceFlow
        initialOrigin={initialOrigin}
        initialUsername={initialUsername}
        onCancel={close}
        onDone={a => {
          close()
          client.show(a)
          if (!a.store.getState().me && !a.store.getState().guest)
            void a.store.getState().bootstrap()
        }}
      />
    </Dialog>
  )
}
