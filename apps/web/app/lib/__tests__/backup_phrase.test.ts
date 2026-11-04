import { describe, expect, test } from 'bun:test'
import {
  WORDS,
  checkAnswers,
  derive,
  enterAction,
  generate,
  normalize,
  parseQr,
  phraseProblem,
  pickCheck,
  qrPayload,
  seed,
  spread,
  suggest,
  typeInto,
} from '../backup_phrase'

const ABOUT =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

describe('backup phrase', () => {
  test('generate gives 12 list words that normalize back unchanged', () => {
    const w = generate()
    expect(w).toHaveLength(12)
    expect(w.every(x => WORDS.includes(x))).toBe(true)
    expect(normalize(w.join(' '))).toEqual(w)
  })

  test('normalize is case and space lenient and expands unique 4-letter prefixes', () => {
    expect(
      normalize(
        `  ABANDON\tabandon\n abandon  abandon abandon abandon abandon abandon abandon abandon aban ABOU `
      )
    ).toEqual(ABOUT.split(' '))
    expect(normalize(ABOUT.replace(/ /g, ' '))).toEqual(ABOUT.split(' '))
    expect(normalize(ABOUT.replace(/ /g, ', '))).toEqual(ABOUT.split(' '))
  })

  test('normalize refuses a bad checksum, unknown words, ambiguous prefixes and wrong counts', () => {
    expect(normalize(Array(12).fill('abandon').join(' '))).toBeNull()
    expect(normalize(ABOUT.replace('about', 'zzzz'))).toBeNull()
    expect(normalize(ABOUT.replace('about', 'ab'))).toBeNull()
    expect(normalize(ABOUT.split(' ').slice(0, 11).join(' '))).toBeNull()
    expect(normalize(`${ABOUT} abandon`)).toBeNull()
    expect(normalize('')).toBeNull()
  })

  test('normalize takes a copied numbered list and ignores invisible characters', () => {
    const words = ABOUT.split(' ')
    expect(normalize(words.map((w, i) => `${i + 1}. ${w}`).join('\n'))).toEqual(words)
    expect(normalize(words.map((w, i) => `${i + 1}) ${w}`).join(' '))).toEqual(words)
    expect(normalize(ABOUT.replace(/ /g, ' \u200b').replace('about', 'ab\u00adout\ufeff'))).toEqual(
      words
    )
    const marks = ['\u2060', '\u200e', '\u200f', '\u202e', '\u2066', '\u2069', '\u061c']
    expect(normalize(words.map((w, i) => `${marks[i % marks.length]}${w}`).join(' '))).toEqual(
      words
    )
    expect(normalize(ABOUT.replace(/ /g, '\u2060 \u200f'))).toEqual(words)
    expect(normalize(`${ABOUT} 13.`)).toEqual(words)
    expect(normalize(ABOUT.replace('about', '12'))).toBeNull()
  })

  test('seed matches the BIP39 value with an empty passphrase', async () => {
    expect(hex(await seed(ABOUT.split(' ')))).toBe(
      '5eb00bbddcf069084889a8ab9155568165f5c453ccb85e70811aaed6f6da5fc19a5ac40b389cd370d086206dec8aa6c43daea6690f20ad3d8d48b2d2ce9e38e4'
    )
  })

  test('derive gives fixed, independent keys per purpose', async () => {
    const s = await seed(ABOUT.split(' '))
    expect(hex(derive(s, 'account'))).toBe(
      '3ce6f2b19c948b2c6f3cc5d0f429bab3812866054615593caf48839dec55ca2f'
    )
    expect(hex(derive(s, 'p2p'))).toBe(
      'd59ce086a5690ddd5eed09b4ea773b07f7703e7c3c9b0f5d21d50c15c23fb6fe'
    )
    expect(hex(derive(s, 'backup'))).toBe(
      '2f7d4e5b9b33f50666ca1b7e8ed2f166114694673c4fec6e94801c6d65ece35b'
    )
    expect(hex(derive(s, 'e2ee'))).toBe(
      '280ac01dfeb277eb8e522fa262ad6b861d799c0be8de0c134d1d1cce41548374'
    )
  })

  test('qr payload round-trips and refuses other prefixes and versions', () => {
    const w = ABOUT.split(' ')
    expect(qrPayload(w)).toBe(`rchat-backup:1:${ABOUT}`)
    expect(parseQr(qrPayload(w))).toEqual(w)
    expect(parseQr(`rchat-backup:2:${ABOUT}`)).toBeNull()
    expect(parseQr(ABOUT)).toBeNull()
    expect(parseQr('rchat-backup:1:abandon')).toBeNull()
  })

  test('parseQr takes only what the encoder writes', () => {
    const w = ABOUT.split(' ')
    expect(parseQr(`  rchat-backup:1:${ABOUT}\n`)).toEqual(w)
    expect(parseQr(`rchat-backup:1:${ABOUT.toUpperCase()}`)).toBeNull()
    expect(parseQr(`rchat-backup:1:${ABOUT.replace(/ /g, ', ')}`)).toBeNull()
    expect(parseQr(`rchat-backup:1:${ABOUT.replace(/ /g, '  ')}`)).toBeNull()
    expect(parseQr(`rchat-backup:1:${ABOUT.replace('about', 'abou')}`)).toBeNull()
    expect(parseQr(`RCHAT-BACKUP:1:${ABOUT}`)).toBeNull()
    expect(parseQr(`rchat-backup:1:${Array(12).fill('abandon').join(' ')}`)).toBeNull()
  })

  test('suggest completes from the list; four letters identify a word', () => {
    expect(suggest('aban')).toEqual(['abandon'])
    expect(suggest('ab').length).toBeLessThanOrEqual(4)
    expect(suggest('')).toEqual([])
  })

  test('pickCheck gives 3 distinct ascending positions; checkAnswers is case-insensitive', () => {
    const picks = pickCheck(() => 0.5)
    expect(new Set(picks).size).toBe(3)
    expect([...picks].sort((a, b) => a - b)).toEqual(picks)
    expect(picks.every(p => p >= 0 && p < 12)).toBe(true)
    const w = ABOUT.split(' ')
    expect(checkAnswers(w, [0, 5, 11], ['Abandon', ' abandon', 'about'])).toBe(true)
    expect(checkAnswers(w, [0, 5, 11], ['abandon', 'abandon', 'abandon'])).toBe(false)
    expect(checkAnswers(w, [], [])).toBe(false)
    expect(checkAnswers(w, [0, 5], ['abandon', 'abandon'])).toBe(false)
    expect(checkAnswers(w, [0, 5, 12], ['abandon', 'abandon', 'abandon'])).toBe(false)
  })

  test('pasting a whole phrase or the QR text into any slot fills all 12', () => {
    const empty = Array(12).fill('')
    expect(spread(empty, 3, ABOUT)).toEqual({ slots: ABOUT.split(' '), overflow: false })
    expect(spread(empty, 5, `rchat-backup:1:${ABOUT}`)).toEqual({
      slots: ABOUT.split(' '),
      overflow: false,
    })
    const typed = Array(12).fill('zoo')
    expect(spread(typed, 7, ABOUT.replace(/ /g, ',\n'))).toEqual({
      slots: ABOUT.split(' '),
      overflow: false,
    })
  })

  test('a single word fills its slot; words left over are flagged, never dropped silently', () => {
    expect(spread(Array(12).fill(''), 2, 'Zoo ').slots[2]).toBe('zoo')
    expect(spread(Array(12).fill(''), 10, 'able about acid').overflow).toBe(true)
    expect(spread(Array(12).fill(''), 0, `${ABOUT} abandon`).overflow).toBe(true)
    const some = spread(['able', ...Array(11).fill('')], 4, 'Acid  ACT')
    expect(some).toEqual({
      slots: ['able', '', '', '', 'acid', 'act', ...Array(6).fill('')],
      overflow: false,
    })
    expect(spread(Array(12).fill(''), 0, `rchat-backup:1:${ABOUT} abandon`).overflow).toBe(true)
  })

  test('a copied numbered list pasted anywhere fills all 12', () => {
    const words = ABOUT.split(' ')
    const copied = words.map((w, i) => `${i + 1}. ${w}`).join('\n')
    expect(spread(Array(12).fill(''), 6, copied)).toEqual({ slots: words, overflow: false })
  })

  test('typing: a finished word moves on, a space inside a word overwrites nothing', () => {
    const filled = ['liz', 'music', ...Array(10).fill('')]
    expect(typeInto(filled, 0, 'liz ard')).toEqual({
      slots: ['liz ard', 'music', ...Array(10).fill('')],
      overflow: false,
      next: null,
    })
    expect(typeInto(filled, 0, 'Lizard ')).toEqual({
      slots: ['lizard', 'music', ...Array(10).fill('')],
      overflow: false,
      next: 1,
    })
    expect(typeInto(filled, 0, 'lizard,').next).toBe(1)
    expect(typeInto(filled, 11, 'zoo ').next).toBeNull()
    expect(typeInto(filled, 0, ' ').slots[0]).toBe('')
    expect(typeInto(filled, 4, ABOUT).slots).toEqual(ABOUT.split(' '))
    expect(typeInto(filled, 4, `rchat-backup:1:${ABOUT}`).slots).toEqual(ABOUT.split(' '))
    expect(typeInto(filled, 1, 'rchat-backup:1:').slots).toEqual([
      'liz',
      'rchat-backup:1:',
      ...Array(10).fill(''),
    ])
  })

  test('the checksum message waits while the focused field is mid-word', () => {
    const words = ABOUT.split(' ')
    const wrong = [...words.slice(0, 11), 'a']
    expect(phraseProblem(wrong, false, 11)).toBeNull()
    expect(phraseProblem(wrong, false, null)).toBe('Check the words: one of them is wrong')
    const swapped = [...words.slice(0, 11), 'abandon']
    expect(phraseProblem(swapped, false, 11)).toBe('Check the words: one of them is wrong')
    expect(phraseProblem(words, false, 11)).toBeNull()
    expect(phraseProblem(['abandon', ...Array(11).fill('')], false, null)).toBeNull()
    expect(phraseProblem(words, true, null)).toBe("That's more than 12 words")
  })

  test('Enter takes the one suggestion, else moves on, and submits from the last field', () => {
    const slots = ['aban', 'act', ...Array(9).fill(''), 'abou']
    expect(enterAction(slots, 0)).toEqual({ take: 'abandon' })
    expect(enterAction(slots, 1)).toBe('next')
    expect(enterAction(slots, 11)).toEqual({ take: 'about' })
    expect(enterAction([...slots.slice(0, 11), 'about'], 11)).toBe('submit')
    expect(enterAction([...slots.slice(0, 11), ''], 11)).toBe('submit')
  })
})
