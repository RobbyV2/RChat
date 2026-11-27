import { clientConsent } from './api/public'
import { apiRoot } from './api_version'
import { challengeOf, errorText, INTENT_TTL_MS, newVerifier, parseReturn } from './sso'
import { allowsAccountOrigin } from './client/hosted_policy'
import type { AccountSession } from './client/session'

export const CLIENT_SSO = 'rchat-client-sso'
export function clientLogin(owner: AccountSession, provider: string, signal: AbortSignal) {
  const origin = owner.conn.origin
  if (!allowsAccountOrigin(origin) || signal.aborted) throw Error(errorText('expired'))
  // Reserve the window during the click, before asynchronous PKCE hashing.
  const popup = window.open('about:blank', '_blank', 'popup,width=520,height=720')
  if (!popup) throw Error(errorText('popup'))
  const verifier = newVerifier()
  return new Promise<{ code: string; verifier: string }>((resolve, reject) => {
    let challenge = '',
      settled = false
    const finish = (code?: string, message = errorText('denied')) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearInterval(closed)
      window.removeEventListener('message', onMessage)
      signal.removeEventListener('abort', abort)
      if (!popup.closed) popup.close()
      if (code) resolve({ code, verifier })
      else reject(Error(message))
    }
    const abort = () => finish(undefined, errorText('expired'))
    const onMessage = (event: MessageEvent) => {
      if (event.source !== popup || event.origin !== origin || event.data?.type !== CLIENT_SSO)
        return
      if (!allowsAccountOrigin(origin) || signal.aborted) return abort()
      if (event.data.error) {
        const result = parseReturn(
          new URLSearchParams({ error: String(event.data.error) }).toString()
        )
        return finish(
          undefined,
          result && 'error' in result ? errorText(result.error) : errorText('failed')
        )
      }
      if (!challenge || event.data.challenge !== challenge) return
      if (event.data.ready === true) {
        popup.postMessage({ type: CLIENT_SSO, ack: true, challenge }, origin)
        return
      }
      if (typeof event.data.code === 'string' && /^[a-f0-9]{64}$/.test(event.data.code))
        finish(event.data.code)
    }
    const closed = setInterval(() => {
      if (popup.closed) finish()
    }, 300)
    const timer = setTimeout(abort, INTENT_TTL_MS)
    window.addEventListener('message', onMessage)
    signal.addEventListener('abort', abort, { once: true })
    void challengeOf(verifier)
      .then(value => {
        if (settled) return
        challenge = value
        const start = new URL(
          apiRoot(owner.api.base) + '/auth/oidc/' + encodeURIComponent(provider) + '/start',
          origin
        )
        start.search = new URLSearchParams({
          return: 'client',
          origin: location.origin,
          challenge,
        }).toString()
        popup.location.replace(start.href)
      })
      .catch(() => finish(undefined, errorText('unavailable')))
  })
}

export interface ConsentResult {
  origin: string
  challenge: string
  code?: string
}
export async function decideClientConsent(
  receipt: string,
  action: 'describe' | 'allow' | 'cancel'
): Promise<ConsentResult> {
  const result = await clientConsent({ receipt, action }).send()
  if (!result.ok) throw Error(errorText('expired'))
  return result.json()
}
