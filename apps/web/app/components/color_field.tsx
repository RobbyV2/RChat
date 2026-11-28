'use client'

import { useId, useState } from 'react'
import { validColor } from '../lib/profile'
import { onColor } from '../lib/server_colors'
import { Button, Swatch } from './controls'
import { Row, Stack } from './layout'
import { smallFieldCls } from './ui'
import { notAName } from '../lib/names'

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
              <Swatch
                key={p.color}
                color={p.color}
                ink={onColor(p.color)}
                on={on}
                label={notAName(`${label}: ${p.label}`)}
                tooltip={notAName(p.label)}
                onClick={() => onChange(p.color)}
              />
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
          className={`w-24 ${smallFieldCls} text-on-surface`}
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
