'use client'
import { ask, known, sendTo } from '../../lib/asks'
import { useId, useState, type ReactNode } from 'react'
import { useAccount, useStore } from '../../lib/client/react'
import { beginPopup, canUnlink, DEFAULT_AUTH, linkable } from '../../lib/sso'
import { mayManageSignIns } from '../../lib/sso_actions'
import { errorText } from '../../lib/store'
import type { LinkedProvider } from '../../lib/types'
import { openActionMenu } from '../../lib/actions/menu'
import { longPress } from '../context_menu'
import { ReAuthPrompt } from '../backup_phrase/reauth_prompt'
import { useConfirmation } from './use_confirmation'
import { tabWrap } from '../../lib/settings_page'
import { Button } from '../controls'
import { Refreshed, useAccountSource } from '../loaded'
import { Row, Stack, Surface } from '../layout'
import { CloseButton, FieldError, TopDialog } from '../ui'

type Provider = { id: string; name: string }
export interface SignInList {
  // The state of the lookup, to draw where the methods are listed.
  notice: ReactNode
  supported: boolean
  refresh: () => void
}

// The account's linked sign-ins for `children`: null until they are known.
export function SignInLinks({
  children,
}: {
  children: (links: LinkedProvider[] | null, list: SignInList) => ReactNode
}) {
  const hasPassword = useStore(s => s.me?.has_password)
  const supported = useStore(
    s =>
      mayManageSignIns(s) &&
      (s.me?.has_password !== undefined || !!s.instance?.auth?.providers.length)
  )
  const [load, source] = useAccountSource<LinkedProvider[] | null>(
    () => (supported ? ask.ssoLinks() : known(null)),
    [supported, hasPassword]
  )
  return (
    <Refreshed load={load} known={null} what="your sign-in methods">
      {(links, notice) => children(links, { notice, supported, refresh: source.refresh })}
    </Refreshed>
  )
}

