'use client'

import { useEffect, useId, useState, type ReactNode } from 'react'
import { SLOWMODE_MAX } from '../lib/rules'
import { CUSTOM, SLOWMODE_PRESETS, customSeconds, isPreset, slowLabel } from '../lib/slowmode'
import { restrictionItems, type RestrictKey } from '../lib/channel_access'
import { hasBit } from '../lib/perms'
import type { Space } from '../lib/layout'
import { Button, SwitchRow } from './controls'
import { Row, Surface } from './layout'
import { colorSwatchCls, fieldCls, smallFieldCls } from './ui'

// Settings controls shared across the app: an on or off row, permission checks, a role's color,
// name and creation, slow mode, and a channel's restrictions. Callers pass their own actions.

export function SettingSwitch({
  label,
  hint,
  value,
  onChange,
  disabled = false,
}: {
  label: string
  hint?: string
  value: boolean
  onChange: (value: boolean) => void
  disabled?: boolean
}) {
  const hintId = useId()
  return (
    <SwitchRow
      checked={value}
      label={label}
      hint={hint}
      hintId={hintId}
      disabled={disabled}
      onClick={() => onChange(!value)}
    />
  )
}

// What sits under a setting (its notes, a choice), set in like the setting's label: in a box with
// a switch's own inset.
export function SettingNotes({ gap = 'sm', children }: { gap?: Space; children: ReactNode }) {
  return (
    <Surface pad="sm" inset="bar" tone="plain" gap={gap}>
      {children}
    </Surface>
  )
}

export const GRANT_NOTE = 'You can only give permissions you have.'

export interface PermItem {
  label: string
  bit: bigint
  hint?: string
}

// `allowed(v)`: whether the permissions may become `v` (a toggle away from `value`).
export function PermChecks({
  items,
  value,
  onChange,
  allowed,
  locked,
}: {
  items: PermItem[]
  value: bigint
  onChange: (v: bigint) => void
  allowed?: (v: bigint) => boolean
  locked?: string | null
}) {
  return (
    <Row gap="md" wrap>
      {items.map(({ label, bit, hint }) => {
        const off = !!locked || (allowed !== undefined && !allowed(value ^ bit))
        return (
          <Row as="label" key={bit} gap="xs" title={off ? (locked ?? GRANT_NOTE) : hint}>
            <input
              type="checkbox"
              checked={hasBit(value, bit)}
              disabled={off}
              onChange={() => onChange(value ^ bit)}
              className={`accent-primary ${off ? 'opacity-60' : ''}`}
            />
            <span className={`text-sm ${off ? 'opacity-60' : ''}`}>{label}</span>
          </Row>
        )
      })}
    </Row>
  )
}

// A role's color: committed when the picker closes.
export function ColorSwatch({
  initial,
  onCommit,
  locked,
}: {
  initial: string
  onCommit: (color: string) => void
  locked?: string | null
}) {
  const [color, setColor] = useState(initial)
  useEffect(() => setColor(initial), [initial])
  return (
    <input
      type="color"
      value={color}
      title={locked ?? 'Role color'}
      aria-label="Role color"
      disabled={!!locked}
      onChange={e => setColor(e.target.value)}
      onBlur={() => {
        if (color !== initial) onCommit(color)
      }}
      className={colorSwatchCls}
    />
  )
}

// A role's name with a Rename button; `onRename` gets a changed, non-empty name.
export function RoleNameForm({
  initial,
  onRename,
  locked,
  maxLength,
}: {
  initial: string
  onRename: (name: string) => void
  locked?: string | null
  maxLength?: number
}) {
  const [name, setName] = useState(initial)
  useEffect(() => setName(initial), [initial])
  return (
    <Row
      as="form"
      gap="sm"
      align="stretch"
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!locked && trimmed && trimmed !== initial) onRename(trimmed)
      }}
      title={locked ?? undefined}
      place="min-w-0 flex-1"
    >
      <input
        value={name}
        onChange={e => setName(e.target.value)}
        placeholder="Role name"
        aria-label="Role name"
        maxLength={maxLength}
        disabled={!!locked}
        className={`${fieldCls} disabled:opacity-60`}
      />
      <Button type="submit" disabled={!!locked}>
        Rename
      </Button>
    </Row>
  )
}

