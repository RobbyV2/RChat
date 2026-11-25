import { storedCredential } from './client/credentials'
import { client } from './client/client'
import type { AccountSession } from './client/session'
import type { ProviderConfirmation } from './types'

// The expired popup supplies only a login hint. Its verifier, code and Settings
// operation are discarded before the next sign-in can start.
const interruptions = new WeakMap<AccountSession, () => void>()
const hints = new WeakMap<
  AccountSession,
  {
    origin: string
    username: string
    provider: string
    foreground: number
    until: number
  }
>()

export function watchProviderConfirmation(
  account: AccountSession,
  provider: string,
  current: () => boolean,
  abort?: () => void
) {
  const supportsConfirmation = account.store.getState().instance?.auth?.confirm_login === true
  const interrupt = () => {
    const { me, token } = account.store.getState()
    if (supportsConfirmation && current() && token && me && client.canWritePage(account)) {
      account.credentialTarget = me.username
      hints.set(account, {
        origin: account.conn.origin,
        username: me.username,
        provider,
        foreground: client.shownVersion(),
        until: Date.now() + 300_000,
      })
    }
    abort?.()
  }
  interruptions.set(account, interrupt)
  return () => {
    if (interruptions.get(account) === interrupt) interruptions.delete(account)
  }
}

export function interruptProviderPopup(account: AccountSession) {
  interruptions.get(account)?.()
}

export function clearConfirmationHint(account: AccountSession) {
  hints.delete(account)
}

export function confirmationHint(account: AccountSession) {
  const hint = hints.get(account)
  if (
    hint &&
    hint.origin === account.conn.origin &&
    hint.username === account.credentialTarget &&
    hint.foreground === client.shownVersion() &&
    client.canWritePage(account) &&
    !account.store.getState().token &&
    hint.until > Date.now()
  )
    return hint
}

// Both the callback owner and a saved sibling may be cold when the exchange
// starts. A replacement credential on either one supersedes this sign-in.
export function confirmationLoginGuard(account: AccountSession, username: string) {
  const origin = account.conn.origin
  const foreground = client.shownVersion()
  const owners = () =>
    client
      .live()
      .filter(
        a =>
          a.conn.origin === origin &&
          (a === account || (a.store.getState().me?.username ?? a.credentialTarget) === username)
      )
  const marks = new Map(owners().map(a => [a, a.lifetime.sessionMark()]))
  return () => {
    const live = owners()
    return (
      client.shownVersion() === foreground &&
      account.conn.origin === origin &&
      account.credentialTarget === username &&
      live.includes(account) &&
      live.length === marks.size &&
      live.every(
        a =>
          marks.get(a) === a.lifetime.sessionMark() &&
          !a.store.getState().token &&
          !a.store.getState().guest
      ) &&
      !storedCredential(account.conn, client.book.getState(), username)
    )
  }
}

export function acceptRecentConfirmation(
  account: AccountSession,
  username: string,
  token: string,
  provider: string,
  proof?: ProviderConfirmation
) {
  const state = account.store.getState()
  if (
    !client.canWritePage(account) ||
    state.token !== token ||
    state.me?.username !== username ||
    proof?.provider !== provider ||
    typeof proof.code !== 'string' ||
    !proof.code ||
    !Number.isFinite(proof.expires_at) ||
    proof.expires_at <= Date.now() / 1000
  )
    return
  account.store.setState({
    providerConfirmation: {
      proof,
      token,
      username,
      mark: account.lifetime.sessionMark(),
      foreground: client.shownVersion(),
    },
  })
}

export function recentConfirmation(account: AccountSession, provider: string) {
  const state = account.store.getState()
  const saved = state.providerConfirmation
  return saved &&
    saved.proof.provider === provider &&
    saved.proof.expires_at > Date.now() / 1000 &&
    state.token === saved.token &&
    state.me?.username === saved.username &&
    saved.mark === account.lifetime.sessionMark() &&
    saved.foreground === client.shownVersion() &&
    client.canWritePage(account)
    ? saved.proof
    : undefined
}

export function takeRecentConfirmation(
  account: AccountSession,
  provider: string
): ProviderConfirmation {
  const proof = recentConfirmation(account, provider)
  if (!proof) throw Error('Sign-in expired')
  account.store.setState({ providerConfirmation: undefined })
  return proof
}
