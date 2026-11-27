'use client'

import { useState } from 'react'
import { ArrowRight, TriangleAlert } from 'lucide-react'
import { useStore } from '../lib/store'
import { RISK_TEXT, linkRisks, siteOf, webLink } from '../lib/link_safety'
import { Button } from './controls'
import { Row, Stack, Surface } from './layout'
import { Dialog } from './ui'

// The warning before a link from a message opens another site.
export default function ExternalLinkDialog() {
  const dialog = useStore(s => s.activeDialog)
  return dialog?.kind === 'external_link' ? (
    <ExternalLinkBody key={dialog.href} href={dialog.href} label={dialog.label} />
  ) : null
}

function ExternalLinkBody({ href, label }: { href: string; label: string | null }) {
  const closeDialog = useStore(s => s.closeDialog)
  const trustLinkSite = useStore(s => s.trustLinkSite)
  const [trust, setTrust] = useState(false)
  const url = webLink(href, typeof location === 'undefined' ? undefined : location.href)
  if (!url) return null
  const site = siteOf(url.hostname)
  const risks = linkRisks(url, label)
  const visit = () => {
    if (trust && site) trustLinkSite(site)
    closeDialog()
    window.open(url.href, '_blank', 'noopener,noreferrer')
  }
  return (
    <Dialog title="External link warning" onClose={closeDialog} compact>
      <Stack gap="lg">
        <Stack data-external-link gap="md" align="center">
          <span
            aria-hidden
            className="flex size-12 items-center justify-center rounded-full bg-surface-container-highest text-status-yellow"
          >
            <TriangleAlert size={24} />
          </span>
          <p className="text-center text-base font-semibold text-on-surface">
            You are about to leave this site
          </p>
          <p className="text-center text-sm text-on-surface-variant">
            External links can be dangerous. Be careful.
          </p>
        </Stack>
        <Stack gap="xs">
          <span className="text-sm text-on-surface">Destination URL:</span>
          <Surface pad="md" tone="low" radius="lg" border>
            <p
              data-external-url
              className="max-h-32 overflow-y-auto font-mono text-sm break-all text-on-surface select-all"
            >
              {url.href}
            </p>
          </Surface>
          {risks.length > 0 && (
            <Surface role="alert" pad="md" gap="2xs" tone="error" radius="lg">
              {risks.map(r => (
                <Row key={r} as="p" gap="xs" align="start">
                  <TriangleAlert size={14} className="mt-px shrink-0" aria-hidden />
                  <span className="text-xs">{RISK_TEXT[r]}</span>
                </Row>
              ))}
              <p className="text-xs">
                It goes to <span className="font-mono font-semibold break-all">{url.hostname}</span>
                .
              </p>
            </Surface>
          )}
        </Stack>
        {site && (
          <label className="flex cursor-pointer text-sm text-on-surface">
            <Row as="span" gap="sm" align="start">
              <input
                type="checkbox"
                checked={trust}
                onChange={e => setTrust(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span>
                Always trust <span className="font-semibold break-all">{site}</span> and skip this
                warning next time
              </span>
            </Row>
          </label>
        )}
        <Row gap="sm" justify="end" wrap>
          <Button size="md" autoFocus onClick={closeDialog}>
            Cancel
          </Button>
          <Button variant="filled" size="md" onClick={visit}>
            Visit site
            <ArrowRight size={16} aria-hidden />
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}
