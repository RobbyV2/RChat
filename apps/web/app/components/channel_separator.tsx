'use client'

import { useState } from 'react'
import {
  SEPARATOR_LABEL_MAX,
  SEPARATOR_STYLES,
  STYLE_NAMES,
  categoryStyleOf,
  separatorLabel,
  separatorStyleOf,
} from '../lib/categories'
import { enterKey } from '../lib/keys'
import type { CategoryStyle, SeparatorStyle } from '../lib/types'
import { longPress } from './context_menu'
import type { DragSpec } from './drag'
import { Button } from './controls'
import { Row, Stack, Surface } from './layout'
import { Chips, Dialog, FieldError, Masked, fieldCls } from './ui'

// The line after a label, or alone: dotted or solid. It fills the rest of the row at any
// width.
const lineCls = (style: 'dots' | 'line') =>
  `min-w-4 flex-1 ${
    style === 'dots' ? 'border-b-2 border-dotted border-outline' : 'border-b border-outline-variant'
  }`

// A decorative line between channels of a hosted server or a P2P room, with its label as
// written. It opens nothing; `menu` opens its actions (editing ones for people who manage
// channels).
export function ChannelSeparatorRow({
  label,
  style,
  own,
  menu,
  drag,
}: {
  label: string
  style: SeparatorStyle
  own: boolean
  menu?: (x: number, y: number) => void
  drag?: DragSpec
}) {
  const shown = separatorStyleOf(style)
  const line = shown === 'plain' ? (label ? null : 'line') : shown
  return (
    <Surface
      row
      pad="sm"
      inset="bar"
      gap="sm"
      tone="plain"
      radius="none"
      role="separator"
      aria-label={label || undefined}
      data-separator={label}
      {...(menu ? longPress(menu, drag) : {})}
    >
      {label && (
        <span className="min-w-0 truncate text-xs font-medium text-on-surface-variant select-none">
          <Masked text={label} own={own} />
        </span>
      )}
      {line && <span aria-hidden className={lineCls(line)} />}
    </Surface>
  )
}

// How a category header's name is cased: small capitals by default, as written with a
// decorative style.
// The line after a decorative category header's name.
export function CategoryLine({ style }: { style: CategoryStyle | undefined }) {
  const shown = categoryStyleOf(style)
  return shown === 'default' ? null : <span aria-hidden className={lineCls(shown)} />
}

export const SEPARATOR_STYLE_OPTIONS = SEPARATOR_STYLES.map(value => ({
  value,
  label: STYLE_NAMES[value],
}))

// The form of a new or edited separator, hosted or P2P: its label and line style, with a
// preview.
export function SeparatorForm({
  editing,
  initial,
  own,
  onSave,
  onClose,
}: {
  editing: boolean
  initial: { label: string; style: SeparatorStyle }
  own: boolean
  onSave: (label: string, style: SeparatorStyle) => void
  onClose: () => void
}) {
  const [label, setLabel] = useState(initial.label)
  const [style, setStyle] = useState<SeparatorStyle>(separatorStyleOf(initial.style))
  const clean = separatorLabel(label)
  const save = () => {
    if (clean === null) return
    onClose()
    onSave(clean, style)
  }
  return (
    <Dialog title={editing ? 'Edit separator' : 'Create separator'} onClose={onClose}>
      <Stack gap="lg">
        <Stack gap="md">
          <input
            autoFocus
            value={label}
            onChange={e => setLabel(e.target.value)}
            onKeyDown={e => {
              if (enterKey(e)) save()
            }}
            placeholder="Label (optional)"
            aria-label="Separator label"
            aria-invalid={clean === null}
            className={`${fieldCls} w-full`}
          />
          <FieldError
            message={clean === null ? `At most ${SEPARATOR_LABEL_MAX} characters, one line.` : null}
          />
          <Chips label="Line" value={style} options={SEPARATOR_STYLE_OPTIONS} onChange={setStyle} />
          <Surface pad="sm" tone="low" radius="lg">
            <ChannelSeparatorRow label={clean ?? ''} style={style} own={own} />
          </Surface>
        </Stack>
        <Row gap="sm" justify="end">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="filled" size="md" onClick={save} disabled={clean === null}>
            {editing ? 'Save' : 'Create'}
          </Button>
        </Row>
      </Stack>
    </Dialog>
  )
}
