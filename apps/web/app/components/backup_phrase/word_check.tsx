'use client'

import { useState, type FormEvent } from 'react'
import { checkAnswers, pickCheck } from '../../lib/backup_phrase'
import { Button } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { bareFieldCls, FieldError } from '../ui'
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
    <Stack as="form" onSubmit={submit} gap="md">
      <p className="text-sm text-on-surface-variant">
        Type these words from your phrase to make sure you saved it.
      </p>
      <Grid cols={{ base: 1, sm: 3 }} gap="sm">
        {picks.map((p, i) => (
          <Stack as="label" key={p} gap="2xs">
            <span className="text-xs text-on-surface-variant">{`Word ${p + 1}`}</span>
            <Surface
              as="span"
              pad="md"
              inset="sides"
              row
              tone="plain"
              radius="lg"
              align="stretch"
              look="focus-within:border-primary border border-outline"
            >
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
                className={`${reveal.hidden ? SECRET : ''} ${bareFieldCls} font-mono text-on-surface`}
              />
            </Surface>
          </Stack>
        ))}
      </Grid>
      <FieldError message={wrong ? "Those words don't match. Check what you saved." : null} />
      <Row gap="sm" justify="end">
        <Row as="span" gap="none" place="mr-auto">
          <RevealToggle reveal={reveal} />
        </Row>
        <Button size="md" onClick={onSkip}>
          Skip
        </Button>
        <Button type="submit" variant="filled" size="md" disabled={answers.some(a => !a.trim())}>
          Check
        </Button>
      </Row>
    </Stack>
  )
}
