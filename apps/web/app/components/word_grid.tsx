'use client'

import { KeyRound, LayoutGrid, X } from 'lucide-react'
import type { PassKind } from '../lib/password'

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
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
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
                <span className="absolute -right-1 -top-1 flex h-4 w-4 items-center justify-center rounded-full bg-primary text-[10px] font-medium text-on-primary">
                  {idx + 1}
                </span>
              )}
            </button>
          )
        })}
      </div>
      <div className="flex min-h-8 flex-wrap items-center gap-2">
        {selected.map((word, i) => (
          <button
            key={word}
            type="button"
            title={`Remove ${word}`}
            onClick={() => onChange(selected.filter(w => w !== word))}
            className="flex items-center gap-1 rounded-lg bg-secondary-container px-2 py-1 text-xs text-on-secondary-container"
          >
            <span className="font-medium">{i + 1}.</span>
            {word}
            <X size={12} />
          </button>
        ))}
        <span className="text-xs text-on-surface-variant">{selected.length}/7 words in order</span>
      </div>
    </div>
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
    <div role="group" aria-label={label} className="flex">
      {tab('text', 'Password', <KeyRound size={16} />)}
      {tab('words', 'Word grid', <LayoutGrid size={16} />)}
    </div>
  )
}
