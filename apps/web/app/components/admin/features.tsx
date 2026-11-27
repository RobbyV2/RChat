'use client'

import { useId, useState, type ReactNode } from 'react'
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
import { Button, IconButton } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { Chips, FieldError, fieldCls } from '../ui'
import { useConfigStore, useControl, usePinned } from './config_state'
import { SourceNote } from './source'

type ChoiceRow = Extract<AdminRow, { kind: 'choice' }>
type NumberRow = Extract<AdminRow, { kind: 'number' }>
type SwitchRow = Extract<AdminRow, { kind: 'switch' }>

const patchOf = (key: string, value: unknown) => ({ [key]: value }) as SiteSettingsPatch

// A line under a switch, inset like the switch's own text.
function Note({ children }: { children: ReactNode }) {
  return (
    <Surface tone="plain" pad="sm" inset="bar">
      <p className="text-xs text-on-surface-variant">{children}</p>
    </Surface>
  )
}

function RowText({ row, id }: { row: AdminRow; id?: string }) {
  return (
    <Stack as="span" id={id} gap="none">
      <span className="text-sm">{row.label}</span>
      <span className="text-xs text-on-surface-variant">{row.line}</span>
    </Stack>
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
    <Surface tone="plain" pad="sm" gap="xs">
      <RowText row={row} />
      {row.list ? (
        <Stack role="radiogroup" aria-label={row.label} gap="2xs">
          {options.map(o => (
            <label
              key={o.value}
              className={`flex min-w-0 items-start gap-3 rounded-xl px-2 py-1.5 pointer-coarse:min-h-11 ${
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
              <Stack as="span" gap="none">
                <span className="text-sm">{o.label}</span>
                {o.line && <span className="text-xs text-on-surface-variant">{o.line}</span>}
              </Stack>
            </label>
          ))}
        </Stack>
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
      {row.note && <p className="text-xs text-on-surface-variant">{row.note}</p>}
    </Surface>
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
    <Surface
      as="form"
      tone="plain"
      pad="sm"
      gap="xs"
      onSubmit={e => {
        e.preventDefault()
        if (!valid) return setError(`Enter ${row.min} to ${row.max} ${row.unit}.`)
        setError(null)
        const save = () => void updateSettings(patchOf(row.key, value))
        const warning = saveWarning(row.key, String(stored), String(value))
        if (warning === null) return save()
        askConfirm({ title: 'Lower the Limit', body: warning, confirm: 'Save', action: save })
      }}
    >
      <label htmlFor={id}>
        <RowText row={row} />
      </label>
      <Row as="span" gap="sm">
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
        <Button
          type="submit"
          variant="filled"
          size="md"
          disabled={pinned || !valid || value === stored}
        >
          Save
        </Button>
      </Row>
      <FieldError message={error} />
    </Surface>
  )
}

function TargetChecks({ row }: { row: AdminRow }) {
  const settings = useStore(s => s.settings)
  const updateSettings = useStore(s => s.updateSettings)
  const pinned = usePinned(row.key)
  return (
    <Surface tone="plain" pad="sm" inset="bar">
      <fieldset
        aria-label={row.label}
        className={settings.profanity_filter ? undefined : 'opacity-60'}
      >
        <Surface tone="base" radius="lg" pad="md">
          <Grid cols={2} gap="sm">
            {PROFANITY_TARGETS.map(({ key, label }) => {
              const locked = pinned || profanityTargetLocked(settings, key)
              return (
                <label
                  key={key}
                  title={label}
                  className={`flex min-w-0 items-center gap-2 py-1 text-sm leading-5 pointer-coarse:min-h-11 md:items-start ${
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
          </Grid>
        </Surface>
      </fieldset>
    </Surface>
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
      {!on && row.off && <Note>Off: {row.off}</Note>}
      {textOnly && <Note>Text only: no attachments, in P2P conversations too.</Note>}
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
    <Surface tone="plain" pad="sm" gap="xs">
      <RowText row={row} />
      {control === null ? (
        <p className="text-xs text-on-surface-variant">Loading</p>
      ) : (
        <>
          {list.length === 0 ? (
            <p className="text-xs text-on-surface-variant">Nobody is on the list.</p>
          ) : (
            <Row as="ul" gap="xs" wrap>
              {list.map((entry, i) => (
                <li
                  key={entry}
                  className="flex max-w-full min-w-0 items-center gap-1 rounded-full border border-outline-variant pr-0.5 pl-3 text-sm md:py-0.5 md:pr-1"
                >
                  <span className="streamer min-w-0 break-all">{entry}</span>
                  <IconButton
                    icon={X}
                    label="Remove from the list"
                    size="sm"
                    data-icon-only
                    disabled={pinned}
                    onClick={() => save(removeEntry(list, i))}
                  />
                </li>
              ))}
            </Row>
          )}
          <Row
            as="form"
            gap="sm"
            onSubmit={e => {
              e.preventDefault()
              const edit = addCreator(list, text)
              setError(edit.error)
              if (edit.error !== null) return
              setText('')
              save(edit.list)
            }}
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
            <Button type="submit" disabled={pinned} place="shrink-0">
              Add
            </Button>
          </Row>
          <FieldError message={error} />
        </>
      )}
    </Surface>
  )
}

type LinkRow = Extract<AdminRow, { kind: 'link' }>

function LinkControl({ row }: { row: LinkRow }) {
  const openAdmin = useStore(s => s.openAdmin)
  return (
    <Surface tone="plain" pad="sm">
      <Row gap="sm" wrap>
        <span className="min-w-40 flex-1">
          <RowText row={row} />
        </span>
        <Button
          onClick={() => openAdmin(row.to === 'servers' ? 'servers' : 'features', null, row.key)}
          place="shrink-0"
        >
          {row.action}
        </Button>
      </Row>
    </Surface>
  )
}

function InfoControl({ row }: { row: AdminRow }) {
  const control = useControl(row.key)
  return (
    <Surface tone="plain" pad="sm" gap="2xs">
      <RowText row={row} />
      {control && (
        <p className="text-xs break-words text-on-surface-variant">
          Now: {shownValue(control.value)}
        </p>
      )}
    </Surface>
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
    <PageRow id="p2p_all">
      <Surface tone="plain" pad="sm">
        <Row gap="sm" wrap>
          <span className="min-w-40 flex-1">
            <Stack as="span" gap="none">
              <span className="text-sm">All of P2P</span>
              <span className="text-xs text-on-surface-variant">
                Peer-to-peer, P2P attachments and P2P backups in one change.
              </span>
            </Stack>
          </span>
          <Button
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
            place="shrink-0"
          >
            {label}
          </Button>
        </Row>
      </Surface>
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
