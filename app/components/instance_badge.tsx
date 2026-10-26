'use client'

import { useEffect } from 'react'
import { Globe } from 'lucide-react'
import { useStore } from '../lib/store'
import { DEFAULT_INSTANCE_NAME, home } from '../lib/instances'

export function useInstance() {
  const info = useStore(s => s.instance)
  const host = useStore(s => s.instanceHost)
  return { info, host, name: info?.name || DEFAULT_INSTANCE_NAME }
}

export function useInstanceSync() {
  const loadInstance = useStore(s => s.loadInstance)
  useEffect(() => {
    void loadInstance()
  }, [loadInstance])
}

export function InstanceChip({ host, className = '' }: { host: string; className?: string }) {
  return (
    <span
      title={`Lives on ${host}, another RChat instance`}
      className={`inline-flex max-w-full min-w-0 items-center gap-1 rounded-full bg-tertiary-container px-2 py-0.5 text-[11px] leading-4 font-medium text-on-tertiary-container ${className}`}
    >
      <Globe size={11} className="shrink-0" />
      <span className="streamer truncate">{host}</span>
    </span>
  )
}

export function RailInstance() {
  const { name, host } = useInstance()
  const openDialog = useStore(s => s.openDialog)
  return (
    <button
      title={host ? `${name} (${host})` : name}
      aria-label={`Instance ${name}${host ? ` on ${host}` : ''}`}
      onClick={() => openDialog({ kind: 'settings' })}
      className="flex w-15 shrink-0 flex-col items-center gap-0.5 rounded-xl px-1 py-1.5 text-on-surface-variant hover:bg-surface-container-high hover:text-on-surface"
    >
      <Globe size={16} className="shrink-0" />
      <span className="streamer w-full truncate text-center text-[10px] leading-3 font-semibold text-on-surface">
        {name}
      </span>
      {host && (
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
  const { info, host, name } = useInstance()
  return (
    <div className="flex flex-col gap-3">
      <div className="flex min-w-0 items-center gap-3 rounded-2xl bg-surface-container-high p-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary-container text-on-primary-container">
          <Globe size={20} />
        </span>
        <div className="min-w-0">
          <p className="streamer truncate font-medium text-on-surface">{name}</p>
          <p className="streamer truncate text-sm text-on-surface-variant">{host || home.host}</p>
        </div>
      </div>
      <dl className="divide-y divide-outline-variant px-2 text-sm">
        <Row label="Instance ID">
          <span className="font-mono text-xs">{info?.id ?? 'Unknown'}</span>
        </Row>
        <Row label="Version">{info?.version ?? 'Unknown'}</Row>
        <Row label="API version">{info?.api_version ?? 'Unknown'}</Row>
      </dl>
      <p className="px-2 text-xs text-on-surface-variant">
        Your account, servers and DMs live on this instance. Other RChat instances are run
        independently; anything from them is marked with its host.
      </p>
    </div>
  )
}
