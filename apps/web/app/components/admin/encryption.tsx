'use client'

import { KeyRound, TriangleAlert } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
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
import { Pill } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { PageRow } from '../settings_page'

const cardTitleCls = 'text-xs font-medium tracking-wide text-on-surface-variant uppercase'

function Card({ children }: { children: ReactNode }) {
  return (
    <Surface tone="base" radius="lg" pad="lg" gap="2xs">
      {children}
    </Surface>
  )
}

function Warning({ kind, children }: { kind: string; children: ReactNode }) {
  return (
    <Surface as="p" role="alert" data-warning={kind} tone="error" radius="lg" pad="lg">
      <Row as="span" gap="sm" align="start">
        <TriangleAlert size={18} aria-hidden className="shrink-0" />
        <span className="min-w-0 text-sm break-words">{children}</span>
      </Row>
    </Surface>
  )
}

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
    <Stack gap="md">
      {view.needs_backup && <Warning kind="backup">{BACKUP_WARNING}</Warning>}
      {lost.length > 0 && <Warning kind="lost">{lostWarning(lost)}</Warning>}
      {reset !== null && <Warning kind="reset">{reset}</Warning>}
      <Card>
        <p className={cardTitleCls}>Key source</p>
        <Row as="p" gap="sm">
          <KeyRound size={16} aria-hidden className="shrink-0 text-on-surface-variant" />
          <span data-key-source={view.source} className="min-w-0 text-sm break-words">
            {keySourceLine(view)}
          </span>
        </Row>
        {view.key_file !== null && (
          <p className="min-w-0 font-mono text-xs break-all text-on-surface-variant">
            {view.key_file}
          </p>
        )}
        {note !== null && <p className="text-xs text-on-surface-variant">{note}</p>}
      </Card>
      {prints.length > 0 && (
        <Card>
          <p className={cardTitleCls}>Key fingerprints</p>
          <Stack as="ul" gap="2xs">
            {prints.map(p => (
              <Row as="li" key={p.id} gap="sm" wrap>
                <span className="min-w-0 font-mono text-sm break-all">{p.id}</span>
                <span className="font-mono text-sm text-on-surface-variant">{p.print}</span>
                {p.current && <Pill tone="outline">In use</Pill>}
              </Row>
            ))}
          </Stack>
          <p className="text-xs text-on-surface-variant">If a key leaked, rotate data keys too.</p>
        </Card>
      )}
      <Card>
        <p className={cardTitleCls}>Encrypted storage</p>
        <p className="text-sm">{readinessLine(view)}</p>
        <p className="text-xs text-on-surface-variant">
          Where it is on, messages are stored encrypted with a key this site keeps. This is not
          end-to-end encryption.
        </p>
      </Card>
    </Stack>
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
    <PageRow id="keys">
      <Surface tone="plain" pad="sm">
        <EncryptionBody view={view} />
      </Surface>
    </PageRow>
  )
}
