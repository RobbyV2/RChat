'use client'

import { ask, asked } from '../lib/asks'
import { KeyRound, LayoutGrid, X } from 'lucide-react'
import type { PassKind } from '../lib/password'
import { Grid, Row, Stack, Surface, Inset } from './layout'
import { Loaded, useAccountRequest } from './loaded'

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
            <Surface
              key={word}
              type="button"
              onClick={() => toggle(word)}
              as="button"
              pad="sm"
              tone="plain"
              radius="lg"
              align="center"
              justify="center"
              text="xs"
              look={`break-words text-center leading-tight min-[360px]:text-sm transition-colors ${idx >= 0 ? 'bg-primary-container text-on-primary-container' : 'bg-surface-container-high text-on-surface hover:bg-surface-container-highest'}`}
              place="relative min-w-0"
            >
              {word}
              {idx >= 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-3xs font-medium text-on-primary">
                  {idx + 1}
                </span>
              )}
            </Surface>
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
    <Inset
      type="button"
      aria-pressed={value === kind}
      onClick={() => onChange(kind)}
      as="button"
      row
      pad="sm"
      gap="sm"
      justify="center"
      text="sm"
      look={`border border-outline transition-colors first:rounded-l-full last:rounded-r-full ${value === kind ? 'bg-secondary-container text-on-secondary-container' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
      place="flex-1"
    >
      {icon}
      {text}
    </Inset>
  )
  return (
    <Row role="group" aria-label={label} gap="none" align="stretch">
      {tab('text', 'Password', <KeyRound size={16} />)}
      {tab('words', 'Word grid', <LayoutGrid size={16} />)}
    </Row>
  )
}

// The 20 words of `username` on the account's instance, to pick 7 from. `delayMs` waits for a
// name that is still being typed.
export function AccountWords({
  username,
  selected,
  onChange,
  delayMs,
}: {
  username: string
  selected: string[]
  onChange: (selected: string[]) => void
  delayMs?: number
}) {
  const load = useAccountRequest(
    () => asked(ask.words(username), found => found.words),
    [username],
    {
      delayMs,
    }
  )
  return (
    <Loaded
      load={load}
      skeleton={<p className="text-sm text-on-surface-variant">Loading the 20 words</p>}
      what="the 20 words"
    >
      {words => (
        <WordGrid
          words={words}
          selected={selected.filter(word => words.includes(word))}
          onChange={onChange}
        />
      )}
    </Loaded>
  )
}
