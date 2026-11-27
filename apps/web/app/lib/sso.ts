import { watchProviderConfirmation } from './provider_confirmation'
import type { AccountSession } from './client/session'
import { allowsAccountOrigin } from './client/hosted_policy'
import { authBrowser } from './platform'
import { readLocal, writeLocal, sessionStore } from './instances'
import { apiRoot } from './api_version'
import { safeNext } from './invite'
import type { AuthInfo, LinkedProvider, Me } from './types'
import { time } from './platform/time'

export const canUnlink = (
  me: Pick<Me, 'has_password'>,
  links: LinkedProvider[],
  provider: string
) => {
  const link = links.find(p => p.provider === provider)
  return (
    !!link &&
    (link.can_unlink ?? (me.has_password === true || links.some(p => p.provider !== provider)))
  )
}
export const linkable = (auth: AuthInfo, links: LinkedProvider[]) =>
  auth.providers.filter(p => !links.some(link => link.provider === p.id))

export const SSO_KEY = 'rchat_sso'
export { SSO_LOGOUT_KEY } from './client/keys'
export function parseLogoutFlag(raw: string | null): boolean {
  try {
    const flag = JSON.parse(raw ?? 'null')
    return flag?.v === 1 && flag.on === true
  } catch {
    return false
  }
}
export const INTENT_TTL_MS = 600_000
export const DEFAULT_AUTH: AuthInfo = { password_login: true, registration: 'open', providers: [] }
export type SsoPurpose = 'login' | 'link' | 'reauth'
const messages = {
  expired: 'That sign-in expired. Try again.',
  denied: 'Sign-in was cancelled.',
  failed: 'Sign-in failed. Try again.',
  unavailable: 'The sign-in service is unavailable. Try again later.',
  not_allowed: "Your account can't sign in here.",
  suspended: 'This account is suspended.',
  closed: 'New accounts are closed.',
  popup: 'Allow pop-ups for this site, then try again.',
}
export type SsoErrorCode = keyof typeof messages
export const errorText = (e: SsoErrorCode) => messages[e]
export interface SsoIntent {
  v: 1
  purpose: SsoPurpose
  confirm?: true
  origin: string
  username: string | null
  provider: string
  back: string
  verifier: string
  at: number
  code?: string
  error?: SsoErrorCode
}
const base64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/, '')
export const newVerifier = () => base64url(crypto.getRandomValues(new Uint8Array(32)))
export const challengeOf = async (v: string) =>
  base64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(v))))
export function startUrl(
  api: string,
  id: string,
  ret: 'web' | 'app',
  challenge: string,
  ticket?: string,
  confirm = false
) {
  const params = new URLSearchParams({ return: ret, challenge })
  if (confirm) params.set('confirm', '1')
  if (ticket) params.set('ticket', ticket)
  return apiRoot(api) + '/auth/oidc/' + encodeURIComponent(id) + '/start?' + params
}
export function parseReturn(search: string): { code: string } | { error: SsoErrorCode } | null {
  const p = new URLSearchParams(search),
    err = p.get('error'),
    code = p.get('code')
  if (err) return { error: Object.hasOwn(messages, err) ? (err as SsoErrorCode) : 'failed' }
  return code && code.length <= 64 ? { code } : null
}
export function parseIntent(raw: string | null, now: number): SsoIntent | null {
  try {
    const i = JSON.parse(raw ?? 'null')
    if (
      !i ||
      i.v !== 1 ||
      !['login', 'link', 'reauth'].includes(i.purpose) ||
      (i.confirm !== undefined && (i.confirm !== true || i.purpose !== 'login' || !i.username)) ||
      !Number.isFinite(i.at) ||
      i.at > now ||
      now - i.at >= INTENT_TTL_MS ||
      typeof i.verifier !== 'string' ||
      !/^[A-Za-z0-9_-]{43,128}$/.test(i.verifier) ||
      typeof i.provider !== 'string' ||
      typeof i.origin !== 'string' ||
      new URL(i.origin).origin !== i.origin ||
      !/^https?:/.test(i.origin) ||
      !(i.username === null || typeof i.username === 'string') ||
      !safeNext(i.back)
    )
      return null
    return i
  } catch {
    return null
  }
}
export const showPasswordForm = (auth: AuthInfo | undefined, search: string) =>
  !auth?.providers.length || auth.password_login || new URLSearchParams(search).get('local') === '1'
export const showRegister = (auth: AuthInfo = DEFAULT_AUTH) =>
  auth.registration === 'open' && auth.password_login
// Shell callbacks arrive with an issuer host and a code, even after the OS recreates the
// WebView. Keep a single outstanding native login and qualify its verifier by issuer and account.
const activeLogin = 'rchat_sso_app_login'
const loginSlot = (i: SsoIntent) => activeLogin + ':' + JSON.stringify([i.origin, i.username])

function nativeLogin() {
  const slot = readLocal(activeLogin)
  if (!slot?.startsWith(activeLogin + ':')) return null
  const intent = parseIntent(readLocal(slot), time().now())
  if (intent?.purpose === 'login' && slot === loginSlot(intent)) return intent
  writeLocal(slot, null)
  writeLocal(activeLogin, null)
  return null
}

export function readIntent() {
  if (authBrowser().returnTo === 'app') {
    const persisted = nativeLogin()
    if (persisted) return persisted
  }
  const raw = sessionStore.getItem(SSO_KEY)
  const parsed = parseIntent(raw, time().now())
  if (raw && !parsed) sessionStore.removeItem(SSO_KEY)
  return parsed
}
export function clearIntent(i: SsoIntent) {
  if (authBrowser().returnTo === 'app' && nativeLogin()?.verifier === i.verifier) {
    writeLocal(loginSlot(i), null)
    writeLocal(activeLogin, null)
  }
  if (parseIntent(sessionStore.getItem(SSO_KEY), time().now())?.verifier === i.verifier)
    sessionStore.removeItem(SSO_KEY)
}

