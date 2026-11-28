'use client'

import { ask, sendTo } from '../../lib/asks'
import { Loaded, useRequest } from '../loaded'
import { KeyRound, TriangleAlert } from 'lucide-react'
import { type ReactNode } from 'react'
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
import { Pill } from '../controls'
import { Row, Stack, Surface } from '../layout'
import { PageRow } from '../settings_page'
import { time } from '../../lib/platform/time'

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
  now = time().now(),
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

export function EncryptionSection() {
  const owner = useAccount()
  const load = useRequest(async () => {
    const view = parseAdminEncryption(await sendTo(owner, ask.adminEncryption()))
    if (!view) throw new Error('The key status came back in a form this page cannot read')
    return view
  }, [owner])
  return (
    <PageRow id="keys">
      <Surface tone="plain" pad="sm">
        <Loaded load={load} what="the key status">
          {view => <EncryptionStatus view={view} />}
        </Loaded>
      </Surface>
    </PageRow>
  )
}
