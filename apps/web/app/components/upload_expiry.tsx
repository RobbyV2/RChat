'use client'

import { ask, sendTo } from '../lib/asks'
import { Loaded, useAccountRequest } from './loaded'
import { instanceName } from '../lib/names'
import { Name } from './name'
import { useAccount } from '../lib/client/react'
import { useId, useState } from 'react'
import { limitsOf } from '../lib/instance_limits'
import { errorText, useStore } from '../lib/store'
import { durationText } from '../lib/timeouts'
import {
  expiryChoice,
  expiryFromChoice,
  keptFullText,
  keptLimited,
  keptShown,
  keptSpace,
  keptText,
  newFilesText,
  ownerKept,
  savedText,
  serverLifetime,
  serverPatch,
  uploadHint,
  type ExpiryForm,
  type ExpiryMode,
  type ExpiryUnit,
  type UploadExpiryState,
} from '../lib/upload_expiry'
import { Button } from './controls'
import { Row, Stack } from './layout'
import { Chips, FieldError, fieldCls, sectionCls } from './ui'
import { useInstanceLabel } from './instance_badge'

// Seconds a file posted now in `server` stays (null: until removed); DMs use the default.
export const useUploadLifetime = (server: string | null | undefined) => {
  const base = useStore(s => limitsOf(s.instance).media_retention_secs)
  const cap = useStore(s => s.settings.upload_expiry_max_days ?? 0)
  const choice = useStore(s => (server ? s.servers[server]?.upload_expiry : undefined))
  const ttl = useStore(s => (server ? s.servers[server]?.upload_ttl : undefined))
  return server ? serverLifetime({ upload_expiry: choice, upload_ttl: ttl }, cap, base) : base
}

// What happens to a file uploaded now in `server`, in words.
export const useUploadHint = (server: string | null | undefined) => {
  const base = useStore(s => limitsOf(s.instance).media_retention_secs)
  const limited = useStore(s => keptLimited(s.instance))
  return uploadHint(useUploadLifetime(server), base, limited)
}

const UNITS: { value: ExpiryUnit; label: string }[] = [
  { value: 'hours', label: 'Hours' },
  { value: 'days', label: 'Days' },
]

// How long files uploaded in a server stay. For people with the Delete server permission.
export function ServerUploadExpiry({ server }: { server: string }) {
  const load = useAccountRequest(() => ask.uploadExpiry(server), [server])
  return (
    <>
      <p className={sectionCls}>File expiry</p>
      <Loaded load={load} what="this setting">
        {first => <ExpiryFields server={server} first={first} />}
      </Loaded>
    </>
  )
}

function ExpiryFields({ server, first }: { server: string; first: UploadExpiryState }) {
  const account = useAccount()
  const { store, lifetime } = account
  const { label } = useInstanceLabel()
  const base = useStore(s => limitsOf(s.instance).media_retention_secs)
  const cap = useStore(s => s.settings.upload_expiry_max_days ?? 0)
  const [saved, setSaved] = useState<UploadExpiryState>(first)
  const [form, setForm] = useState<ExpiryForm>(() => expiryChoice(first.upload_expiry))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [done, setDone] = useState(false)
  const amountId = useId()
  // `revert`: a chip saved at once goes back to the stored choice when the save fails.
  const save = (next: ExpiryForm, revert = false) => {
    const choice = expiryFromChoice(next)
    setDone(false)
    if (!choice) return setError('Choose a whole number from 1 hour to 365 days.')
    setSaving(true)
    setError(null)
    sendTo(account, ask.setUploadExpiry(server, choice))
      .then(
        lifetime.inSession(s => {
          setSaved(s)
          setDone(true)
          store.setState(st => {
            const detail = st.servers[server]
            return detail
              ? { servers: { ...st.servers, [server]: { ...detail, ...serverPatch(s) } } }
              : {}
          })
        }),
        (err: unknown) => {
          setError(errorText(err))
          if (revert) setForm(expiryChoice(saved.upload_expiry))
        }
      )
      .finally(() => setSaving(false))
  }
  const pick = (mode: ExpiryMode) => {
    const next = { ...form, mode }
    setForm(next)
    if (mode !== 'custom') save(next, true)
  }
  const modes: { value: ExpiryMode; label: string }[] = [
    { value: 'default', label: `Default (${durationText(base)})` },
    { value: 'custom', label: 'Custom' },
    ...(cap === 0 || form.mode === 'never' ? [{ value: 'never' as const, label: 'Never' }] : []),
  ]
  const now = serverLifetime(saved, cap, base)
  const kept = keptSpace(saved.kept)
  const owner = ownerKept(saved.owner_kept)
  const full = keptFullText(kept, owner, now, base)
  return (
    <Stack data-upload-expiry gap="sm">
      <p className="text-xs text-on-surface-variant">
        How long files uploaded here stay. Direct messages always use the default.
      </p>
      <Chips label="File expiry" value={form.mode} options={modes} onChange={pick} />
      {form.mode === 'custom' && (
        <Row
          as="form"
          gap="sm"
          wrap
          onSubmit={e => {
            e.preventDefault()
            save(form)
          }}
        >
          <label htmlFor={amountId} className="sr-only">
            Time
          </label>
          <input
            id={amountId}
            type="number"
            inputMode="numeric"
            min={1}
            max={form.unit === 'days' ? 365 : 8760}
            value={Number.isFinite(form.amount) ? form.amount : ''}
            onChange={e => setForm({ ...form, amount: e.target.valueAsNumber })}
            className={`${fieldCls} max-w-24 flex-none`}
          />
          <Chips
            label="Unit"
            value={form.unit}
            options={UNITS}
            onChange={unit => setForm({ ...form, unit })}
          />
          <Button type="submit" variant="filled" size="md" disabled={saving}>
            Save
          </Button>
        </Row>
      )}
      <p data-upload-expiry-now className="text-xs text-on-surface-variant">
        New files: {newFilesText(kept, owner, now, base)}.
        {cap > 0 && (
          <>
            {' '}
            <Name of={instanceName(label)} /> removes files after {durationText(cap * 86400)} at
            most.
          </>
        )}
      </p>
      {kept && keptShown(kept, now, base) && (
        <p data-upload-kept className="text-xs text-on-surface-variant">
          {keptText(kept, owner)}.
        </p>
      )}
      {full && (
        <p data-upload-kept-full className="text-xs text-on-surface">
          {full}
        </p>
      )}
      {done && !error && (
        <span role="status" className="text-xs text-on-surface">
          {savedText(saved.extended, base)}
        </span>
      )}
      <FieldError message={error} />
    </Stack>
  )
}
