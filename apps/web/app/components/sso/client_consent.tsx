'use client'
import { Button } from '../controls'
import { Row, Surface } from '../layout'
import { useEffect, useRef, useState } from 'react'
import { CLIENT_SSO, decideClientConsent, type ConsentResult } from '../../lib/client_sso'
import { errorText, parseReturn } from '../../lib/sso'

export function ClientConsent({ fragment }: { fragment: string }) {
  const [details, setDetails] = useState<ConsentResult | null>(null),
    [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false)
  const mounted = useRef(false)
  const receipt = new URLSearchParams(fragment).get('consent') ?? ''
  useEffect(() => {
    mounted.current = true
    let alive = true,
      challenge = '',
      origin = ''
    const opener = window.opener
    const message = (e: MessageEvent) => {
      if (
        alive &&
        origin &&
        e.source === opener &&
        e.origin === origin &&
        e.data?.type === CLIENT_SSO &&
        e.data.ack === true &&
        e.data.challenge === challenge
      )
        setReady(true)
    }
    window.addEventListener('message', message)
    const params = new URLSearchParams(fragment)
    const problem = params.get('client_error')
    if (problem) {
      const result = parseReturn(new URLSearchParams({ error: problem }).toString())
      setError(result && 'error' in result ? errorText(result.error) : errorText('failed'))
      const origin = params.get('origin')
      if (origin && opener) {
        try {
          opener.postMessage({ type: CLIENT_SSO, error: problem }, origin)
        } catch {
          /* Invalid return. */
        }
      }
    } else if (opener && window.top === window.self && /^[a-f0-9]{64}$/.test(receipt)) {
      void decideClientConsent(receipt, 'describe')
        .then(d => {
          if (!alive) return
          origin = d.origin
          challenge = d.challenge
          setDetails(d)
          opener.postMessage({ type: CLIENT_SSO, ready: true, challenge }, origin)
        })
        .catch(() => {
          if (alive) setError(errorText('expired'))
        })
    } else setError(errorText('expired'))
    return () => {
      alive = false
      mounted.current = false
      window.removeEventListener('message', message)
    }
  }, [fragment, receipt])
  async function decide(allow: boolean) {
    if (!details || busy || (allow && !ready)) return
    setBusy(true)
    try {
      const d = await decideClientConsent(receipt, allow ? 'allow' : 'cancel')
      if (!mounted.current || d.origin !== details.origin || d.challenge !== details.challenge)
        return
      window.opener?.postMessage(
        {
          type: CLIENT_SSO,
          challenge: d.challenge,
          ...(allow ? { code: d.code } : { error: 'denied' }),
        },
        d.origin
      )
      // Let the opener consume the posted event and close this window.
      if (!allow) setError(errorText('denied'))
    } catch {
      setError(errorText('expired'))
    }
  }
  return (
    <Surface tone="plain" radius="none" pad="xl">
      <Surface as="main" tone="low" pad="lg" gap="lg" place="mx-auto w-full max-w-md">
        {error ? (
          <p role="alert">{error}</p>
        ) : details ? (
          <>
            <h1 className="text-xl font-medium">
              Sign in to {location.host} for the app at {details.origin}?
            </h1>
            <p>This app will be able to read and send messages as your account.</p>
            <Row gap="md" justify="end">
              <Button size="md" disabled={busy} onClick={() => void decide(false)}>
                Cancel
              </Button>
              <Button
                variant="filled"
                size="md"
                disabled={!ready || busy}
                onClick={() => void decide(true)}
              >
                Allow
              </Button>
            </Row>
          </>
        ) : (
          <p>Checking sign-in…</p>
        )}
      </Surface>
    </Surface>
  )
}
