'use client'
import { Name } from '../name'
import { p2pName } from '../../lib/names'
import { Button, Tab } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { withP2pIdentity } from '../../lib/client/p2p_react'

import { useP2pApp, useP2p } from '../../lib/client/p2p_react'

import { useMemo, useState } from 'react'
import { Eye } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'

import { displayName, shieldOf, warningText } from '../../lib/p2p/contacts'
import { fingerprint } from '../../lib/p2p/keys'
import { safetyGroups } from '../../lib/p2p/safety'
import { QrCode } from '../share_code'
import { Dialog, FieldError, fieldCls } from '../ui'
import { ContactShield, shieldText } from './p2p_badge'
import { QrScan } from './qr_scan'

type Mode = 'number' | 'show' | 'scan'

function VerifyDialogBody({ ik }: { ik: string }) {
  const identity = useP2pApp()!
  const { p2p } = identity

  const contact = useP2p(s => s.contacts.find(c => c.ik === ik))
  const me = useP2p(s => s.ik)
  const all = useP2p(s => s.contacts)
  const streamer = useStore(s => s.streamer)
  const [mode, setMode] = useState<Mode>('number')
  const [shown, setShown] = useState(false)
  const [paste, setPaste] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const code = useMemo(() => (mode === 'show' ? p2p.verifyCode(ik) : null), [mode, ik])
  const groups = useMemo(() => (me ? safetyGroups(me, ik, p2p.limits().misc) : []), [me, ik])
  const mask = useMask()
  if (!contact || !me) return null
  const shield = shieldOf(contact)
  const lookalike = contact.warning ? all.find(c => c.ik === contact.warning) : undefined
  const hidden = streamer && !shown

  const scanned = async (text: string) => {
    const r = await p2p.scanVerify(ik, text)
    setResult(r ?? { ok: false, text: "Couldn't check that code" })
  }

  return (
    <Dialog title="Verify contact" onClose={p2p.closeDialog} full>
      <Stack gap="lg">
        <Row gap="sm">
          <ContactShield kind={shield} size={20} />
          <Name of={p2pName(displayName(contact))} look="min-w-0 truncate font-medium" />
          <span className="text-sm text-on-surface-variant">{shieldText(shield)}</span>
        </Row>
        {contact.warning && (
          <Surface role="alert" pad="md" tone="error" radius="lg">
            <p className="text-sm">
              {warningText(lookalike ? mask(displayName(lookalike)) : 'a contact')} Compare the
              safety number in person before you trust it.
            </p>
          </Surface>
        )}
        <Row role="tablist" gap="2xs" align="stretch">
          {(
            [
              ['number', 'Safety number'],
              ['show', 'Show my code'],
              ['scan', 'Scan their code'],
            ] as [Mode, string][]
          ).map(([key, label]) => (
            <Tab
              key={key}
              selected={mode === key}
              onClick={() => {
                setMode(key)
                setResult(null)
              }}
            >
              {label}
            </Tab>
          ))}
        </Row>
        {hidden && mode !== 'scan' ? (
          <Button onClick={() => setShown(true)} place="w-fit">
            <Eye size={16} />
            Show code
          </Button>
        ) : mode === 'number' ? (
          <Stack gap="sm">
            <p className="text-sm text-on-surface-variant">
              Compare these numbers with <Name of={p2pName(displayName(contact))} />, in person or
              on a call. If they match, nobody is in between.
            </p>
            <div data-safety-number className="streamer font-mono text-base tracking-wider">
              <Surface pad="lg" tone="base" radius="lg">
                <Grid cols={4} gap="2xs">
                  {groups.map((g, i) => (
                    <span key={i}>{g}</span>
                  ))}
                </Grid>
              </Surface>
            </div>
            <p className="streamer font-mono text-2xs text-on-surface-variant">
              Their key {fingerprint(ik)}
            </p>
          </Stack>
        ) : mode === 'show' ? (
          <Stack gap="sm">
            <p className="text-sm text-on-surface-variant">
              Let <Name of={p2pName(displayName(contact))} /> scan this. When it matches, you both
              see each other as verified.
            </p>
            {code && <QrCode text={code} label="Your verification code" size="lg" />}
          </Stack>
        ) : (
          <Stack gap="sm">
            <QrScan label="Camera view for a verification code" onCode={t => void scanned(t)} />
            <p className="text-xs text-on-surface-variant">
              Paste a code only if it reached you in person or over a channel you trust.
            </p>
            <Row gap="sm" align="stretch">
              <input
                value={paste}
                onChange={e => setPaste(e.target.value)}
                placeholder="Or paste their code (rcv1.…)"
                aria-label="Verification code"
                className={`${fieldCls} font-mono text-xs md:text-xs`}
              />
              <Button onClick={() => void scanned(paste)} disabled={!paste.trim()}>
                Check
              </Button>
            </Row>
          </Stack>
        )}
        {result &&
          (result.ok ? (
            <p role="status" className="text-sm text-status-green">
              {result.text}
            </p>
          ) : (
            <FieldError message={result.text} />
          ))}
        <Row gap="sm" justify="end" wrap>
          <Button onClick={p2p.closeDialog}>Close</Button>
          {!contact.verified && (
            <Button
              variant="filled"
              size="md"
              onClick={() => {
                void p2p.markVerified(ik)
                setResult({ ok: true, text: 'Verified' })
              }}
            >
              Mark as verified
            </Button>
          )}
        </Row>
      </Stack>
    </Dialog>
  )
}

export const VerifyDialog = withP2pIdentity(VerifyDialogBody)
