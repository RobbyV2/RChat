import { generateMnemonic, mnemonicToSeed, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { utf8ToBytes } from '@noble/hashes/utils.js'

export type KeyPurpose = 'account' | 'p2p' | 'backup' | 'e2ee'

export const WORDS: readonly string[] = wordlist
export const PHRASE_LENGTH = 12
const KNOWN = new Set(WORDS)
const QR_PREFIX = 'rchat-backup:1:'
const QR_WORDS = /^rchat-backup:1:([a-z]+(?: [a-z]+){11})$/
const PREFIX_LETTERS = 4
export const CHECK_COUNT = 3
// Format characters (zero-width spaces and joiners, direction marks, soft hyphens) never show.
const INVISIBLE = /\p{Cf}/gu
const POSITION = /^\d{1,2}[.)]?$/

const clean = (text: string) => text.normalize('NFKD').replace(INVISIBLE, '').toLowerCase()

// Words from typed or pasted text. Position numbers, as in a copied list, are never list words.
export const tokens = (text: string) =>
  clean(text)
    .split(/[\s,]+/u)
    .filter(t => t && !POSITION.test(t))

// A list word as typed, or the one list word that starts with at least 4 typed letters.
export const expand = (token: string): string | null => {
  if (KNOWN.has(token)) return token
  if (token.length < PREFIX_LETTERS) return null
  const hits = WORDS.filter(w => w.startsWith(token))
  return hits.length === 1 ? hits[0] : null
}

export const generate = () => generateMnemonic(wordlist, 128).split(' ')

export const normalize = (text: string): string[] | null => {
  const parts = tokens(text)
  if (parts.length !== PHRASE_LENGTH) return null
  const words = parts.map(expand)
  if (words.some(w => w === null)) return null
  const full = words as string[]
  return validateMnemonic(full.join(' '), wordlist) ? full : null
}

export const seed = (words: string[]) => mnemonicToSeed(words.join(' '), '')

export const derive = (seed: Uint8Array, purpose: KeyPurpose) =>
  hkdf(sha256, seed, new Uint8Array(0), utf8ToBytes(`rchat-${purpose}-v1`), 32)

export const qrPayload = (words: string[]) => `${QR_PREFIX}${words.join(' ')}`

// Only what `qrPayload` writes: 12 exact list words, one space apart, with a good checksum.
export const parseQr = (text: string) => {
  const body = QR_WORDS.exec(text.trim())?.[1]
  if (!body) return null
  const words = body.split(' ')
  return words.every(w => KNOWN.has(w)) && validateMnemonic(body, wordlist) ? words : null
}

export const suggest = (prefix: string, max = 4) => {
  const p = clean(prefix).trim()
  if (!p) return []
  const out: string[] = []
  for (const w of WORDS) {
    if (out.length >= max) break
    if (w.startsWith(p)) out.push(w)
  }
  return out
}

const randomUnit = () => crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32

export const pickCheck = (rand: () => number = randomUnit): [number, number, number] => {
  const spots = Array.from({ length: PHRASE_LENGTH }, (_, i) => i)
  for (let i = 0; i < CHECK_COUNT; i++) {
    const j = i + Math.min(PHRASE_LENGTH - i - 1, Math.floor(rand() * (PHRASE_LENGTH - i)))
    ;[spots[i], spots[j]] = [spots[j], spots[i]]
  }
  const [a, b, c] = spots.slice(0, CHECK_COUNT).sort((x, y) => x - y)
  return [a, b, c]
}

export const checkAnswers = (words: string[], picks: number[], answers: string[]) =>
  picks.length === CHECK_COUNT &&
  answers.length === CHECK_COUNT &&
  picks.every((p, i) => words[p] !== undefined && expand(clean(answers[i]).trim()) === words[p])

// Puts typed or pasted text into the 12 word slots. A QR payload or exactly 12 words replace all of
// them; anything else fills from `at`. Words that don't fit are reported, never dropped quietly.
export const spread = (slots: string[], at: number, text: string) => {
  const t = text.trim()
  const qr = t.startsWith(QR_PREFIX) ? tokens(t.slice(QR_PREFIX.length)) : null
  const parts = qr ?? tokens(t)
  const whole = qr !== null || parts.length === PHRASE_LENGTH
  const start = whole ? 0 : Math.max(0, Math.min(at, PHRASE_LENGTH - 1))
  const next = whole
    ? Array<string>(PHRASE_LENGTH).fill('')
    : Array.from({ length: PHRASE_LENGTH }, (_, i) => slots[i] ?? '')
  parts.slice(0, PHRASE_LENGTH - start).forEach((w, i) => (next[start + i] = w))
  return { slots: next, overflow: parts.length > PHRASE_LENGTH - start }
}

export const OVERFLOW = "That's more than 12 words"
export const WRONG_WORDS = 'Check the words: one of them is wrong'

// A full set that fails is reported once the focused field holds a word, not while it is typed.
export const phraseProblem = (slots: string[], overflow: boolean, focus: number | null) => {
  if (overflow) return OVERFLOW
  if (slots.some(s => !s)) return null
  if (focus !== null && expand(slots[focus]) === null) return null
  return normalize(slots.join(' ')) ? null : WRONG_WORDS
}

// Typing into field `at`. A whole phrase (12 words, or the QR text) fills every field; a word
// followed by a space or comma is done and focus moves on; anything else stays as typed, so a space
// inside a word never writes into the next field.
export const typeInto = (slots: string[], at: number, value: string) => {
  const t = value.trim()
  const body = t.startsWith(QR_PREFIX) ? t.slice(QR_PREFIX.length) : t
  if (tokens(body).length === PHRASE_LENGTH) return { ...spread(slots, at, value), next: null }
  const done = /^([^\s,]+)[\s,]+$/u.exec(value)
  const word = /^[\s,]*$/u.test(value) ? '' : (done?.[1] ?? value).toLowerCase()
  return {
    slots: slots.map((s, i) => (i === at ? word : s)),
    overflow: false,
    next: done && at < PHRASE_LENGTH - 1 ? at + 1 : null,
  }
}

// Enter takes the one suggestion left, else moves on; in the last field it submits the form.
export const enterAction = (slots: string[], at: number): { take: string } | 'next' | 'submit' => {
  const typed = slots[at]
  const hits = typed ? suggest(typed, 2) : []
  if (hits.length === 1 && hits[0] !== typed) return { take: hits[0] }
  return at < PHRASE_LENGTH - 1 ? 'next' : 'submit'
}
