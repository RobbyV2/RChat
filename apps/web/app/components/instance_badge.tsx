'use client'

import { Globe } from 'lucide-react'
import { useStore } from '../lib/store'
import { useAccount, useConn } from '../lib/client/react'
import { accountNoticeLabel, instanceLabel, labelParts } from '../lib/instance_label'
import { openActionMenu } from '../lib/actions/menu'
import { longPress } from './context_menu'

// What the copy calls this instance: its name, or its host when the name tells nothing.
export function useInstanceLabel() {
  const info = useStore(s => s.instance)
  const conn = useConn()
  const host = useStore(s => s.instanceHost) || conn.host
  return { label: instanceLabel(info, host), host }
}

// Text that may name the instance, the name hidden in streamer mode like other names.
export function LabelText({ text, name }: { text: string; name?: string }) {
  const { label } = useInstanceLabel()
  return (
    <>
      {labelParts(text, name ?? label).map((p, i) =>
        p.label ? (
          <span key={i} className="streamer">
            {p.text}
          </span>
        ) : (
          p.text
        )
      )}
    </>
  )
}

export function AccountLabel({ notice = false }: { notice?: boolean }) {
  const account = useAccount()
  const username = useStore(s => s.me?.username ?? account.credentialTarget)
  const info = useStore(s => s.instance) ?? account.conn.info
  return (
    <span className="streamer block truncate text-xs">
      {notice
        ? accountNoticeLabel(username, info, account.conn.host)
        : (username ?? '~guest') + '@' + account.conn.host}
    </span>
  )
}

export function InstanceChip({ host, className = '' }: { host: string; className?: string }) {
  const streamer = useStore(s => s.streamer)
  return (
    <span
      title={
        streamer ? 'Lives on another RChat instance' : `Lives on ${host}, another RChat instance`
      }
      className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-tertiary-container px-2 py-0.5 text-[11px] leading-4 font-medium text-on-tertiary-container ${className}`}
    >
      <Globe size={11} className="shrink-0" />
      <span className="streamer truncate">{host}</span>
    </span>
  )
}

export function RailInstance() {
  const acct = useAccount()

  const { label, host } = useInstanceLabel()
  const openDialog = useStore(s => s.openDialog)
  const streamer = useStore(s => s.streamer)
  const signedIn = useStore(s => s.me !== null)
  const named = label !== host
  return (
    <button
      title={streamer ? 'Instance' : named ? `${label} (${host})` : host}
      aria-label={`Instance ${label}${named ? ` on ${host}` : ''}`}
      onClick={() => openDialog({ kind: 'settings' })}
      {...(signedIn
        ? longPress((x, y) => openActionMenu(x, y, { kind: 'home' }, undefined, acct))
        : {})}
      className="flex w-15 shrink-0 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
    >
      <Globe size={16} className="shrink-0" />
      <span className="streamer w-full truncate text-center text-[10px] leading-3 font-semibold text-on-surface">
        {label}
      </span>
      {named && (
        <span className="streamer w-full truncate text-center text-[9px] leading-3">{host}</span>
      )}
    </button>
  )
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 items-baseline justify-between gap-4 py-1.5">
      <dt className="shrink-0 text-on-surface-variant">{label}</dt>
      <dd className="min-w-0 truncate text-right text-on-surface">{children}</dd>
    </div>
  )
}

export function InstanceDetails() {
  const info = useStore(s => s.instance)
  const { label, host } = useInstanceLabel()
  return (
    <div className="flex flex-col gap-3">
      <dl className="divide-y divide-outline-variant px-2 text-sm">
        <Row label="Instance ID">
          <span className="font-mono text-xs">{info?.id ?? 'Unknown'}</span>
        </Row>
        <Row label="Version">{info?.version ?? 'Unknown'}</Row>
        <Row label="API version">{info?.api_version ?? 'Unknown'}</Row>
      </dl>
      <p className="px-2 text-xs text-on-surface-variant">
        Your account, servers and DMs
        {label === host ? null : (
          <>
            {' '}
            on <span className="streamer">{label}</span>
          </>
        )}{' '}
        live on <span className="streamer">{host}</span>. Other instances are run by other people;
        what comes from them is marked with its instance.
      </p>
    </div>
  )
}
