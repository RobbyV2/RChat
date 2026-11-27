'use client'

import { useState } from 'react'
import { ArrowRight, TriangleAlert } from 'lucide-react'
import { useStore } from '../lib/store'
import { RISK_TEXT, linkRisks, shownHost, trustable, webLink } from '../lib/link_safety'
import { Dialog, filledBtn, textBtn } from './ui'

// The warning before a link from a message opens another site.
export default function ExternalLinkDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'external_link' ? (
    <ExternalLinkBody key={dialog.href} href={dialog.href} label={dialog.label} />
  ) : null
}

function ExternalLinkBody({ href, label }: { href: string; label: string | null }) {
  const closeDialog = useStore(s => s.closeDialog)
  const trustLinkHost = useStore(s => s.trustLinkHost)
  const [trust, setTrust] = useState(false)
  const url = webLink(href, typeof location === 'undefined' ? undefined : location.href)
  if (!url) return null
  const host = shownHost(url)
  const risks = linkRisks(url, label)
  const visit = () => {
    if (trust) trustLinkHost(host)
    closeDialog()
    window.open(url.href, '_blank', 'noopener,noreferrer')
  }
  return (
    <Dialog title="External link warning" onClose={closeDialog} compact>
      <div data-external-link className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="flex size-12 items-center justify-center rounded-full bg-surface-container-highest text-status-yellow"
        >
          <TriangleAlert size={24} />
        </span>
        <p className="text-base font-semibold text-on-surface">You are about to leave this site</p>
        <p className="text-sm text-on-surface-variant">
          External links can be dangerous. Be careful.
        </p>
      </div>
      <div className="mt-4 flex flex-col gap-1.5">
        <span className="text-sm text-on-surface">Destination URL:</span>
        <p
          data-external-url
          className="max-h-32 overflow-y-auto rounded-xl border border-outline-variant bg-surface-container-low px-3 py-2.5 font-mono text-sm break-all text-on-surface select-all"
        >
          {url.href}
        </p>
        {risks.length > 0 && (
          <div
            role="alert"
            className="flex flex-col gap-1 rounded-xl bg-error-container px-3 py-2 text-xs text-on-error-container"
          >
            {risks.map(r => (
              <p key={r} className="flex items-start gap-1.5">
                <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
                {RISK_TEXT[r]}
              </p>
            ))}
            <p>
              It goes to <span className="font-mono font-semibold break-all">{url.hostname}</span>.
            </p>
          </div>
        )}
      </div>
      {trustable(host) && (
        <label className="mt-4 flex cursor-pointer items-start gap-2 text-sm text-on-surface">
          <input
            type="checkbox"
            checked={trust}
            onChange={e => setTrust(e.target.checked)}
            className="mt-0.5 size-4 shrink-0 accent-primary"
          />
          <span>
            Always trust <span className="font-semibold break-all">{host}</span> and skip this
            warning next time
          </span>
        </label>
      )}
      <div className="mt-5 flex flex-wrap justify-end gap-2">
        <button autoFocus type="button" onClick={closeDialog} className={textBtn}>
          Cancel
        </button>
        <button type="button" onClick={visit} className={`${filledBtn} flex items-center gap-1.5`}>
          Visit site
          <ArrowRight size={16} aria-hidden />
        </button>
      </div>
    </Dialog>
  )
}
