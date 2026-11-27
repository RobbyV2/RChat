'use client'
import { Button } from '../controls'
import { useEffect, useRef, useState } from 'react'
import { clientLogin } from '../../lib/client_sso'
import { createSavedSession } from '../../lib/client/saved_session'
import { client } from '../../lib/client/client'
import { allowsAccountOrigin } from '../../lib/client/hosted_policy'
import type { AccountSession } from '../../lib/client/session'
import { errorText } from '../../lib/sso'
import type { AuthInfo } from '../../lib/types'
import { NAME_MAX } from '../../lib/rules'
import { ApiError } from '../../lib/api'
import { sameSecret, Secret } from '../../lib/secret'
export function ClientLogin({
  account,
  providers,
  username,
  onSuccess,
  divider,
}: {
  account: AccountSession
  providers: AuthInfo['providers']
  username: string | null
  onSuccess: (account: AccountSession) => void
  divider: boolean
}) {
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [reason, setReason] = useState<'invalid' | 'taken' | null>(null),
    [name, setName] = useState('')
  const [restart, setRestart] = useState('')
  const flow = useRef<{ controller: AbortController; mark: object } | null>(null)
  const temporary = useRef<AccountSession | null>(null)
  function releaseTemporary() {
    const t = temporary.current
    temporary.current = null
    if (t && !t.store.getState().token && client.live().includes(t)) t.store.dispose()
  }
  const proof = useRef<{ code: string; verifier: string } | null>(null)
  useEffect(
    () => () => {
      flow.current?.controller.abort()
      releaseTemporary()
      proof.current = null
    },
    [account, username]
  )
  async function submit(provider?: string) {
    if (busy) return
    if (provider) {
      flow.current?.controller.abort()
      flow.current = { controller: new AbortController(), mark: account.lifetime.sessionMark() }
      proof.current = null
      setRestart('')
    }
    if (!flow.current) return
    const {
      controller: { signal },
      mark,
    } = flow.current
    const valid = () =>
      !signal.aborted &&
      account.lifetime.sessionMark() === mark &&
      allowsAccountOrigin(account.conn.origin) &&
      client.live().includes(account)
    setBusy(true)
    setError('')
    try {
      if (provider) proof.current = await clientLogin(account, provider, signal)
      if (!valid() || !proof.current) {
        proof.current = null
        setReason(null)
        if (!signal.aborted) setError(errorText('expired'))
        return
      }
      const existingPin = account.credentialTarget ?? account.store.getState().me?.username
      // The initiating session can still belong to the account that logged out.
      // Generic login must let the exchange match the verified user to a sibling.
      if (!username && existingPin && !temporary.current)
        temporary.current = createSavedSession(account.conn.origin)
      const target = temporary.current ?? account
      if (username && target.credentialTarget && target.credentialTarget !== username)
        throw Error(errorText('expired'))
      if (username) target.credentialTarget = username
      const result = await target.store
        .getState()
        .ssoExchange(
          { ...proof.current, ...(!provider ? { username: username ?? name.trim() } : {}) },
          valid
        )
      if (!valid()) return
      if (result.kind === 'pick_username') {
        if (username) {
          proof.current = null
          setReason(null)
          setRestart(provider ?? '')
          setError(
            `This provider account is not linked to ${username} on ${account.conn.host}. Restart sign-in with the provider account linked to that username.`
          )
          return
        }
        setReason(result.reason)
        setName(username ?? result.suggestion ?? '')
        return
      }
      if (result.kind !== 'session') throw Error(errorText('failed'))
      proof.current = null
      setReason(null)
      const signedIn = client
        .live()
        .find(
          a =>
            a.conn.origin === account.conn.origin &&
            sameSecret(a.store.getState().token, Secret.from(result.token))
        )
      releaseTemporary()
      if (signedIn) onSuccess(signedIn)
    } catch (e) {
      if (!valid()) return
      const message = e instanceof Error ? e.message : errorText('failed')
      const retry =
        !!reason && e instanceof ApiError && e.status === 400 && !/expired/i.test(message)
      if (!retry) {
        releaseTemporary()
        setReason(null)
        proof.current = null
      }
      setError(message)
    } finally {
      if (!signal.aborted) setBusy(false)
    }
  }
  if (reason)
    return (
      <form
        className="flex flex-col gap-3"
        onSubmit={e => {
          e.preventDefault()
          void submit()
        }}
      >
        <h2>Pick a username</h2>
        <p>{reason === 'taken' ? 'That name is taken.' : 'Choose a name for your account.'}</p>
        <label>
          Username
          <input
            value={name}
            readOnly={!!username}
            onChange={e => setName(e.target.value)}
            maxLength={NAME_MAX}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <Button type="submit" variant="filled" size="md" disabled={busy || !name.trim()}>
          Continue
        </Button>
      </form>
    )
  return (
    <>
      {restart && username && (
        <Button size="md" disabled={busy} onClick={() => void submit(restart)}>
          Restart sign-in as {username}
        </Button>
      )}
      {providers
        .filter(p => p.id !== restart)
        .map(p => (
          <Button
            key={p.id}
            variant="tonal"
            size="md"
            disabled={busy}
            onClick={() => void submit(p.id)}
          >
            Continue with {p.name}
          </Button>
        ))}
      {error && <p role="alert">{error}</p>}
      {divider && <p className="text-center text-sm text-on-surface-variant">or</p>}
    </>
  )
}
