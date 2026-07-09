'use client'

import { X } from 'lucide-react'

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
      <div className="grid grid-cols-4 gap-2 sm:grid-cols-5">
        {words.map(word => {
          const idx = selected.indexOf(word)
          return (
            <button
              key={word}
              type="button"
              onClick={() => toggle(word)}
              className={`relative min-w-0 break-words rounded-xl px-2 py-2 text-center text-sm leading-tight transition-colors ${
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
