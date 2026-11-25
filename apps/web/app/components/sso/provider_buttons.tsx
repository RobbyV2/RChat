'use client'
import { useEffect, useRef, useState } from 'react'
import type { AccountSession } from '../../lib/client/session'
import type { AuthInfo } from '../../lib/types'
import { ClientLogin } from './client_login'
import { allowsAccountOrigin } from '../../lib/client/hosted_policy'
import {
  confirmationHint,
  clearConfirmationHint,
  confirmationLoginGuard,
} from '../../lib/provider_confirmation'
import { client } from '../../lib/client/client'
import { beginLogin, canBegin, clearIntent, type SsoIntent } from '../../lib/sso'
export function ProviderButtons({
  account,
  providers,
  clientReturn,
  back,
  username,
  divider,
  onSuccess,
}: {
  account: AccountSession
  clientReturn: boolean
  providers: AuthInfo['providers']
  back: string
  username: string | null
  onSuccess: (account: AccountSession) => void
  divider: boolean
}) {
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const active = useRef(false)
  const pending = useRef<SsoIntent | null>(null)
  const cancelStale = useRef<(() => void) | null>(null)
  useEffect(() => {
    active.current = true
    const check = () => cancelStale.current?.()
    const unsubscribeAccount = account.store.subscribe(check)
    const unsubscribeFocus = client.subscribe(check)
    return () => {
      unsubscribeAccount()
      unsubscribeFocus()
      cancelStale.current = null
      active.current = false
      if (pending.current) clearIntent(pending.current)
    }
  }, [account, username])
  if (!providers.length) return null
  if (!allowsAccountOrigin(account.conn.origin)) return null
  if (!canBegin(account.conn.origin) && !clientReturn)
    return (
      <p>
        Single sign-on for {account.conn.host} works on {account.conn.host} and in the RChat apps.
      </p>
    )
  if (!canBegin(account.conn.origin))
    return (
      <ClientLogin
        account={account}
        username={username}
        providers={providers}
        onSuccess={onSuccess}
        divider={divider}
      />
    )
  const hint =
    account.store.getState().instance?.auth?.confirm_login === true && confirmationHint(account)
  const confirmProvider = hint && hint.username === username ? hint.provider : undefined
  async function start(provider: string, confirm: boolean) {
    if (confirm && (confirmationHint(account)?.provider !== provider || !username)) return
    const signedOut = confirm && username ? confirmationLoginGuard(account, username) : undefined
    const current = () => client.canWritePage(account) && (!signedOut || signedOut())
    cancelStale.current = null
    if (!confirm) clearConfirmationHint(account)
    setBusy(true)
    setError('')
    try {
      if (
        confirm &&
        (!(await account.store.getState().loadInstance(current, 'no-store')) || !current())
      )
        throw Error('Could not verify confirmation sign-in support. Try again.')
      await beginLogin(
        account,
        provider,
        back,
        username,
        intent => {
          if (!active.current || (confirm && !current())) return false
          pending.current = intent
          if (confirm)
            cancelStale.current = () => {
              if (!current()) {
                clearIntent(intent)
                cancelStale.current = null
              }
            }
          return true
        },
        confirm
      )
      if (confirm) clearConfirmationHint(account)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Sign-in failed. Try again.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      {providers
        .filter(p => p.id === confirmProvider)
        .map(p => (
          <button
            key={p.id}
            type="button"
            className="rounded-full border border-outline px-4 py-2 text-primary"
            disabled={busy}
            onClick={() => void start(p.id, true)}
          >
            Sign in again to confirm with {p.name}
          </button>
        ))}
      {providers.map(p => (
        <button
          key={p.id}
          type="button"
          className="rounded-full border border-outline px-4 py-2 text-primary"
          disabled={busy}
          onClick={() => void start(p.id, false)}
        >
          Continue with {p.name}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
      {divider && <p className="text-center text-sm text-on-surface-variant">or</p>}
    </>
  )
}
