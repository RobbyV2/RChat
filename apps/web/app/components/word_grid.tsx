'use client'

import { KeyRound, LayoutGrid, X } from 'lucide-react'
import type { PassKind } from '../lib/password'
import { Grid, Row, Stack, Surface } from './layout'

interface Props {
  words: string[]
  selected: string[]
  onChange: (selected: string[]) => void
}

export function WordGrid({ words, selected, onChange }: Props) {
  const toggle = (word: string) => {
    if (selected.includes(word)) onChange(selected.filter(w => w !== word))
    else if (selected.length < 7) onChange([...selected, word])
  }
  return (
    <Stack gap="md">
      <Grid cols={{ base: 3, sm: 4 }} gap="sm">
        {words.map(word => {
          const idx = selected.indexOf(word)
          return (
            <button
              key={word}
              type="button"
              onClick={() => toggle(word)}
              className={`relative min-w-0 break-words rounded-xl px-1 py-2 text-center text-xs leading-tight min-[360px]:text-sm transition-colors ${
                idx >= 0
                  ? 'bg-primary-container text-on-primary-container'
                  : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'
              }`}
            >
              {word}
              {idx >= 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-3xs font-medium text-on-primary">
                  {idx + 1}
                </span>
              )}
            </button>
          )
        })}
      </Grid>
      <Row gap="sm" wrap>
        {selected.map((word, i) => (
          <Surface
            key={word}
            type="button"
            title={`Remove ${word}`}
            onClick={() => onChange(selected.filter(w => w !== word))}
            as="button"
            row
            pad="sm"
            inset="chip"
            gap="2xs"
            tone="secondary"
            radius="md"
            text="xs"
          >
            <span className="font-medium">{i + 1}.</span>
            {word}
            <X size={12} />
          </Surface>
        ))}
        <span className="flex min-h-8 items-center text-xs text-on-surface-variant">
          {selected.length}/7 words in order
        </span>
      </Row>
    </Stack>
  )
}

export function PassSwitch({
  value,
  onChange,
  label,
}: {
  value: PassKind
  onChange: (kind: PassKind) => void
  label?: string
}) {
  const tab = (kind: PassKind, text: string, icon: React.ReactNode) => (
    <button
      type="button"
      aria-pressed={value === kind}
      onClick={() => onChange(kind)}
      className={`flex flex-1 items-center justify-center gap-2 border border-outline py-2 text-sm transition-colors first:rounded-l-full last:rounded-r-full ${
        value === kind
          ? 'bg-secondary-container text-on-secondary-container'
          : 'text-on-surface-variant hover:bg-surface-container-high'
      }`}
    >
      {icon}
      {text}
    </button>
  )
  return (
    <Row role="group" aria-label={label} gap="none" align="stretch">
      {tab('text', 'Password', <KeyRound size={16} />)}
      {tab('words', 'Word grid', <LayoutGrid size={16} />)}
    </Row>
  )
}
