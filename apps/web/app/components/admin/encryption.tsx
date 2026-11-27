'use client'

import { KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useState } from 'react'
import {
  BACKUP_WARNING,
  fingerprints,
  keySourceLine,
  keySourceNote,
  lostKeys,
  lostWarning,
  parseAdminEncryption,
  readinessLine,
  resetWarning,
  type AdminEncryption,
} from '../../lib/admin_encryption'
import { useAccount } from '../../lib/client/react'
import { errorText, useStore } from '../../lib/store'
import { PageRow } from '../settings_page'

const cardCls = 'flex min-w-0 flex-col gap-1 rounded-xl bg-surface-container px-4 py-3'
const cardTitleCls = 'text-xs font-medium tracking-wide text-on-surface-variant uppercase'

export function EncryptionStatus({
  view,
  now = Date.now(),
}: {
  view: AdminEncryption
  now?: number
}) {
  const prints = fingerprints(view)
  const lost = lostKeys(view)
  const note = keySourceNote(view)
  const reset = resetWarning(view, now)
  return (
    <div className="space-y-3">
      {view.needs_backup && (
        <p
          role="alert"
          data-warning="backup"
          className="flex min-w-0 items-start gap-2 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{BACKUP_WARNING}</span>
        </p>
      )}
      {lost.length > 0 && (
        <p
          role="alert"
          data-warning="lost"
          className="flex min-w-0 items-start gap-2 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{lostWarning(lost)}</span>
        </p>
      )}
      {reset !== null && (
        <p
          role="alert"
          data-warning="reset"
          className="flex min-w-0 items-start gap-2 rounded-xl bg-error-container px-4 py-3 text-sm text-on-error-container"
        >
          <TriangleAlert size={18} aria-hidden className="mt-0.5 shrink-0" />
          <span className="min-w-0 break-words">{reset}</span>
        </p>
      )}
      <div className={cardCls}>
        <p className={cardTitleCls}>Key source</p>
        <p className="flex min-w-0 items-center gap-2 text-sm">
          <KeyRound size={16} aria-hidden className="shrink-0 text-on-surface-variant" />
          <span data-key-source={view.source} className="min-w-0 break-words">
            {keySourceLine(view)}
          </span>
        </p>
        {view.key_file !== null && (
          <p className="min-w-0 font-mono text-xs break-all text-on-surface-variant">
            {view.key_file}
          </p>
        )}
        {note !== null && <p className="text-xs text-on-surface-variant">{note}</p>}
      </div>
      {prints.length > 0 && (
        <div className={cardCls}>
          <p className={cardTitleCls}>Key fingerprints</p>
          <ul className="space-y-1">
            {prints.map(p => (
              <li key={p.id} className="flex min-w-0 flex-wrap items-center gap-x-2 text-sm">
                <span className="min-w-0 font-mono break-all">{p.id}</span>
                <span className="font-mono text-on-surface-variant">{p.print}</span>
                {p.current && (
                  <span className="rounded-full border border-outline-variant px-2 py-0.5 text-xs text-on-surface-variant">
                    In use
                  </span>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-on-surface-variant">If a key leaked, rotate data keys too.</p>
        </div>
      )}
      <div className={cardCls}>
        <p className={cardTitleCls}>Encrypted storage</p>
        <p className="text-sm">{readinessLine(view)}</p>
        <p className="text-xs text-on-surface-variant">
          Where it is on, messages are stored encrypted with a key this site keeps. This is not
          end-to-end encryption.
        </p>
      </div>
    </div>
  )
}

export const LOAD_FAILED = "The key status can't be shown right now."

// What the section shows: the status once it arrived, `failed` when it can't be read.
export function EncryptionBody({ view }: { view: AdminEncryption | 'failed' | null }) {
  if (view === 'failed')
    return (
      <p data-load="failed" className="text-sm text-on-surface-variant">
        {LOAD_FAILED}
      </p>
    )
  if (view === null) return <p className="text-sm text-on-surface-variant">Loading</p>
  return <EncryptionStatus view={view} />
}

export function EncryptionSection() {
  const owner = useAccount()
  const setError = useStore(s => s.setError)
  const [view, setView] = useState<AdminEncryption | 'failed' | null>(null)
  useEffect(() => {
    let live = true
    owner.api
      .adminEncryption()
      .then(answer => {
        if (live) setView(parseAdminEncryption(answer) ?? 'failed')
      })
      .catch(
        owner.lifetime.inSession((e: unknown) => {
          if (live) setView('failed')
          setError(errorText(e))
        })
      )
    return () => {
      live = false
    }
  }, [owner, setError])
  return (
    <PageRow id="keys" className="p-2">
      <EncryptionBody view={view} />
    </PageRow>
  )
}
