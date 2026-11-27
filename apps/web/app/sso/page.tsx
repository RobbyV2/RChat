'use client'
import { Button } from '../components/controls'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { acceptRecentConfirmation, confirmationLoginGuard } from '../lib/provider_confirmation'
import { ClientConsent } from '../components/sso/client_consent'
import { authBrowser } from '../lib/platform'
import {
  beginLogin,
  INTENT_TTL_MS,
  challengeOf,
  readIntent,
  clearIntent,
  deliverReturn,
  parseReturn,
  errorText,
  type SsoIntent,
} from '../lib/sso'
import { allowsAccountOrigin, refreshHostedPolicy } from '../lib/client/hosted_policy'
import { createSavedSession } from '../lib/client/saved_session'
import { client } from '../lib/client/client'
import type { AccountSession } from '../lib/client/session'
import { accountPath } from '../lib/view'
import { routeOwnerFor } from '../lib/client/account_paths'
import { ApiError } from '../lib/api'
import { NAME_MAX } from '../lib/rules'
import type { ExchangeResponse } from '../lib/types'
import { sameSecret, Secret } from '../lib/secret'
export default function SsoPage() {
  const [fragment, setFragment] = useState<string | null>(null)
  useEffect(() => {
    setFragment(location.hash.slice(1))
  }, [])
  if (fragment === null) return null
  const params = new URLSearchParams(fragment)
  if (params.has('consent') || params.has('client_error'))
    return <ClientConsent fragment={fragment} />
  return <LocalReturn />
}
function LocalReturn() {
  const router = useRouter(),
    [error, setError] = useState(''),
    [picker, setPicker] = useState<Extract<ExchangeResponse, { kind: 'pick_username' }> | null>(
      null
    ),
    [retry, setRetry] = useState<Pick<
      SsoIntent,
      'origin' | 'provider' | 'username' | 'back' | 'confirm' | 'at'
    > | null>(null),
    [name, setName] = useState(''),
    [busy, setBusy] = useState(false)
  const pending = useRef<{ intent: SsoIntent; account: AccountSession; code: string } | null>(null)
  const restarted = useRef<SsoIntent | null>(null)
  const temporary = useRef<AccountSession | null>(null)
  const releaseTemporary = () => {
    const account = temporary.current
    temporary.current = null
    if (account && !account.store.getState().token && client.live().includes(account))
      account.store.dispose()
  }
  const mounted = useRef(false)
  async function exchange(username?: string) {
    const p = pending.current
    if (!p) return
    const { intent: i, account, code } = p
    const { origin, provider, username: savedName, back, confirm, at } = i
    const retryTarget = { origin, provider, username: savedName, back, confirm, at }
    const shownVersion = client.shownVersion()
    const valid = () =>
      (!i.confirm || client.shownVersion() === shownVersion) &&
      mounted.current &&
      readIntent()?.verifier === i.verifier &&
      allowsAccountOrigin(i.origin)
    setBusy(true)
    setError('')
    try {
      const result = await account.store.getState().ssoExchange(
        {
          code,
          verifier: i.verifier,
          username,
          ...(i.confirm && i.username ? { confirm_as: i.username } : {}),
        },
        valid
      )
      if (!valid()) return
      if (result.kind === 'pick_username') {
        if (i.username) {
          setRetry(retryTarget)
          throw new Error(
            `This provider account is not linked to ${i.username} on ${account.conn.host}. Restart sign-in with the provider account linked to that username.`
          )
        }
        setPicker(result)
        setName(i.username ?? result.suggestion ?? '')
        return
      }
      if (result.kind !== 'session') throw new Error(errorText('failed'))
      clearIntent(i)
      pending.current = null
      releaseTemporary()
      const signedIn = client
        .live()
        .find(
          a =>
            a.conn.origin === i.origin &&
            sameSecret(a.store.getState().token, Secret.from(result.token))
        )
      if (signedIn && client.show(signedIn, 'none')) {
        if (i.confirm && i.username && i.username === signedIn.store.getState().me?.username) {
          acceptRecentConfirmation(
            signedIn,
            i.username,
            result.token,
            i.provider,
            result.confirmation
          )
          signedIn.store.getState().openDialog({ kind: 'settings', section: 'profile' })
        }
        router.replace(accountPath(i.back, routeOwnerFor(signedIn)))
      }
    } catch (e) {
      if (!mounted.current) return
      const message = e instanceof Error ? e.message : errorText('failed')
      const mismatch =
        i.confirm &&
        e instanceof ApiError &&
        e.status === 403 &&
        message === 'Account does not match linked sign-in'
      if (valid() && i.username && (/saved username/.test(message) || mismatch))
        setRetry(retryTarget)
      if (username && e instanceof ApiError && e.status === 400 && !/expired/i.test(message)) {
        setError(message)
        return
      }
      clearIntent(i)
      pending.current = null
      releaseTemporary()
      setPicker(null)
      setError(
        mismatch
          ? `Sign in with the provider account linked to ${i.username} on ${account.conn.host}.`
          : e instanceof ApiError && e.status === 403
            ? errorText(
                /suspend/i.test(message)
                  ? 'suspended'
                  : /closed/i.test(message)
                    ? 'closed'
                    : 'not_allowed'
              )
            : message
      )
    } finally {
      if (mounted.current) setBusy(false)
    }
  }
  useEffect(() => {
    mounted.current = true
    let live = true
    void refreshHostedPolicy().then(async () => {
      if (!live) return
      const i = readIntent(),
        search = location.search,
        result = parseReturn(search)
      if (
        !i ||
        !result ||
        !allowsAccountOrigin(i.origin) ||
        (authBrowser().returnTo === 'web' && i.origin !== location.origin)
      ) {
        setError(errorText('expired'))
        return
      }
      if (i.purpose !== 'login') {
        if (window.opener) {
          const challenge = await challengeOf(i.verifier)
          if (!live || readIntent()?.verifier !== i.verifier) return
          window.opener.postMessage(
            { type: 'rchat-sso-return', challenge, search },
            location.origin
          )
          clearIntent(i)
          window.close()
        } else if (deliverReturn(search, i.origin)) {
          router.replace(i.back)
        }
        return
      }
      if ('error' in result) {
        clearIntent(i)
        setError(errorText(result.error))
        return
      }
      const shown = client.shown()
      const existing = client
        .live()
        .find(
          a =>
            a.conn.origin === i.origin &&
            (i.username
              ? (a.credentialTarget ?? a.store.getState().me?.username) === i.username
              : a === shown && !a.credentialTarget && !a.store.getState().me)
        )
      const account = existing ?? createSavedSession(i.origin, i.username ?? undefined)
      if (!existing) temporary.current = account
      pending.current = { intent: i, account, code: result.code }
      void exchange()
    })
    return () => {
      live = false
      mounted.current = false
      if (pending.current) clearIntent(pending.current.intent)
      pending.current = null
      releaseTemporary()
    }
    // Startup consumes the callback once. Username retries reuse the captured account and code.
  }, [])
  const submit = (e: FormEvent) => {
    e.preventDefault()
    if (!busy && name.trim()) void exchange(name.trim())
  }
  return (
    <main className="mx-auto mt-12 flex max-w-md flex-col gap-4 p-4">
      {picker ? (
        <form onSubmit={submit} className="flex flex-col gap-3">
          <h1>Pick a username</h1>
          <p>
            {picker.reason === 'taken' ? 'That name is taken.' : 'Choose a name for your account.'}
          </p>
          <label>
            Username
            <input
              value={name}
              maxLength={NAME_MAX}
              onChange={e => setName(e.target.value)}
              autoComplete="username"
              required
              className="block rounded border p-2"
            />
          </label>
          <Button type="submit" variant="filled" size="md" disabled={busy || !name.trim()}>
            Continue
          </Button>
        </form>
      ) : (
        !error && <p>Signing in…</p>
      )}
      {error && <p role="alert">{error}</p>}
      {retry && (
        <Button
          size="md"
          disabled={busy}
          onClick={async () => {
            const owner = createSavedSession(retry.origin, retry.username ?? undefined)
            setBusy(true)
            try {
              const signedOut =
                retry.confirm && retry.username
                  ? confirmationLoginGuard(owner, retry.username)
                  : undefined
              const current = () =>
                mounted.current &&
                (!signedOut || (signedOut() && Date.now() - retry.at < INTENT_TTL_MS))
              if (
                !current() ||
                (retry.confirm && !(await owner.store.getState().loadInstance(current, 'no-store')))
              )
                throw Error(errorText('expired'))
              await beginLogin(
                owner,
                retry.provider,
                retry.back,
                retry.username,
                intent => {
                  if (!current()) return false
                  restarted.current = intent
                  return true
                },
                retry.confirm
              )
            } catch (e) {
              setError(e instanceof Error ? e.message : errorText('failed'))
            } finally {
              owner.store.dispose()
              setBusy(false)
            }
          }}
        >
          Restart sign-in as {retry.username}
        </Button>
      )}
      {(error || picker) && (
        <a
          href="/login/"
          onClick={() => {
            if (restarted.current) clearIntent(restarted.current)
            if (pending.current) clearIntent(pending.current.intent)
          }}
        >
          Back to sign in
        </a>
      )}
    </main>
  )
}