// A new role: its color and name. The name clears once `onCreate` is done.
export function RoleCreateForm({
  onCreate,
  maxLength,
}: {
  onCreate: (name: string, color: string) => Promise<unknown> | void
  maxLength?: number
}) {
  const [name, setName] = useState('')
  const [color, setColor] = useState('#7c4dff')
  return (
    <Row
      as="form"
      gap="sm"
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        void Promise.resolve(onCreate(trimmed, color)).then(() => setName(''))
      }}
    >
      <input
        type="color"
        value={color}
        title="Role color"
        aria-label="New role color"
        onChange={e => setColor(e.target.value)}
        className={colorSwatchCls}
      />
      <input
        value={name}
        maxLength={maxLength}
        onChange={e => setName(e.target.value)}
        placeholder="New role"
        aria-label="New role name"
        className={fieldCls}
      />
      <Button type="submit">Add</Button>
    </Row>
  )
}

// Slow mode: the presets, or a custom number of seconds. `onApply` gets a changed value.
export function SlowmodeField({
  current,
  onApply,
}: {
  current: number
  onApply: (seconds: number) => void
}) {
  const [custom, setCustom] = useState(!isPreset(current))
  const [text, setText] = useState(isPreset(current) ? '' : String(current))
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    setCustom(!isPreset(current))
    setText(isPreset(current) ? '' : String(current))
  }, [current])
  const apply = (n: number) => {
    setError(null)
    if (n !== current) onApply(n)
  }
  return (
    <Row gap="xs" wrap>
      <Row as="label" gap="xs">
        <span className="text-xs text-on-surface-variant">Slow mode</span>
        <select
          value={custom ? CUSTOM : String(current)}
          onChange={e => {
            if (e.target.value === CUSTOM) {
              setCustom(true)
              setText(current > 0 ? String(current) : '')
              return
            }
            setCustom(false)
            apply(Number(e.target.value))
          }}
          className={`${smallFieldCls} text-on-surface`}
        >
          {SLOWMODE_PRESETS.map(n => (
            <option key={n} value={n}>
              {slowLabel(n)}
            </option>
          ))}
          <option value={CUSTOM}>Custom</option>
        </select>
      </Row>
      {custom && (
        <Row
          as="form"
          gap="xs"
          onSubmit={e => {
            e.preventDefault()
            const n = customSeconds(text)
            if (n === null) setError(`Enter 1 to ${SLOWMODE_MAX} seconds`)
            else apply(n)
          }}
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            inputMode="numeric"
            placeholder="Seconds"
            aria-label="Slow mode seconds"
            title={`1 to ${SLOWMODE_MAX} seconds`}
            className={`w-20 ${smallFieldCls} text-on-surface`}
          />
          <Button type="submit">Set</Button>
        </Row>
      )}
      {error && <p className="basis-full text-xs text-error">{error}</p>}
    </Row>
  )
}

// "Require roles to view/send": `send` false leaves the send restriction out (voice channels).
export function RestrictionToggles({
  nobody,
  value,
  onToggle,
  send = true,
}: {
  nobody: string
  value: Partial<Record<RestrictKey, boolean>>
  onToggle: (key: RestrictKey) => void
  send?: boolean
}) {
  return (
    <>
      {restrictionItems(nobody)
        .filter(r => r.key === 'restrict_view' || send)
        .map(r => (
          <Row as="label" key={r.key} gap="sm" align="baseline">
            <input
              type="checkbox"
              checked={!!value[r.key]}
              onChange={() => onToggle(r.key)}
              className="accent-primary"
            />
            <span className="min-w-0 text-sm">
              <span className="block">{r.label}</span>
              <span className="block text-xs text-on-surface-variant">{r.detail}</span>
            </span>
          </Row>
        ))}
    </>
  )
}
