'use client'

import { useMemo, useState } from 'react'
import { Eye } from 'lucide-react'
import { useMask, useStore } from '../../lib/store'
import { p2p, useP2p } from '../../lib/p2p/app'
import { displayName, shieldOf, warningText } from '../../lib/p2p/contacts'
import { fingerprint } from '../../lib/p2p/keys'
import { safetyGroups } from '../../lib/p2p/safety'
import { QrCode } from '../config_sync'
import { Dialog, FieldError, fieldCls, filledBtn, textBtn } from '../ui'
import { ContactShield, shieldText } from './p2p_badge'
import { QrScan } from './qr_scan'

type Mode = 'number' | 'show' | 'scan'

export function VerifyDialog({ ik }: { ik: string }) {
  const contact = useP2p(s => s.contacts.find(c => c.ik === ik))
  const me = useP2p(s => s.ik)
  const all = useP2p(s => s.contacts)
  const streamer = useStore(s => s.streamer)
  const [mode, setMode] = useState<Mode>('number')
  const [shown, setShown] = useState(false)
  const [paste, setPaste] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const code = useMemo(() => (mode === 'show' ? p2p.verifyCode(ik) : null), [mode, ik])
  const groups = useMemo(() => (me ? safetyGroups(me, ik) : []), [me, ik])
  const mask = useMask()
  if (!contact || !me) return null
  const name = mask(displayName(contact))
  const shield = shieldOf(contact)
  const lookalike = contact.warning ? all.find(c => c.ik === contact.warning) : undefined
  const hidden = streamer && !shown

  const scanned = async (text: string) => {
    const r = await p2p.scanVerify(ik, text)
    setResult(r ?? { ok: false, text: "Couldn't check that code" })
  }

  return (
    <Dialog title="Verify contact" onClose={p2p.closeDialog} full>
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <ContactShield kind={shield} size={20} />
          <span className="streamer min-w-0 truncate font-medium">{name}</span>
          <span className="text-sm text-on-surface-variant">{shieldText(shield)}</span>
        </div>
        {contact.warning && (
          <p
            role="alert"
            className="rounded-xl bg-error-container px-3 py-2 text-sm text-on-error-container"
          >
            {warningText(lookalike ? mask(displayName(lookalike)) : 'a contact')} Compare the safety
            number in person before you trust it.
          </p>
        )}
        <div role="tablist" className="flex gap-1">
          {(
            [
              ['number', 'Safety number'],
              ['show', 'Show my code'],
              ['scan', 'Scan their code'],
            ] as [Mode, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              role="tab"
              aria-selected={mode === key}
              onClick={() => {
                setMode(key)
                setResult(null)
              }}
              className={`rounded-full px-3 py-1.5 text-sm ${
                mode === key
                  ? 'bg-secondary-container text-on-secondary-container'
                  : 'text-on-surface-variant hover:bg-surface-container-highest'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {hidden && mode !== 'scan' ? (
          <button
            type="button"
            onClick={() => setShown(true)}
            className={`${textBtn} flex w-fit items-center gap-1.5`}
          >
            <Eye size={16} />
            Show code
          </button>
        ) : mode === 'number' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-on-surface-variant">
              Compare these numbers with <span className="streamer">{name}</span>, in person or on a
              call. If they match, nobody is in between.
            </p>
            <div
              data-safety-number
              className="streamer grid grid-cols-4 gap-x-3 gap-y-1 rounded-xl bg-surface-container px-4 py-3 font-mono text-base tracking-wider"
            >
              {groups.map((g, i) => (
                <span key={i}>{g}</span>
              ))}
            </div>
            <p className="streamer font-mono text-[11px] text-on-surface-variant">
              Their key {fingerprint(ik)}
            </p>
          </div>
        ) : mode === 'show' ? (
          <div className="flex flex-col gap-2">
            <p className="text-sm text-on-surface-variant">
              Let <span className="streamer">{name}</span> scan this. When it matches, you both see
              each other as verified.
            </p>
            {code && (
              <div className="w-72 max-w-full">
                <QrCode text={code} label="Your verification code" wide />
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            <QrScan label="Camera view for a verification code" onCode={t => void scanned(t)} />
            <p className="text-xs text-on-surface-variant">
              Paste a code only if it reached you in person or over a channel you trust.
            </p>
            <div className="flex gap-2">
              <input
                value={paste}
                onChange={e => setPaste(e.target.value)}
                placeholder="Or paste their code (rcv1.…)"
                aria-label="Verification code"
                className={`${fieldCls} font-mono text-xs md:text-xs`}
              />
              <button
                onClick={() => void scanned(paste)}
                disabled={!paste.trim()}
                className={textBtn}
              >
                Check
              </button>
            </div>
          </div>
        )}
        {result &&
          (result.ok ? (
            <p role="status" className="text-sm text-status-green">
              {result.text}
            </p>
          ) : (
            <FieldError message={result.text} />
          ))}
        <div className="mt-2 flex flex-wrap justify-end gap-2">
          <button onClick={p2p.closeDialog} className={textBtn}>
            Close
          </button>
          {!contact.verified && (
            <button
              onClick={() => {
                void p2p.markVerified(ik)
                setResult({ ok: true, text: 'Verified' })
              }}
              className={filledBtn}
            >
              Mark as verified
            </button>
          )}
        </div>
      </div>
    </Dialog>
  )
}
