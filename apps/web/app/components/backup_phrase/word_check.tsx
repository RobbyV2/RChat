'use client'

import { useState, type FormEvent } from 'react'
import { checkAnswers, pickCheck } from '../../lib/backup_phrase'
import { FieldError, filledBtn, textBtn } from '../ui'
import { RevealToggle, SECRET, useReveal } from './reveal'

// Asks for 3 words of the phrase by position. Every check is reported; after a miss the form stays
// open for another try.
export function WordCheck({
  words,
  onDone,
  onSkip,
}: {
  words: string[]
  onDone: (passed: boolean) => void
  onSkip: () => void
}) {
  const reveal = useReveal()
  const [picks] = useState(() => pickCheck())
  const [answers, setAnswers] = useState(['', '', ''])
  const [wrong, setWrong] = useState(false)

  const submit = (e: FormEvent) => {
    e.preventDefault()
    const passed = checkAnswers(words, picks, answers)
    setWrong(!passed)
    onDone(passed)
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-3">
      <p className="text-sm text-on-surface-variant">
        Type these words from your phrase to make sure you saved it.
      </p>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        {picks.map((p, i) => (
          <label key={p} className="flex min-w-0 flex-col gap-1 text-xs text-on-surface-variant">
            {`Word ${p + 1}`}
            <span className="flex rounded-xl border border-outline px-3 focus-within:border-primary">
              <input
                aria-label={`Word ${p + 1}`}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                value={answers[i]}
                onChange={e => {
                  setWrong(false)
                  setAnswers(a => a.map((v, j) => (j === i ? e.target.value : v)))
                }}
                className={`${reveal.hidden ? SECRET : ''} min-w-0 flex-1 bg-transparent py-2 font-mono text-base text-on-surface outline-none md:text-sm`}
              />
            </span>
          </label>
        ))}
      </div>
      <FieldError message={wrong ? "Those words don't match. Check what you saved." : null} />
      <div className="flex items-center justify-end gap-2">
        <span className="mr-auto">
          <RevealToggle reveal={reveal} />
        </span>
        <button type="button" onClick={onSkip} className={textBtn}>
          Skip
        </button>
        <button type="submit" disabled={answers.some(a => !a.trim())} className={filledBtn}>
          Check
        </button>
      </div>
    </form>
  )
}