export function SignInMethods({
  links,
  list,
}: {
  links: LinkedProvider[] | null
  list: SignInList
}) {
  const acct = useAccount(),
    current = useConfirmation()
  const auth = useStore(s => s.instance?.auth ?? DEFAULT_AUTH),
    me = useStore(s => s.me)
  const mode = useStore(s => (s.activeDialog?.kind === 'settings' ? s.activeDialog.sso : undefined))
  const [op, setOp] = useState<{ type: 'link' | 'unlink'; p: Provider } | null>(mode ?? null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  if (!list.supported || !me || (!auth.providers.length && links?.length === 0)) return null
  const cancel = () => {
    setOp(null)
    setError(null)
    setBusy(false)
  }
  const pick = (type: 'link' | 'unlink', p: Provider, opener?: HTMLElement) => {
    if (current()) {
      opener?.focus({ preventScroll: true })
      setOp({ type, p })
      setError(null)
    }
  }
  const available = links ? linkable(auth, links) : []
  return (
    <Stack as="section" gap="sm" place="w-full">
      <h3 className="text-sm font-medium">Sign-in methods</h3>
      {list.notice}
      {links?.map(l => {
        const allowed = canUnlink(me, links, l.provider)
        const unlink = (opener?: HTMLElement) =>
          pick('unlink', { id: l.provider, name: l.name }, opener)
        return (
          <Surface
            key={l.provider}
            tone="base"
            radius="lg"
            pad="md"
            tabIndex={0}
            {...longPress(
              (x, y) =>
                current() &&
                openActionMenu(
                  x,
                  y,
                  { kind: 'sign_in', name: l.name, allowed, unlink: () => unlink() },
                  undefined,
                  acct
                )
            )}
          >
            <Row gap="md" justify="between">
              <div className="min-w-0 break-words">
                {l.name}
                <p className="text-xs text-on-surface-variant">
                  Linked {new Date(l.linked_at * 1000).toLocaleDateString()}
                </p>
              </div>
              <Button
                variant="danger"
                disabled={!allowed}
                title={allowed ? undefined : 'Add a password or another sign-in first'}
                onClick={e => unlink(e.currentTarget)}
              >
                Unlink
              </Button>
            </Row>
          </Surface>
        )
      })}
      {available.map(p => (
        <Button key={p.id} onClick={e => pick('link', p, e.currentTarget)}>
          Link {p.name}
        </Button>
      ))}
      {op && links && (op.type !== 'link' || available.some(p => p.id === op.p.id)) && (
        <ProviderDialog
          title={op.type === 'link' ? 'Link ' + op.p.name : 'Unlink ' + op.p.name + '?'}
          onClose={() => {
            if (!busy) cancel()
          }}
        >
          {op.type === 'link' ? (
            <LinkPrompt
              provider={op.p.id}
              links={links}
              done={() => {
                cancel()
                list.refresh()
              }}
            />
          ) : (
            <Stack gap="md">
              <p>You will no longer be able to sign in with {op.p.name}.</p>
              <FieldError message={error} />
              <Button
                variant="filled"
                size="md"
                place="self-start"
                disabled={busy || !canUnlink(me, links, op.p.id)}
                onClick={async () => {
                  if (!current()) return
                  setBusy(true)
                  try {
                    await sendTo(acct, ask.ssoUnlink(op.p.id))
                    if (current()) {
                      cancel()
                      list.refresh()
                    }
                  } catch (e) {
                    if (current()) {
                      setError(errorText(e))
                      setBusy(false)
                    }
                  }
                }}
              >
                Unlink
              </Button>
            </Stack>
          )}
        </ProviderDialog>
      )}
    </Stack>
  )
}
function ProviderDialog({
  title,
  onClose,
  children,
}: {
  title: string
  onClose(): void
  children: ReactNode
}) {
  const id = useId()
  return (
    <TopDialog
      labelledBy={id}
      backdrop
      onCancel={onClose}
      onOpen={el => {
        // Disabling the active confirmation control can move focus to the document body.
        const focusInside = () => {
          if (el.open && !el.contains(document.activeElement)) el.querySelector('button')?.focus()
        }
        const onBlur = () => queueMicrotask(focusInside)
        el.addEventListener('focusout', onBlur)
        window.addEventListener('focus', focusInside)
        window.addEventListener('rchat-sso-return', focusInside)
        // Let the browser cancel the native modal even if the popup left the key targeted at body.
        const onKey = (e: KeyboardEvent) => {
          if (e.key === 'Escape' && !e.isComposing && !el.contains(e.target as Node))
            e.stopPropagation()
        }
        document.addEventListener('keydown', onKey, true)
        return () => {
          document.removeEventListener('keydown', onKey, true)
          window.removeEventListener('rchat-sso-return', focusInside)
          window.removeEventListener('focus', focusInside)
          el.removeEventListener('focusout', onBlur)
        }
      }}
      onKeyDown={e => {
        if (e.key !== 'Tab' || e.defaultPrevented) return
        const controls = [
          ...e.currentTarget.querySelectorAll<HTMLElement>('button:enabled, input:enabled'),
        ].filter(el => el.tabIndex >= 0 && el.getClientRects().length)
        const to = tabWrap(
          controls.indexOf(document.activeElement as HTMLElement),
          controls.length,
          e.shiftKey
        )
        if (to !== null) {
          e.preventDefault()
          controls[to].focus()
        }
      }}
    >
      <Stack gap="lg">
        <Row gap="sm" justify="between">
          <h2 id={id} className="text-lg font-medium">
            {title}
          </h2>
          <CloseButton onClick={onClose} compact />
        </Row>
        {children}
      </Stack>
    </TopDialog>
  )
}
function LinkPrompt({
  provider,
  links,
  done,
}: {
  provider: string
  links: LinkedProvider[]
  done(): void
}) {
  const acct = useAccount(),
    current = useConfirmation()
  return (
    <ReAuthPrompt
      purpose="link_idp"
      context={provider}
      links={links}
      onBody={async reauth => {
        const { ticket } = await sendTo(acct, ask.ssoTicket({ provider, purpose: 'link', reauth }))
        if (!current()) return
        const result = await beginPopup(acct, provider, 'link', ticket, current)
        if (!current()) return
        const reply = await sendTo(acct, ask.ssoExchange(result))
        if (reply.kind !== 'linked' || reply.provider !== provider)
          throw new Error('Sign-in was not linked')
        if (current()) done()
      }}
    />
  )
}
