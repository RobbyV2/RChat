'use client'

import { ask, asked } from '../lib/asks'
import { KeyRound, LayoutGrid, X } from 'lucide-react'
import type { PassKind } from '../lib/password'
import { Grid, Row, Stack } from './layout'
import { Loaded, useAccountRequest } from './loaded'
import { Button, Chip, CardButton } from './controls'

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
            <CardButton
              key={word}
              onClick={() => toggle(word)}
              tone="low"
              pad="sm"
              column
              pressed={idx >= 0}
              place="relative min-w-0"
            >
              {word}
              {idx >= 0 && (
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-3xs font-medium text-on-primary">
                  {idx + 1}
                </span>
              )}
            </CardButton>
          )
        })}
      </Grid>
      <Row gap="sm" wrap>
        {selected.map((word, i) => (
          <Button
            key={word}
            title={`Remove ${word}`}
            onClick={() => onChange(selected.filter(w => w !== word))}
            variant="tonal"
          >
            <span className="font-medium">{i + 1}.</span>
            {word}
            <X size={12} />
          </Button>
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
    <Chip onClick={() => onChange(kind)} on={value === kind} plain place="flex-1">
      {icon}
      {text}
    </Chip>
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
