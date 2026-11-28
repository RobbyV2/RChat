'use client'

import { ask, sendTo } from '../lib/asks'
import { Name, NameInput } from './name'
import { handleName, instanceAddress, instanceName } from '../lib/names'
import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react'
import { Shield } from 'lucide-react'
import {
  allowsAccountOrigin,
  canAddInstance,
  hostedLockMessage,
  watchHostedPolicy,
} from '../lib/client/hosted_policy'
import { client } from '../lib/client/client'
import { AccountSession } from '../lib/client/session'
import { createSavedSession } from '../lib/client/saved_session'
import { AccountProvider, useAccount, useStore } from '../lib/client/react'
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
import { Button } from './controls'
import { Row, Stack, Surface } from './layout'
import { Dialog } from './ui'
import { SignInStep } from './sign_in_step'
export { SignInStep } from './sign_in_step'

export function useAddingAllowed() {
  return useSyncExternalStore(watchHostedPolicy, canAddInstance, () => true)
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
    <Stack as="section" gap="lg">
      <Shield aria-hidden="true" />
      <h3 className="text-lg font-semibold">Only add instances in an app you trust</h3>
      <p>
        {words
          .split(pattern)
          .map((part, i) =>
            hosts.includes(part) ? <Name key={i} as="strong" of={instanceAddress(part)} /> : part
          )}
      </p>
      <Row gap="sm" justify="end">
        <Button size="md" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="filled" size="md" autoFocus onClick={onTrust}>
          I trust this app
        </Button>
      </Row>
    </Stack>
  )
}
export function AddInstanceFlow({
  initialOrigin,
  initialUsername,
  providerBack,
  linkTarget = false,
  stay = false,
  onCancel,
  onDone,
}: {
  initialOrigin?: string
  initialUsername?: string
  providerBack?: string
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
    if (!allowsAccountOrigin(t.origin)) return
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
      const settings = siteSettings(await sendTo(conn, ask.getSettings()))
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
    if (!allowsAccountOrigin(a.conn.origin)) return
    if (temp.current !== a) discard()
    temp.current = null
    setSession(a)
    if (stay) setStep('done')
    else onDone(a)
  }
  function useExisting(user: string | null) {
    if (!target || !allowsAccountOrigin(target.origin)) return
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
    <Stack gap="lg" data-add-instance-step={step}>
      {step === 'address' && (
        <Stack
          as="form"
          gap="md"
          onSubmit={(e: FormEvent) => {
            e.preventDefault()
            void probe(address)
          }}
        >
          <Stack as="label" gap="2xs">
            Instance address
            <NameInput
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
            />
          </Stack>
          {!streamer && !linkTarget && (
            <Row gap="sm" align="stretch" wrap>
              {knownInstances()
                .filter(i => allowed || i.origin === ownInstance()?.origin)
                .map(({ origin, info }) => (
                  <Button
                    size="md"
                    key={origin}
                    disabled={busy}
                    onClick={() => {
                      setAddress(origin)
                      void probe(origin)
                    }}
                  >
                    {info.name} · {new URL(origin).host}
                  </Button>
                ))}
            </Row>
          )}
          <Row gap="sm" justify="end">
            {onCancel && (
              <Button size="md" onClick={onCancel}>
                Cancel
              </Button>
            )}
            <Button type="submit" variant="filled" size="md" disabled={busy || !address.trim()}>
              {busy ? 'Checking…' : 'Connect'}
            </Button>
          </Row>
        </Stack>
      )}
      {error && (
        <p role="alert" className="streamer text-error">
          {error}
        </p>
      )}
      {target && (
        <Surface tone="base" radius="lg" pad="md" gap="sm">
          <Row gap="md">
            <Surface
              aria-hidden="true"
              as="span"
              pad="sm"
              tone="primary"
              radius="md"
              look="streamer"
            >
              {target.info.name.slice(0, 1)}
            </Surface>
            <div>
              <Name as="strong" of={instanceName(target.info.name)} />
              <p className="streamer text-xs">
                {target.conn.host} · {target.info.version}
              </p>
            </div>
          </Row>
          <p className="text-xs">
            {passwordSignup(target.settings) ? 'Sign-up open' : 'Sign-up closed'} ·{' '}
            {target.settings.guests_enabled ? 'Guests allowed' : 'Guests off'} ·{' '}
            {target.settings.p2p ? 'P2P on' : 'P2P off'}
          </p>
        </Surface>
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
            <Row key={a.username} gap="sm" justify="between">
              <p>
                You're signed in on <Name of={instanceAddress(target.conn.host)} /> as{' '}
                <Name of={handleName(a.username)} />.
              </p>
              <Button size="md" onClick={() => useExisting(a.username)}>
                Switch
              </Button>
            </Row>
          ))}
          {guest && (
            <Button size="md" onClick={() => useExisting(null)}>
              Switch to guest
            </Button>
          )}
          <Button variant="filled" size="md" onClick={() => authenticate(target)}>
            Add another account on <Name of={instanceAddress(target.conn.host)} />
          </Button>
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
            <Button variant="filled" size="md" onClick={() => useExisting(duplicate)}>
              Switch
            </Button>
            <Button size="md" onClick={() => setDuplicate(undefined)}>
              Use a different account
            </Button>
          </>
        ) : (
          <AccountProvider session={session}>
            <SignInStep
              key={session.renderKey}
              adding
              back={providerBack}
              owner={initialUsername ? { username: initialUsername, host: target.conn.host } : null}
              selectAccount={(name, mode) => {
                if (!allowsAccountOrigin(target.origin)) return null
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
        <Button size="md" onClick={back}>
          Change instance
        </Button>
      )}
      {step === 'done' && session && (
        <>
          <p>Added. Switch now?</p>
          <Row gap="sm">
            <Button variant="filled" size="md" onClick={() => onDone(session)}>
              Switch
            </Button>
            <Button size="md" onClick={onCancel}>
              Later
            </Button>
          </Row>
        </>
      )}
    </Stack>
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
  const allowed = useAddingAllowed()
  if (!allowed && (!initialOrigin || !allowsAccountOrigin(initialOrigin)))
    return (
      <Dialog full title="Add an account" onClose={close}>
        {hostedLockMessage()}
      </Dialog>
    )
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
