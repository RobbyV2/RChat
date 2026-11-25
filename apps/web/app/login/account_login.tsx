import Link from 'next/link'
import { confirmationHint } from '../lib/provider_confirmation'
import { canAddInstance, hostedLockMessage } from '../lib/client/hosted_policy'
import { ownInstance } from '../lib/instances'
import { routeOwnerFor } from '../lib/client/account_paths'
import type { AccountSession } from '../lib/client/session'
import { accountPath, parseAccountPath, type RouteOwner } from '../lib/view'

// An explicit logout ends the actor's session. The login page can now accept a
// different username on this connection. Automatic reauthentication keeps its pin.
export function logoutForLogin(account: AccountSession) {
  account.store.getState().logout()
  account.credentialTarget = undefined
}

export function loginHref(next = '/', owner?: RouteOwner | null) {
  const target = accountPath(next, owner)
  return target === '/' ? '/login' : '/login?next=' + encodeURIComponent(target)
}

export function SignedOutAccount({ account }: { account: AccountSession }) {
  const { pathname, search, hash } = window.location
  const hint = confirmationHint(account)
  const SignInLink = hint ? Link : 'a'
  return (
    <main className="flex h-app flex-col items-center justify-center gap-3 px-6 text-center">
      <p>You’re signed out of this account.</p>
      <SignInLink
        className="text-primary underline"
        href={loginHref(
          pathname + search + hash,
          hint ? { username: hint.username, host: account.conn.host } : routeOwnerFor(account)
        )}
      >
        Sign in again
      </SignInLink>
    </main>
  )
}

export function UnavailableAccount() {
  const page = typeof window === 'undefined' ? null : window
  const path =
    page && (new URLSearchParams(page.location.search).get('next') ?? page.location.pathname)
  const owner = path && parseAccountPath(path)?.owner
  const origin = ownInstance()?.origin
  const entry = page?.history.state
  const restricted =
    !canAddInstance() &&
    origin &&
    owner &&
    (owner.host !== new URL(origin).host ||
      (entry?.acct === (owner.username ?? '~guest') + '@' + owner.host &&
        entry.rchatOrigin &&
        entry.rchatOrigin !== origin))
  return (
    <main className="flex h-app flex-col items-center justify-center gap-3 px-6 text-center">
      <p>{restricted ? hostedLockMessage() : 'This saved account is unavailable.'}</p>
      <a className="text-primary underline" href="/">
        Back to home
      </a>
    </main>
  )
}
