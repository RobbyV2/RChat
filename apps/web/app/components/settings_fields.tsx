'use client'

import { useEffect, useState } from 'react'
import { SLOWMODE_MAX } from '../lib/rules'
import { CUSTOM, SLOWMODE_PRESETS, customSeconds, isPreset, slowLabel } from '../lib/slowmode'
import { restrictionItems, type RestrictKey } from '../lib/channel_access'
import { fieldCls, textBtn } from './ui'

// Settings controls shared by instance servers and P2P servers: permission checks, a role's color,
// name and creation, slow mode, and a channel's restrictions. Callers pass their own actions.

export const GRANT_NOTE = 'You can only give permissions you have.'

export interface PermItem {
  label: string
  bit: number
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
  value: number
  onChange: (v: number) => void
  allowed?: (v: number) => boolean
  locked?: string | null
}) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-1">
      {items.map(({ label, bit, hint }) => {
        const off = !!locked || (allowed !== undefined && !allowed(value ^ bit))
        return (
          <label
            key={bit}
            title={off ? (locked ?? GRANT_NOTE) : hint}
            className={`flex items-center gap-1.5 text-sm ${off ? 'opacity-60' : ''}`}
          >
            <input
              type="checkbox"
              checked={(value & bit) !== 0}
              disabled={off}
              onChange={() => onChange(value ^ bit)}
              className="accent-primary"
            />
            {label}
          </label>
        )
      })}
    </div>
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
      className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5 disabled:cursor-not-allowed disabled:opacity-60"
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
    <form
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!locked && trimmed && trimmed !== initial) onRename(trimmed)
      }}
      title={locked ?? undefined}
      className="flex min-w-0 flex-1 gap-2"
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
      <button
        disabled={!!locked}
        className={`${textBtn} disabled:opacity-60 disabled:hover:bg-transparent`}
      >
        Rename
      </button>
    </form>
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
    <form
      onSubmit={e => {
        e.preventDefault()
        const trimmed = name.trim()
        if (!trimmed) return
        void Promise.resolve(onCreate(trimmed, color)).then(() => setName(''))
      }}
      className="flex items-center gap-2"
    >
      <input
        type="color"
        value={color}
        title="Role color"
        aria-label="New role color"
        onChange={e => setColor(e.target.value)}
        className="h-9 w-9 shrink-0 cursor-pointer rounded-lg border border-outline bg-transparent p-0.5"
      />
      <input
        value={name}
        maxLength={maxLength}
        onChange={e => setName(e.target.value)}
        placeholder="New role"
        aria-label="New role name"
        className={fieldCls}
      />
      <button className={textBtn}>Add</button>
    </form>
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
    <div className="flex flex-wrap items-center gap-1.5">
      <label className="flex items-center gap-1.5 text-xs text-on-surface-variant">
        Slow mode
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
          className="rounded-lg border border-outline bg-surface-container-high px-2 py-1 text-base text-on-surface outline-none focus:border-primary md:text-sm"
        >
          {SLOWMODE_PRESETS.map(n => (
            <option key={n} value={n}>
              {slowLabel(n)}
            </option>
          ))}
          <option value={CUSTOM}>Custom</option>
        </select>
      </label>
      {custom && (
        <form
          onSubmit={e => {
            e.preventDefault()
            const n = customSeconds(text)
            if (n === null) setError(`Enter 1 to ${SLOWMODE_MAX} seconds`)
            else apply(n)
          }}
          className="flex items-center gap-1.5"
        >
          <input
            value={text}
            onChange={e => setText(e.target.value)}
            inputMode="numeric"
            placeholder="Seconds"
            aria-label="Slow mode seconds"
            title={`1 to ${SLOWMODE_MAX} seconds`}
            className="w-20 rounded-lg border border-outline bg-transparent px-2 py-1 text-base text-on-surface outline-none focus:border-primary md:text-sm"
          />
          <button className={textBtn}>Set</button>
        </form>
      )}
      {error && <p className="basis-full text-xs text-error">{error}</p>}
    </div>
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
          <label key={r.key} className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={!!value[r.key]}
              onChange={() => onToggle(r.key)}
              className="mt-0.5 accent-primary"
            />
            <span className="min-w-0">
              <span className="block">{r.label}</span>
              <span className="block text-xs text-on-surface-variant">{r.detail}</span>
            </span>
          </label>
        ))}
    </>
  )
}
