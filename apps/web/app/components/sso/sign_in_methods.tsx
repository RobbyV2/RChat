'use client'
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
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
import { CloseButton, useBackdrop, FieldError } from '../ui'

type Provider = { id: string; name: string }
export function useSignInLinks() {
  const acct = useAccount(),
    current = useConfirmation()
  const hasPassword = useStore(s => s.me?.has_password)
  const supported = useStore(
    s =>
      mayManageSignIns(s) &&
      (s.me?.has_password !== undefined || !!s.instance?.auth?.providers.length)
  )
  const [links, setLinks] = useState<LinkedProvider[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    const stillCurrent = () =>
      live && current() && acct.store.getState().me?.has_password === hasPassword
    setLinks(null)
    setError(null)
    if (supported)
      acct.api
        .ssoLinks()
        .then(rows => {
          if (stillCurrent()) setLinks(rows)
        })
        .catch(e => {
          if (stillCurrent()) setError(errorText(e))
        })
    return () => {
      live = false
    }
  }, [acct, supported, hasPassword, revision, current])
  return {
    links,
    error,
    supported,
    refresh: () => {
      setLinks(null)
      setError(null)
      setRevision(n => n + 1)
    },
  }
}

export function SignInMethods({ list }: { list: ReturnType<typeof useSignInLinks> }) {
  const acct = useAccount(),
    current = useConfirmation()
  const auth = useStore(s => s.instance?.auth ?? DEFAULT_AUTH),
    me = useStore(s => s.me)
  const mode = useStore(s => (s.activeDialog?.kind === 'settings' ? s.activeDialog.sso : undefined))
  const [op, setOp] = useState<{ type: 'link' | 'unlink'; p: Provider } | null>(mode ?? null)
  const [busy, setBusy] = useState(false),
    [error, setError] = useState<string | null>(null)
  const { links } = list
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
    <section className="flex w-full min-w-0 flex-col gap-2">
      <h3 className="text-sm font-medium">Sign-in methods</h3>
      {list.error && (
        <>
          <FieldError message={list.error} />
          <Button onClick={list.refresh}>Retry</Button>
        </>
      )}
      {links?.map(l => {
        const allowed = canUnlink(me, links, l.provider)
        const unlink = (opener?: HTMLElement) =>
          pick('unlink', { id: l.provider, name: l.name }, opener)
        return (
          <div
            key={l.provider}
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
            className="flex items-center justify-between gap-3 rounded-xl bg-surface-container p-3"
          >
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
          </div>
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
            <>
              <p className="mb-3">You will no longer be able to sign in with {op.p.name}.</p>
              <FieldError message={error} />
              <Button
                variant="filled"
                size="md"
                disabled={busy || !canUnlink(me, links, op.p.id)}
                onClick={async () => {
                  if (!current()) return
                  setBusy(true)
                  try {
                    await acct.api.ssoUnlink(op.p.id)
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
            </>
          )}
        </ProviderDialog>
      )}
    </section>
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
  const ref = useRef<HTMLDialogElement>(null)
  const id = useId()
  const backdrop = useBackdrop(onClose)
  useLayoutEffect(() => {
    const el = ref.current!
    const opener = document.activeElement
    el.showModal()
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
      el.close()
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true })
    }
  }, [])
  return (
    <dialog
      ref={ref}
      aria-modal="true"
      aria-labelledby={id}
      onCancel={e => {
        e.preventDefault()
        onClose()
      }}
      onKeyDown={e => {
        e.stopPropagation()
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
      className="fixed inset-0 m-auto max-h-[85dvh] w-[min(24rem,calc(100%-2rem))] rounded-3xl bg-surface-container-high text-on-surface shadow-elevation-3 backdrop:bg-scrim/60"
      {...backdrop}
    >
      <div className="p-6">
        <div className="mb-4 flex items-center justify-between">
          <h2 id={id} className="text-lg font-medium">
            {title}
          </h2>
          <CloseButton onClick={onClose} compact />
        </div>
        {children}
      </div>
    </dialog>
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
        const { ticket } = await acct.api.ssoTicket({ provider, purpose: 'link', reauth })
        if (!current()) return
        const result = await beginPopup(acct, provider, 'link', ticket, current)
        if (!current()) return
        const reply = await acct.api.ssoExchange(result)
        if (reply.kind !== 'linked' || reply.provider !== provider)
          throw new Error('Sign-in was not linked')
        if (current()) done()
      }}
    />
  )
}
