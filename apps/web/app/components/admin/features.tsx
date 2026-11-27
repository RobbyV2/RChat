'use client'

import { useId, useState } from 'react'
import { X } from 'lucide-react'
import { controlOf, saveWarning, shownValue } from '../../lib/admin_config'
import {
  ADMIN_GROUPS,
  groupRows,
  registrationOptions,
  rowsUnder,
  settingOf,
  type AdminRow,
  type RowOption,
} from '../../lib/admin_rows'
import { P2P_KEYS, addCreator, listOf, p2pAll, removeEntry } from '../../lib/admin_servers'
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
import { useConfigStore, useControl, usePinned } from './config_state'
import { SourceNote } from './source'
import { fieldCls, filledBtn, textBtn } from './touch'

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

// A list of usernames and server:role entries, which only the config view carries.
function NamesControl({ row }: { row: AdminRow }) {
  const control = useControl(row.key)
  const updateSettings = useStore(s => s.updateSettings)
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const pinned = control?.pinned ?? false
  const list = listOf(control?.value)
  const save = (next: string[]) => {
    setError(null)
    void updateSettings(patchOf(row.key, next))
  }
  return (
    <div className="flex flex-col gap-1.5 px-2 py-1.5">
      <RowText row={row} />
      {control === null ? (
        <p className="text-xs text-on-surface-variant">Loading</p>
      ) : (
        <>
          {list.length === 0 ? (
            <p className="text-xs text-on-surface-variant">Nobody is on the list.</p>
          ) : (
            <ul className="flex flex-wrap gap-1.5">
              {list.map((entry, i) => (
                <li
                  key={entry}
                  className="flex max-w-full min-w-0 items-center gap-1 rounded-full border border-outline-variant pr-0.5 pl-3 text-sm md:py-0.5 md:pr-1"
                >
                  <span className="streamer min-w-0 break-all">{entry}</span>
                  <button
                    type="button"
                    data-icon-only
                    title="Remove from the list"
                    aria-label="Remove from the list"
                    disabled={pinned}
                    onClick={() => save(removeEntry(list, i))}
                    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-on-surface-variant enabled:hover:bg-surface-container-high disabled:opacity-50 md:h-7 md:w-7"
                  >
                    <X size={14} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          <form
            onSubmit={e => {
              e.preventDefault()
              const edit = addCreator(list, text)
              setError(edit.error)
              if (edit.error !== null) return
              setText('')
              save(edit.list)
            }}
            className="flex gap-2"
          >
            <input
              value={text}
              disabled={pinned}
              onChange={e => {
                setError(null)
                setText(e.target.value)
              }}
              placeholder="Username or server:role"
              aria-label="Add a person or role"
              className={`${fieldCls} streamer disabled:opacity-50`}
            />
            <button disabled={pinned} className={`${textBtn} shrink-0 disabled:opacity-50`}>
              Add
            </button>
          </form>
          <FieldError message={error} />
        </>
      )}
    </div>
  )
}

type LinkRow = Extract<AdminRow, { kind: 'link' }>

function LinkControl({ row }: { row: LinkRow }) {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <div className="flex flex-wrap items-center gap-2 px-2 py-1.5">
      <span className="min-w-40 flex-1">
        <RowText row={row} />
      </span>
      <button
        onClick={() => openAdmin(row.to === 'servers' ? 'servers' : 'features', null, row.key)}
        className={`${textBtn} shrink-0`}
      >
        {row.action}
      </button>
    </div>
  )
}

function InfoControl({ row }: { row: AdminRow }) {
  const control = useControl(row.key)
  return (
    <div className="flex flex-col gap-1 px-2 py-1.5">
      <RowText row={row} />
      {control && (
        <p className="text-xs break-words text-on-surface-variant">
          Now: {shownValue(control.value)}
        </p>
      )}
    </div>
  )
}

// Peer-to-peer, P2P attachments and P2P backups in one change.
function P2pAll() {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  const askConfirm = useStore(s => s.askConfirm)
  const pinned = useConfigStore(s => P2P_KEYS.some(k => controlOf(s.config, k)?.pinned))
  const { label, patch } = p2pAll(settings)
  return (
    <PageRow id="p2p_all" className="flex flex-wrap items-center gap-2 px-2 py-1.5">
      <span className="flex min-w-40 flex-1 flex-col">
        <span className="text-sm">All of P2P</span>
        <span className="text-xs text-on-surface-variant">
          Peer-to-peer, P2P attachments and P2P backups in one change.
        </span>
      </span>
      <button
        disabled={pinned}
        onClick={() =>
          askConfirm({
            title: patch.p2p ? 'Turn On All P2P' : 'Turn Off All P2P',
            body: patch.p2p
              ? 'Turn on Peer-to-peer, P2P attachments and P2P backups?'
              : 'Turn off Peer-to-peer, P2P attachments and P2P backups? The app hides P2P and stops P2P signaling. Data stays on devices.',
            confirm: patch.p2p ? 'Turn on' : 'Turn off',
            action: () => void updateSettings(patch),
          })
        }
        className={`${textBtn} shrink-0 disabled:opacity-50`}
      >
        {label}
      </button>
    </PageRow>
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
    case 'names':
      return <NamesControl row={row} />
    case 'link':
      return <LinkControl row={row} />
    case 'info':
      return <InfoControl row={row} />
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
            {group === 'P2P' && <P2pAll />}
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
