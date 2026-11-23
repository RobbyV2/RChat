import type { AccountSession } from '../lib/client/session'
import { accountPath, type RouteOwner } from '../lib/view'

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

export function UnavailableAccount() {
  return (
    <main className="flex h-app flex-col items-center justify-center gap-3 px-6 text-center">
      <p>This saved account is unavailable.</p>
      <a className="text-primary underline" href="/">
        Back to home
      </a>
    </main>
  )
}
