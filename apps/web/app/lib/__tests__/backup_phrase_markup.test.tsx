import { afterAll, describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { renderToStaticMarkup } from 'react-dom/server'
import { PhraseWords } from '../../components/backup_phrase/phrase_words'
import { PhraseHints, PhraseInput } from '../../components/backup_phrase/phrase_input'
import { WordCheck } from '../../components/backup_phrase/word_check'
import { resetSessionCaches, useStore } from '../store'

const W =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'.split(
    ' '
  )

// Server rendering reads the store's initial state, so the test state goes there.
const initial = useStore.getInitialState()
const setState = (patch: Partial<typeof initial>) => {
  useStore.setState(patch)
  Object.assign(initial, useStore.getState())
}

afterAll(resetSessionCaches)

const labelled = (html: string) => [...html.matchAll(/<input[^>]*aria-label="Word (\d+)"[^>]*>/g)]
const classes = (tag: string) => (/class="([^"]*)"/.exec(tag)?.[1] ?? '').split(' ')
const buttons = (html: string) => [...html.matchAll(/<button[^>]*>[^<]*<\/button>/g)].map(m => m[0])

describe('backup phrase markup', () => {
  test('PhraseWords numbers the words 1 to 12', () => {
    setState({ streamer: false })
    const html = renderToStaticMarkup(<PhraseWords words={W} />)
    W.forEach((w, i) => expect(html).toContain(`${i + 1}. ${w}`))
  })

  test('PhraseWords shows no word in streamer mode until Show', () => {
    setState({ streamer: true })
    const html = renderToStaticMarkup(<PhraseWords words={W} />)
    expect(html).not.toContain('abandon')
    expect(html).not.toContain('about')
    expect(/<button[^>]*>Show<\/button>/.test(html)).toBe(true)
    setState({ streamer: false })
  })

  test('PhraseInput has 12 word fields without autocomplete or spellcheck', () => {
    const html = renderToStaticMarkup(<PhraseInput label="Backup phrase" onWords={() => {}} />)
    const fields = labelled(html)
    expect(fields.map(m => Number(m[1]))).toEqual(Array.from({ length: 12 }, (_, i) => i + 1))
    // Attribute names are case-insensitive in HTML; React writes them camelCased.
    for (const [tag] of fields) {
      expect(tag.toLowerCase()).toContain('autocomplete="off"')
      expect(tag.toLowerCase()).toContain('spellcheck="false"')
    }
    expect(html).toContain('Backup phrase')
  })

  test('WordCheck asks for exactly 3 words by position and can be skipped', () => {
    const html = renderToStaticMarkup(<WordCheck words={W} onDone={() => {}} onSkip={() => {}} />)
    const fields = labelled(html)
    expect(fields).toHaveLength(3)
    const spots = fields.map(m => Number(m[1]))
    expect(new Set(spots).size).toBe(3)
    expect(spots.every(n => n >= 1 && n <= 12)).toBe(true)
    expect(/<button[^>]*>Skip<\/button>/.test(html)).toBe(true)
    expect(html).not.toContain('abandon')
  })

  // The name blur lifts on hover, and a tap leaves hover on: the phrase gets one that never lifts.
  test('streamer mode blurs typed words and suggestions with the class that never lifts', () => {
    setState({ streamer: true })
    const input = renderToStaticMarkup(<PhraseInput label="Backup phrase" onWords={() => {}} />)
    const check = renderToStaticMarkup(<WordCheck words={W} onDone={() => {}} onSkip={() => {}} />)
    const hints = renderToStaticMarkup(<PhraseHints hints={['abandon']} secret onPick={() => {}} />)
    const tags = [...labelled(input), ...labelled(check)].map(m => m[0])
    expect(tags).toHaveLength(15)
    const chips = buttons(hints)
    expect(chips).toHaveLength(1)
    for (const tag of [...tags, ...chips]) {
      expect(classes(tag)).toContain('streamer-secret')
      expect(classes(tag)).not.toContain('streamer')
    }
    expect(input).toContain('Show words')
    expect(check).toContain('Show words')
    setState({ streamer: false })
    const plain = renderToStaticMarkup(<PhraseInput label="Backup phrase" onWords={() => {}} />)
    for (const [tag] of labelled(plain)) expect(classes(tag)).not.toContain('streamer-secret')
    expect(plain).not.toContain('Show words')
  })

  test('suggestions are a labelled group', () => {
    const hints = renderToStaticMarkup(
      <PhraseHints hints={['abandon', 'ability']} secret={false} onPick={() => {}} />
    )
    expect(/<div[^>]*role="group"[^>]*aria-label="Suggestions"/.test(hints)).toBe(true)
    for (const chip of buttons(hints)) expect(classes(chip)).not.toContain('streamer-secret')
  })

  test('the phrase blur has no hover, focus or active reveal', () => {
    const css = readFileSync(fileURLToPath(new URL('../../globals.css', import.meta.url)), 'utf8')
    expect(/\.streamer-mode \.streamer-secret\s*\{[^}]*filter:\s*blur\(/.test(css)).toBe(true)
    const rules = [...css.matchAll(/([^{}]*)\{[^}]*\}/g)].filter(m =>
      m[1].includes('streamer-secret')
    )
    expect(rules).toHaveLength(1)
    expect(/:(hover|focus|active)/.test(rules[0][1])).toBe(false)
  })
})
