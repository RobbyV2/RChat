import { expand } from '../backup_phrase'
import type { LogEntry, LogSpan } from './types'

export const HIDDEN = '[hidden]'
export const MAX_CHARS = 200

const SECRET_KEY =
  /(token|key|secret|pass|code|sig|grant|ticket|invite|auth|otp|session|sid|jwt|state|nonce)/i
const POSITION = /^\d{1,2}[.)]?$/
const PHRASE_RUN = 6
const URL_RUN = /((?:https?|rchat):\/\/[^\s<>"'`]*)/i

const scrubQuery = (url: string) =>
  url.replace(/([?&])([^=&#\s]+)=([^&#\s]*)/g, (all, sep: string, k: string) =>
    SECRET_KEY.test(k) ? `${sep}${k}=${HIDDEN}` : all
  )

const scrubUrl = (u: string) => {
  const t = scrubQuery(u.replace(/^((?:https?|rchat):\/\/)[^/?#\s]*@/i, `$1${HIDDEN}@`))
  const h = t.indexOf('#')
  return h === -1 ? t : `${t.slice(0, h)}#${HIDDEN}`
}

// Long random runs outside URLs: base64, base64url or hex with "/" and "+", 24 or more characters
// that mix letters and digits, any run of 40 or more, and padded base64 of 12 or more. A run that
// starts with "/" is a path.
const scrubRuns = (token: string) => {
  const t = token.replace(/[A-Za-z0-9_\-+/]{10,}={1,2}(?![A-Za-z0-9])/g, HIDDEN)
  return t.replace(/[A-Za-z0-9_\-+/=]{24,}/g, (run, at: number) => {
    if (run.startsWith('/') || run === HIDDEN) return run
    if (at > 0 && /[A-Za-z0-9]/.test(t[at - 1] ?? '')) return run
    return run.length >= 40 || (/[0-9]/.test(run) && /[A-Za-z]/.test(run)) ? HIDDEN : run
  })
}

// Runs of 6 or more phrase words, separated by spaces or commas or joined by - / . _ ; position
// numbers like "3." don't break a run.
const phraseRuns = (text: string, word: (t: string) => string | null) => {
  const toks = [...text.matchAll(/[^\s,]+/g)].map(m => {
    const t = m[0].toLowerCase()
    const parts = t.split(/[-/._]/).filter(Boolean)
    const wordy = parts.length > 0 && parts.every(p => /^[a-z]+$/.test(p) && word(p) !== null)
    return {
      s: m.index,
      e: m.index + m[0].length,
      words: wordy ? parts.length : 0,
      pos: POSITION.test(t),
    }
  })
  const cut: [number, number][] = []
  let start = -1
  let count = 0
  let last = -1
  const close = () => {
    if (count >= PHRASE_RUN) cut.push([toks[start].s, toks[last].e])
    start = -1
    count = 0
  }
  toks.forEach((t, i) => {
    if (t.words > 0) {
      if (start === -1) start = i
      count += t.words
      last = i
    } else if (!(t.pos && start !== -1)) close()
  })
  close()
  return cut.reduceRight((out, [s, e]) => out.slice(0, s) + HIDDEN + out.slice(e), text)
}

// What a string keeps once it is in the log. Run on every string at write and again at export.
export const scrub = (text: string, word: (t: string) => string | null = expand) => {
  const qr = text.toLowerCase().indexOf('rchat-backup:1:')
  const t = phraseRuns(
    (qr === -1 ? text : text.slice(0, qr) + HIDDEN)
      .replace(/\bBearer\s+\S+/gi, `Bearer ${HIDDEN}`)
      .replace(/\bAuthorization:\s*\S+(?:\s+\S+)?/gi, `Authorization: ${HIDDEN}`)
      .replace(/\/webhooks\/(\d+)\/[^/?#\s]+/g, `/webhooks/$1/${HIDDEN}`)
      .split(/(\s+)/)
      .map(tok => {
        if (!tok || /^\s+$/.test(tok)) return tok
        return tok
          .split(URL_RUN)
          .map((part, i) => {
            if (i % 2 === 1) return scrubUrl(part)
            return scrubRuns(part.includes('?') ? scrubQuery(part) : part)
          })
          .join('')
      })
      .join(''),
    word
  )
  const chars = Array.from(t)
  return chars.length > MAX_CHARS ? chars.slice(0, MAX_CHARS - 1).join('') + '…' : t
}

// Hides the spans the server marked for hidden arguments, from the end so that earlier offsets
// stay valid. A span outside the text, or one that overlaps a later one, is clamped.
export const stripSpans = (text: string, spans: LogSpan[], hidden: ReadonlySet<string>) => {
  const whole = (n: number) => Number.isInteger(n) && n >= 0
  const marked = spans
    .filter(sp => hidden.has(sp.arg) && whole(sp.start) && whole(sp.end) && sp.start < sp.end)
    .sort((a, b) => b.start - a.start)
  let t = text
  let until = text.length
  for (const sp of marked) {
    const end = Math.min(sp.end, until)
    if (sp.start >= end) continue
    t = t.slice(0, sp.start) + HIDDEN + t.slice(end)
    until = sp.start
  }
  return t
}

// Hides exact values, the longest first.
export const stripValues = (text: string, values: string[]) =>
  [...values]
    .filter(Boolean)
    .sort((a, b) => b.length - a.length)
    .reduce((t, v) => t.split(v).join(HIDDEN), text)

// An entry with every string scrubbed.
export const scrubEntry = (e: LogEntry, word?: (t: string) => string | null): LogEntry => ({
  ...e,
  title: scrub(e.title, word),
  ...(e.target ? { target: { ...e.target, label: scrub(e.target.label, word) } } : {}),
  ...(e.args
    ? { args: e.args.map(a => ({ name: scrub(a.name, word), value: scrub(a.value, word) })) }
    : {}),
  ...(e.text === undefined ? {} : { text: scrub(e.text, word) }),
})