function saveIntent(intent: SsoIntent) {
  if (authBrowser().returnTo === 'app') {
    const old = nativeLogin()
    if (old) clearIntent(old)
    if (intent.purpose === 'login') {
      sessionStore.removeItem(SSO_KEY)
      const slot = loginSlot(intent)
      if (
        !writeLocal(slot, JSON.stringify(intent)) ||
        !writeLocal(activeLogin, slot) ||
        nativeLogin()?.verifier !== intent.verifier
      ) {
        writeLocal(slot, null)
        throw new Error('This app could not save the sign-in request. Try again.')
      }
      return
    }
  }
  sessionStore.setItem(SSO_KEY, JSON.stringify(intent))
}
export const canBegin = (origin: string) =>
  allowsAccountOrigin(origin) && (authBrowser().returnTo === 'app' || location.origin === origin)
async function begin(
  owner: AccountSession,
  provider: string,
  back: string,
  username: string | null,
  purpose: SsoPurpose,
  ticket?: string,
  confirm = false
) {
  const origin = owner.conn.origin,
    mark = owner.lifetime.sessionMark()
  if (!canBegin(origin)) throw new Error(errorText('not_allowed'))
  const intent: SsoIntent = {
    v: 1,
    origin,
    provider,
    username,
    purpose,
    ...(confirm ? { confirm: true as const } : {}),
    back: safeNext(back) ?? '/',
    verifier: newVerifier(),
    at: time().now(),
  }
  saveIntent(intent)
  const challenge = await challengeOf(intent.verifier)
  if (
    mark !== owner.lifetime.sessionMark() ||
    !canBegin(origin) ||
    readIntent()?.verifier !== intent.verifier
  ) {
    clearIntent(intent)
    throw new Error(errorText('expired'))
  }
  return {
    intent,
    url: startUrl(owner.api.base, provider, authBrowser().returnTo, challenge, ticket, confirm),
  }
}
export async function beginLogin(
  owner: AccountSession,
  provider: string,
  back: string,
  username: string | null = null,
  accept: (intent: SsoIntent) => boolean = () => true,
  confirm = false
) {
  if (confirm && (!username || owner.store.getState().instance?.auth?.confirm_login !== true))
    throw Error(errorText('unavailable'))
  const { intent, url } = await begin(owner, provider, back, username, 'login', undefined, confirm)
  if (!accept(intent)) {
    clearIntent(intent)
    return
  }
  try {
    await authBrowser().navigate(url)
  } catch (e) {
    clearIntent(intent)
    throw e
  }
}
export function deliverReturn(search: string, origin: string) {
  const i = readIntent(),
    result = parseReturn(search)
  if (!i || i.origin !== origin || !allowsAccountOrigin(origin) || i.purpose === 'login' || !result)
    return false
  sessionStore.setItem(SSO_KEY, JSON.stringify({ ...i, ...result }))
  window.dispatchEvent(new Event('rchat-sso-return'))
  return true
}
export async function beginPopup(
  owner: AccountSession,
  provider: string,
  purpose: 'link' | 'reauth',
  ticket: string,
  current: () => boolean = () => true
) {
  if (!current()) throw 'expired'
  const mark = owner.lifetime.sessionMark()
  const { intent, url } = await begin(
    owner,
    provider,
    location.pathname + location.search,
    owner.store.getState().me?.username ?? null,
    purpose,
    ticket
  )
  if (!current()) {
    clearIntent(intent)
    throw 'expired'
  }
  return new Promise<{ code: string; verifier: string }>((resolve, reject) => {
    const done = (error?: SsoErrorCode, code?: string) => {
      unwatch?.()
      poll()
      timer()
      window.removeEventListener('message', message)
      window.removeEventListener('rchat-sso-return', check)
      clearIntent(intent)
      if (error) reject(error)
      else resolve({ code: code!, verifier: intent.verifier })
    }
    const check = () => {
      const i = readIntent()
      if (
        !current() ||
        i?.verifier !== intent.verifier ||
        !allowsAccountOrigin(i.origin) ||
        owner.lifetime.sessionMark() !== mark
      )
        return done('expired')
      if (i.error) done(i.error)
      else if (i.code) done(undefined, i.code)
    }
    const message = (e: MessageEvent) => {
      if (
        current() &&
        readIntent()?.verifier === intent.verifier &&
        e.origin === location.origin &&
        e.data?.type === 'rchat-sso-return' &&
        e.data.challenge === new URL(url, intent.origin).searchParams.get('challenge') &&
        typeof e.data.search === 'string'
      )
        deliverReturn(e.data.search, intent.origin)
    }
    let popup: { closed: boolean } | undefined
    const unwatch =
      purpose === 'reauth'
        ? watchProviderConfirmation(
            owner,
            provider,
            () => current() && !popup?.closed && readIntent()?.verifier === intent.verifier,
            () => done('expired')
          )
        : undefined
    const poll = time().every(300, () => {
      if (!current()) done('expired')
      else if (popup?.closed) done('denied')
    })
    const timer = time().after(INTENT_TTL_MS, () => done('expired'))
    window.addEventListener('message', message)
    window.addEventListener('rchat-sso-return', check)
    Promise.resolve(authBrowser().popup(url)).then(
      ok => {
        if (!ok) done('popup')
        else if (typeof ok === 'object') popup = ok
      },
      () => done('unavailable')
    )
  })
}
