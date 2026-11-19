'use client'

import { useId, useState } from 'react'
import { saveWarning } from '../../lib/admin_config'
import {
  ADMIN_GROUPS,
  groupRows,
  registrationOptions,
  rowsUnder,
  settingOf,
  type AdminRow,
  type RowOption,
} from '../../lib/admin_rows'
import {
  PROFANITY_TARGETS,
  profanityTargetLocked,
  profanityTargetOn,
  strictFileNamesLocked,
} from '../../lib/rules'
import { useStore } from '../../lib/store'
import type { SiteSettings, SiteSettingsPatch } from '../../lib/types'
import { PageGroup, PageRow } from '../settings_page'
import { SettingSwitch } from '../settings_fields'
import { Chips, FieldError } from '../ui'
import { usePinned } from './config_state'
import { SourceNote } from './source'
import { fieldCls, filledBtn } from './touch'

type ChoiceRow = Extract<AdminRow, { kind: 'choice' }>
type NumberRow = Extract<AdminRow, { kind: 'number' }>
type SwitchRow = Extract<AdminRow, { kind: 'switch' }>

const patchOf = (key: string, value: unknown) => ({ [key]: value }) as SiteSettingsPatch

const noteCls = 'px-2 pb-1 text-xs text-on-surface-variant'

function RowText({ row, id }: { row: AdminRow; id?: string }) {
  return (
    <span id={id} className="flex min-w-0 flex-col">
      <span className="text-sm">{row.label}</span>
      <span className="text-xs text-on-surface-variant">{row.line}</span>
    </span>
  )
}

const optionsOf = (row: ChoiceRow, settings: SiteSettings): RowOption[] =>
  row.key === 'registration' ? registrationOptions(settings.registration) : row.options

function ChoiceControl({ row }: { row: ChoiceRow }) {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  const name = useId()
  const pinned = usePinned(row.key)
  const value = String(settingOf(settings, row.key) ?? '')
  const options = optionsOf(row, settings)
  const set = (v: string) => void updateSettings(patchOf(row.key, v))
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5">
      <RowText row={row} />
      {row.list ? (
        <div role="radiogroup" aria-label={row.label} className="flex flex-col gap-1">
          {options.map(o => (
            <label
              key={o.value}
              className={`flex min-h-11 min-w-0 items-start gap-3 rounded-xl px-2 py-1.5 md:min-h-0 ${
                pinned ? 'cursor-not-allowed opacity-60' : 'hover:bg-surface-container'
              }`}
            >
              <input
                type="radio"
                name={name}
                checked={value === o.value}
                disabled={pinned}
                onChange={() => set(o.value)}
                className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
              />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm">{o.label}</span>
                {o.line && <span className="text-xs text-on-surface-variant">{o.line}</span>}
              </span>
            </label>
          ))}
        </div>
      ) : (
        <>
          <Chips
            label={row.label}
            value={value}
            options={options}
            onChange={set}
            disabled={pinned}
            touch
          />
          <p className="text-xs text-on-surface-variant">
            {options.find(o => o.value === value)?.line}
          </p>
        </>
      )}
      {row.note && <p className="px-2 text-xs text-on-surface-variant">{row.note}</p>}
    </div>
  )
}

