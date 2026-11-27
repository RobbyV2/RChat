'use client'

import { useId, useState } from 'react'
import { Check } from 'lucide-react'
import { validColor } from '../lib/profile'
import { onColor } from '../lib/server_colors'
import { Button } from './controls'
import { Row, Stack } from './layout'

interface ColorPreset {
  color: string
  label: string
}

export function ColorField({
  label,
  value,
  shown,
  onChange,
  presets = [],
  defaultNote,
  resetLabel,
}: {
  label: string
  value: string | null
  shown: string
  onChange: (color: string | null) => void
  presets?: ColorPreset[]
  defaultNote: string
  resetLabel: string
}) {
  const hexId = useId()
  const [text, setText] = useState(value ?? '')
  const [seen, setSeen] = useState(value)
  if (seen !== value) {
    setSeen(value)
    setText(value ?? '')
  }
  const current = value?.toLowerCase() ?? null
  return (
    <Stack role="group" aria-label={label} gap="sm">
      {presets.length > 0 && (
        <Row gap="sm" wrap>
          {presets.map(p => {
            const on = current === p.color
            return (
              <button
                key={p.color}
                type="button"
                title={p.label}
                aria-label={`${label}: ${p.label}`}
                aria-pressed={on}
                onClick={() => onChange(p.color)}
                style={{ background: p.color, color: onColor(p.color) }}
                className={`flex h-8 w-8 items-center justify-center rounded-full border border-outline-variant outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2 focus-visible:ring-offset-surface-container-high ${
                  on ? 'ring-2 ring-primary ring-offset-2 ring-offset-surface-container-high' : ''
                }`}
              >
                {on && <Check size={16} aria-hidden />}
              </button>
            )
          })}
        </Row>
      )}
      <Row gap="md" wrap place="relative">
        <input
          type="color"
          value={shown}
          title="Pick a custom color"
          aria-label={`${label}: custom color`}
          onChange={e => onChange(e.target.value)}
          className="h-8 w-12 cursor-pointer rounded bg-transparent"
        />
        <label htmlFor={hexId} className="sr-only">
          {label} hex code
        </label>
        <input
          id={hexId}
          value={text}
          maxLength={7}
          spellCheck={false}
          autoComplete="off"
          placeholder={shown}
          onChange={e => {
            const next = e.target.value.trim()
            const hex = next.startsWith('#') ? next : `#${next}`
            setText(next)
            if (validColor(hex)) onChange(hex.toLowerCase())
          }}
          onBlur={() => setText(value ?? '')}
          className="w-24 rounded-lg border border-outline bg-transparent px-2 py-1 text-base text-on-surface outline-none placeholder:text-on-surface-variant focus:border-primary md:text-sm"
        />
        {value === null ? (
          <span className="text-xs text-on-surface-variant">{defaultNote}</span>
        ) : (
          <Button onClick={() => onChange(null)}>{resetLabel}</Button>
        )}
      </Row>
    </Stack>
  )
}
