'use client'
import { useEffect, useRef, useState } from 'react'
import type { AccountSession } from '../../lib/client/session'
import type { AuthInfo } from '../../lib/types'
import { ClientLogin } from './client_login'
import { allowsAccountOrigin } from '../../lib/client/hosted_policy'
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
  useEffect(() => {
    active.current = true
    return () => {
      active.current = false
      if (pending.current) clearIntent(pending.current)
    }
  }, [account])
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
  return (
    <>
      {providers.map(p => (
        <button
          key={p.id}
          type="button"
          className="rounded-full border border-outline px-4 py-2 text-primary"
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            setError('')
            try {
              await beginLogin(account, p.id, back, username, intent => {
                if (!active.current) return false
                pending.current = intent
                return true
              })
            } catch (e) {
              setError(e instanceof Error ? e.message : 'Sign-in failed. Try again.')
            } finally {
              setBusy(false)
            }
          }}
        >
          Continue with {p.name}
        </button>
      ))}
      {error && <p role="alert">{error}</p>}
      {divider && <p className="text-center text-sm text-on-surface-variant">or</p>}
    </>
  )
}
