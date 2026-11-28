'use client'

import { Name } from './name'
import { accountLabel, instanceAddress, instanceName } from '../lib/names'
import { Globe } from 'lucide-react'
import { useStore } from '../lib/store'
import { useAccount, useConn } from '../lib/client/react'
import { accountNoticeLabel, instanceLabel, labelParts } from '../lib/instance_label'
import { openActionMenu } from '../lib/actions/menu'
import { longPress } from './context_menu'
import { Row, Stack, Surface } from './layout'

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
        p.label ? <Name key={i} of={instanceName(p.text)} /> : p.text
      )}
    </>
  )
}

export function AccountLabel({ notice = false }: { notice?: boolean }) {
  const account = useAccount()
  const username = useStore(s => s.me?.username ?? account.credentialTarget)
  const info = useStore(s => s.instance) ?? account.conn.info
  return (
    <Name
      of={accountLabel(
        notice
          ? accountNoticeLabel(username, info, account.conn.host)
          : (username ?? '~guest') + '@' + account.conn.host
      )}
      look="block truncate text-xs"
    />
  )
}

export function InstanceChip({ host }: { host: string }) {
  const streamer = useStore(s => s.streamer)
  return (
    <Surface
      title={
        streamer ? 'Lives on another RChat instance' : `Lives on ${host}, another RChat instance`
      }
      as="span"
      pad="sm"
      inset="chip"
      gap="2xs"
      row
      tone="plain"
      radius="full"
      look="bg-tertiary-container text-2xs leading-4 font-medium text-on-tertiary-container"
      place="inline-flex max-w-full min-w-0"
    >
      <Globe size={11} className="shrink-0" />
      <Name of={instanceAddress(host)} look="truncate" />
    </Surface>
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
    <Surface
      title={streamer ? 'Instance' : named ? `${label} (${host})` : host}
      aria-label={`Instance ${label}${named ? ` on ${host}` : ''}`}
      onClick={() => openDialog({ kind: 'settings' })}
      {...(signedIn
        ? longPress((x, y) => openActionMenu(x, y, { kind: 'home' }, undefined, acct))
        : {})}
      as="button"
      pad="2xs"
      gap="3xs"
      tone="plain"
      radius="lg"
      align="center"
      ink="muted"
      look="w-15 hover:bg-surface-container-high hover:text-on-surface"
      place="shrink-0"
    >
      <Globe size={16} className="shrink-0" />
      <Name
        of={instanceName(label)}
        look="w-full truncate text-center text-3xs leading-3 font-semibold text-on-surface"
      />
      {named && (
        <Name of={instanceAddress(host)} look="w-full truncate text-center text-3xs leading-3" />
      )}
    </Surface>
  )
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Surface tone="plain" radius="none" pad="sm" inset="bar">
      <Row gap="lg" align="baseline" justify="between">
        <dt className="shrink-0 text-sm text-on-surface-variant">{label}</dt>
        <dd className="min-w-0 truncate text-right text-sm text-on-surface">{children}</dd>
      </Row>
    </Surface>
  )
}

export function InstanceDetails() {
  const info = useStore(s => s.instance)
  const { label, host } = useInstanceLabel()
  return (
    <Stack gap="md">
      <Stack as="dl" gap="none" divided>
        <DetailRow label="Instance ID">
          <span className="font-mono text-xs">{info?.id ?? 'Unknown'}</span>
        </DetailRow>
        <DetailRow label="Version">{info?.version ?? 'Unknown'}</DetailRow>
        <DetailRow label="API version">{info?.api_version ?? 'Unknown'}</DetailRow>
      </Stack>
      <Surface tone="plain" radius="none" pad="sm" inset="bar">
        <p className="text-xs text-on-surface-variant">
          Your account, servers and DMs
          {label === host ? null : (
            <>
              {' '}
              on <Name of={instanceName(label)} />
            </>
          )}{' '}
          live on <Name of={instanceAddress(host)} />. Other instances are run by other people; what
          comes from them is marked with its instance.
        </p>
      </Surface>
    </Stack>
  )
}
