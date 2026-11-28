'use client'
import { Loaded, useAccountRequest } from '../loaded'
import { statusOf } from '../../lib/api_errors'
import {
  recentConfirmation,
  takeRecentConfirmation,
  watchProviderConfirmation,
} from '../../lib/provider_confirmation'
import { useRef, useState } from 'react'
import { useAccount, useStore } from '../../lib/client/react'
import { seed, derive } from '../../lib/backup_phrase'
import { b64u, utf8 } from '../../lib/p2p/canonical'
import { sign } from '../../lib/p2p/keys'
import { beginPopup, errorText as popupText, type SsoErrorCode } from '../../lib/sso'
import { errorText } from '../../lib/store'
import type { LinkedProvider, ReAuthBody } from '../../lib/types'
import { PhraseInput } from './phrase_input'
import { Stack } from '../layout'
import { FieldError, fieldCls, filledBtn, textBtn } from '../ui'
import { useConfirmation } from '../sso/use_confirmation'

const confirmationError = (e: unknown) =>
  typeof e === 'string' ? (popupText(e as SsoErrorCode) ?? e) : errorText(e)
type Way = 'password' | 'idp' | 'phrase'
export function ReAuthPrompt({
  purpose,
  context = '',
  links,
  ways = ['password', 'idp', 'phrase'],
  onBody,
}: {
  purpose: 'set' | 'remove' | 'link_idp' | 'set_password' | 'staff_view' | 'delete_account'
  context?: string
  links: LinkedProvider[]
  ways?: Way[]
  onBody(body: ReAuthBody): Promise<void>
}) {
  const acct = useAccount(),
    current = useConfirmation()
  const me = useStore(s => s.me),
    auth = useStore(s => s.instance?.auth)
  const proof = useStore(s => s.providerConfirmation)
  const checkPhrase = ways.includes('phrase')
  const [phraseOpen, setPhraseOpen] = useState(false)
  const [words, setWords] = useState<string[] | null>(null)
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false),
    pending = useRef(false)
  const phrase = useAccountRequest(
    async api => (checkPhrase ? (await api.recoveryStatus()).set : false),
    [checkPhrase]
  )
  const confirm = async (get: () => Promise<ReAuthBody>, freshProvider?: string) => {
    if (!current() || pending.current) return
    pending.current = true
    setBusy(true)
    setError(null)
    let unwatch: (() => void) | undefined
    try {
      const body = await get()
      if (!current()) return
      if (freshProvider) unwatch = watchProviderConfirmation(acct, freshProvider, current)
      await onBody(body)
    } catch (e) {
      if (freshProvider && current()) {
        if (unwatch && statusOf(e) === 401 && (e as Error).message === 'Unauthorized') {
          acct.store.getState().expireSession()
        } else if (e === 'expired' || (unwatch && statusOf(e) === 401)) {
          // The callback and the socket's revocation check can arrive in either order.
          unwatch ??= watchProviderConfirmation(acct, freshProvider, current)
          await acct.store.getState().checkSession()
        }
      }
      if (current()) setError(confirmationError(e))
    } finally {
      unwatch?.()
      pending.current = false
      if (current()) setBusy(false)
    }
  }
  if (!me) return null
  const wordPassword = me.password_kind === 'words'
  return (
    <Stack as="fieldset" disabled={busy} gap="md">
      <legend>Confirm your identity</legend>
      {ways.includes('password') && !me.password_temporary && me.has_password !== false && (
        <>
          <input
            type="password"
            aria-label={wordPassword ? 'Current 7 words' : 'Current password'}
            placeholder={wordPassword ? 'Current 7 words in order' : 'Current password'}
            autoComplete="current-password"
            className={fieldCls}
            value={password}
            onChange={e => setPassword(e.target.value)}
          />
          <button
            type="button"
            className={filledBtn}
            disabled={!password}
            onClick={() =>
              void confirm(async () =>
                wordPassword ? { words: password.trim().split(/\s+/) } : { password }
              )
            }
          >
            Confirm password
          </button>
        </>
      )}
      {ways.includes('idp') &&
        links
          .filter(
            l =>
              proof &&
              recentConfirmation(acct, l.provider) &&
              auth?.providers.some(p => p.id === l.provider)
          )
          .map(({ provider, name }) => (
            <button
              key={provider}
              type="button"
              className={textBtn}
              onClick={() =>
                void confirm(async () => ({
                  idp: { provider, code: takeRecentConfirmation(acct, provider).code },
                }))
              }
            >
              Confirm with recent {name} sign-in
            </button>
          ))}
      {ways.includes('idp') &&
        links
          .filter(l => auth?.providers.some(p => p.id === l.provider))
          .map(({ provider, name }) => (
            <button
              key={provider}
              type="button"
              className={textBtn}
              onClick={() =>
                void confirm(async () => {
                  const { ticket } = await acct.api.ssoTicket({ provider, purpose: 'reauth' })
                  if (!current()) throw new Error('Sign-in expired')
                  const { code } = await beginPopup(acct, provider, 'reauth', ticket, current)
                  return { idp: { provider, code } }
                }, provider)
              }
            >
              Sign in with {name}
            </button>
          ))}
      <Loaded load={phrase} skeleton={null} what="whether a backup phrase is set">
        {hasPhrase =>
          hasPhrase &&
          (phraseOpen ? (
            <>
              <PhraseInput label="Current backup phrase" onWords={setWords} />
              <button
                type="button"
                className={filledBtn}
                disabled={!words}
                onClick={() =>
                  void confirm(async () => {
                    const { nonce, username } = await acct.api.recoveryChallenge(me.username)
                    const key = derive(await seed(words!), 'account')
                    const sig = b64u(
                      sign(
                        key,
                        utf8(['rchat-recovery1', purpose, username, nonce, context].join('\0'))
                      )
                    )
                    return { phrase: { nonce, sig } }
                  })
                }
              >
                Confirm backup phrase
              </button>
            </>
          ) : (
            <button type="button" className={textBtn} onClick={() => setPhraseOpen(true)}>
              Use backup phrase
            </button>
          ))
        }
      </Loaded>
      <FieldError message={error} />
    </Stack>
  )
}