function NumberControl({ row }: { row: NumberRow }) {
  const stored = useStore(s => Number(settingOf(s.settings, row.key) ?? 0))
  const updateSettings = useStore(s => s.updateSettings)
  const askConfirm = useStore(s => s.askConfirm)
  const [text, setText] = useState(String(stored))
  const [seen, setSeen] = useState(stored)
  const [error, setError] = useState<string | null>(null)
  const pinned = usePinned(row.key)
  const id = useId()
  if (seen !== stored) {
    setSeen(stored)
    setText(String(stored))
  }
  const value = Number(text)
  const valid =
    text.trim() !== '' && Number.isInteger(value) && value >= row.min && value <= row.max
  return (
    <form
      onSubmit={e => {
        e.preventDefault()
        if (!valid) return setError(`Enter ${row.min} to ${row.max} ${row.unit}.`)
        setError(null)
        const save = () => void updateSettings(patchOf(row.key, value))
        const warning = saveWarning(row.key, String(stored), String(value))
        if (warning === null) return save()
        askConfirm({ title: 'Lower the Limit', body: warning, confirm: 'Save', action: save })
      }}
      className="flex flex-col gap-1.5 px-2 py-1.5"
    >
      <label htmlFor={id}>
        <RowText row={row} />
      </label>
      <span className="flex items-center gap-2">
        <input
          id={id}
          type="number"
          inputMode="numeric"
          min={row.min}
          max={row.max}
          value={text}
          disabled={pinned}
          onChange={e => setText(e.target.value)}
          className={`${fieldCls} max-w-24 flex-none disabled:opacity-50`}
        />
        <span className="text-sm text-on-surface-variant">{row.unit}</span>
        <button disabled={pinned || !valid || value === stored} className={filledBtn}>
          Save
        </button>
      </span>
      <FieldError message={error} />
    </form>
  )
}

function TargetChecks({ row }: { row: AdminRow }) {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  const pinned = usePinned(row.key)
  return (
    <fieldset
      aria-label={row.label}
      className={`mx-2 mb-1 grid grid-cols-2 gap-x-3 gap-y-1 rounded-xl bg-surface-container px-3 py-2 ${
        settings.profanity_filter ? '' : 'opacity-60'
      }`}
    >
      {PROFANITY_TARGETS.map(({ key, label }) => {
        const locked = pinned || profanityTargetLocked(settings, key)
        return (
          <label
            key={key}
            title={label}
            className={`flex min-h-11 min-w-0 items-center gap-2 py-1 text-sm leading-5 md:min-h-0 md:items-start ${
              locked ? 'cursor-not-allowed text-on-surface-variant' : 'text-on-surface'
            }`}
          >
            <input
              type="checkbox"
              checked={profanityTargetOn(settings, key)}
              disabled={locked}
              onChange={e =>
                void updateSettings({ profanity_targets: { [key]: e.target.checked } })
              }
              className="mt-0.5 h-4 w-4 shrink-0 accent-primary"
            />
            <span className="min-w-0 break-words">{label}</span>
          </label>
        )
      })}
    </fieldset>
  )
}

function SwitchControl({ row }: { row: SwitchRow }) {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  const pinned = usePinned(row.key)
  const on = settingOf(settings, row.key) === true
  const textOnly =
    row.key === 'p2p_attachments' && !settings.asset_uploads && !settings.p2p_attachments
  return (
    <>
      <SettingSwitch
        label={row.label}
        hint={row.line}
        value={on}
        disabled={
          pinned || (row.key === 'profanity_strict_file_names' && strictFileNamesLocked(settings))
        }
        onChange={v => void updateSettings(patchOf(row.key, v))}
      />
      {!on && row.off && <p className={noteCls}>Off: {row.off}</p>}
      {textOnly && <p className={noteCls}>Text only: no attachments, in P2P conversations too.</p>}
    </>
  )
}

function RowControl({ row }: { row: AdminRow }) {
  switch (row.kind) {
    case 'switch':
      return <SwitchControl row={row} />
    case 'choice':
      return <ChoiceControl row={row} />
    case 'number':
      return <NumberControl row={row} />
    case 'targets':
      return <TargetChecks row={row} />
  }
}

// Every switch and choice of the instance, in groups.
export function FeaturesSection() {
  return (
    <div>
      {ADMIN_GROUPS.map(group => {
        const rows = groupRows(group)
        if (rows.length === 0) return null
        return (
          <PageGroup key={group} label={group}>
            {rows.flatMap(row =>
              [row, ...rowsUnder(row.key)].map(r => (
                <PageRow key={r.key} id={r.key}>
                  <RowControl row={r} />
                  <SourceNote row={r} />
                </PageRow>
              ))
            )}
          </PageGroup>
        )
      })}
    </div>
  )
}
