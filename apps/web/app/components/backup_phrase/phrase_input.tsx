'use client'

import { useRef, useState, type ClipboardEvent, type KeyboardEvent } from 'react'
import {
  PHRASE_LENGTH,
  enterAction,
  expand,
  normalize,
  parseQr,
  phraseProblem,
  spread,
  suggest,
  typeInto,
} from '../../lib/backup_phrase'
import { QrScan } from '../p2p/qr_scan'
import { Button } from '../controls'
import { Grid, Row, Stack, Surface } from '../layout'
import { FieldError } from '../ui'
import { RevealToggle, SECRET, useReveal } from './reveal'

const EMPTY: string[] = Array(PHRASE_LENGTH).fill('')

export function PhraseHints({
  hints,
  secret,
  onPick,
}: {
  hints: string[]
  secret: boolean
  onPick: (word: string) => void
}) {
  return (
    <Row role="group" aria-label="Suggestions" gap="2xs" wrap>
      {hints.map(w => (
        <button
          key={w}
          type="button"
          onMouseDown={e => e.preventDefault()}
          onClick={() => onPick(w)}
          className={`${secret ? SECRET : ''} rounded-full bg-secondary-container px-3 py-1 font-mono text-sm text-on-secondary-container hover:opacity-90 pointer-coarse:min-h-11`}
        >
          {w}
        </button>
      ))}
    </Row>
  )
}

// Twelve word fields that take typing, a pasted phrase or its QR code. `onWords` gets the 12
// checked words, or null while they are incomplete or wrong.
export function PhraseInput({
  onWords,
  label,
}: {
  onWords: (w: string[] | null) => void
  label: string
}) {
  const reveal = useReveal()
  const [slots, setSlots] = useState(EMPTY)
  const [overflow, setOverflow] = useState(false)
  const [focus, setFocus] = useState<number | null>(null)
  const [scanNote, setScanNote] = useState<string | null>(null)
  const fields = useRef<(HTMLInputElement | null)[]>([])
  const current = useRef({ slots: EMPTY, overflow: false })

  // Moving focus runs the old field's blur at once, before React renders, so handlers read the
  // state from here.
  const update = (next: string[], over = false) => {
    current.current = { slots: next, overflow: over }
    setSlots(next)
    setOverflow(over)
    onWords(over ? null : normalize(next.join(' ')))
  }
  const focusAt = (i: number) => fields.current[i]?.focus()
  const setSlot = (i: number, word: string) =>
    update(current.current.slots.map((s, j) => (j === i ? word : s)))

  const onChange = (i: number, value: string) => {
    setScanNote(null)
    const typed = typeInto(current.current.slots, i, value)
    update(typed.slots, typed.overflow)
    if (typed.next !== null) focusAt(typed.next)
  }

  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    e.preventDefault()
    setScanNote(null)
    const { slots: next, overflow: over } = spread(
      current.current.slots,
      i,
      e.clipboardData.getData('text')
    )
    update(next, over)
    const empty = next.findIndex((s, j) => j > i && !s)
    if (empty !== -1) focusAt(empty)
  }

  // A unique 4-letter start becomes its word, in view. It is not an edit, so a pending overflow
  // message stays.
  const onBlur = (i: number) => {
    setFocus(f => (f === i ? null : f))
    const { slots: now, overflow: over } = current.current
    const word = expand(now[i])
    if (word && word !== now[i])
      update(
        now.map((s, j) => (j === i ? word : s)),
        over
      )
  }

  const choose = (i: number, word: string) => {
    setSlot(i, word)
    if (i < PHRASE_LENGTH - 1) focusAt(i + 1)
  }

  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      const action = enterAction(current.current.slots, i)
      if (action === 'submit') return
      e.preventDefault()
      if (action === 'next') focusAt(i + 1)
      else choose(i, action.take)
    } else if (e.key === 'Backspace' && !current.current.slots[i] && i > 0) {
      e.preventDefault()
      focusAt(i - 1)
    }
  }

  const onScan = (text: string) => {
    const words = parseQr(text)
    if (!words) return setScanNote("That QR code isn't a backup phrase")
    setScanNote(null)
    update(words)
  }

  const typed = focus === null ? '' : slots[focus]
  const hints = typed ? suggest(typed) : []
  const showHints = hints.length > 0 && !(hints.length === 1 && hints[0] === typed)
  const secret = reveal.hidden ? SECRET : ''

  return (
    <Stack as="fieldset" gap="sm">
      <legend className="pb-2 text-sm font-medium text-on-surface">{label}</legend>
      <Grid cols={{ base: 2, sm: 3 }} gap="sm">
        {slots.map((s, i) => {
          const bad = !!s && focus !== i && expand(s) === null
          return (
            <Surface
              as="label"
              key={i}
              pad="sm"
              inset="sides"
              gap="xs"
              row
              tone="plain"
              radius="lg"
              look={`focus-within:border-primary border ${bad ? 'border-error' : 'border-outline'}`}
              place="min-w-0"
            >
              <span className="w-5 shrink-0 text-right text-xs text-on-surface-variant tabular-nums">
                {i + 1}
              </span>
              <input
                ref={el => {
                  fields.current[i] = el
                }}
                aria-label={`Word ${i + 1}`}
                aria-invalid={bad || undefined}
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                enterKeyHint={i < PHRASE_LENGTH - 1 ? 'next' : 'done'}
                value={s}
                onChange={e => onChange(i, e.target.value)}
                onPaste={e => onPaste(i, e)}
                onFocus={() => setFocus(i)}
                onBlur={() => onBlur(i)}
                onKeyDown={e => onKey(i, e)}
                className={`${secret} min-w-0 flex-1 bg-transparent py-2 font-mono text-base text-on-surface outline-none md:text-sm`}
              />
            </Surface>
          )
        })}
      </Grid>
      {focus !== null && showHints && (
        <PhraseHints hints={hints} secret={reveal.hidden} onPick={w => choose(focus, w)} />
      )}
      <FieldError message={phraseProblem(slots, overflow, focus)} />
      <Row gap="sm" align="start" justify="between" wrap>
        <QrScan onCode={onScan} label="Backup phrase QR code" />
        <Row gap="2xs" align="stretch">
          <RevealToggle reveal={reveal} />
          {slots.some(Boolean) && <Button onClick={() => update(EMPTY)}>Clear</Button>}
        </Row>
      </Row>
      {scanNote && <p className="text-xs text-error">{scanNote}</p>}
    </Stack>
  )
}
