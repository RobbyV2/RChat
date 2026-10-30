// A small fuzzy matcher for the command palette. Every word of the query must appear in the text,
// in order of its letters (not necessarily together). Matches at the start of the text or of a
// word, and letters that follow each other, score higher. `hits` are the matched indexes.

export interface FuzzyHit {
  score: number
  hits: number[]
}

const isBoundary = (text: string, i: number) => {
  if (i === 0) return true
  const prev = text[i - 1]
  return /[\s#@/_\-.:>(·]/.test(prev) || (/[a-z]/.test(prev) && /[A-Z]/.test(text[i]))
}

const word = (q: string, text: string, lower: string): FuzzyHit | null => {
  const at = lower.indexOf(q)
  if (at !== -1) {
    let start = at
    // Prefer an occurrence at a word start, when there is one.
    for (let i = at; i !== -1; i = lower.indexOf(q, i + 1)) {
      if (isBoundary(text, i)) {
        start = i
        break
      }
    }
    const hits = Array.from({ length: q.length }, (_, k) => start + k)
    const score =
      q.length * 4 + (start === 0 ? 30 : isBoundary(text, start) ? 18 : 6) - Math.min(start, 20) / 4
    return { score, hits }
  }
  const hits: number[] = []
  let score = 0
  let from = 0
  for (const ch of q) {
    let found = -1
    // A word start ahead wins over the next plain occurrence.
    for (let i = lower.indexOf(ch, from); i !== -1; i = lower.indexOf(ch, i + 1)) {
      if (found === -1) found = i
      if (isBoundary(text, i)) {
        found = i
        break
      }
      if (hits.length && i === hits[hits.length - 1] + 1) break
    }
    if (found === -1) return null
    const prev = hits[hits.length - 1]
    score += 1
    if (prev !== undefined && found === prev + 1) score += 3
    if (isBoundary(text, found)) score += 5
    if (prev !== undefined) score -= Math.min(found - prev - 1, 10) * 0.2
    hits.push(found)
    from = found + 1
  }
  return { score, hits }
}

export const fuzzy = (query: string, text: string): FuzzyHit | null => {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return { score: 0, hits: [] }
  const lower = text.toLowerCase()
  let score = 0
  const hits = new Set<number>()
  for (const w of words) {
    const hit = word(w, text, lower)
    if (!hit) return null
    score += hit.score
    for (const h of hit.hits) hits.add(h)
  }
  if (lower === words.join(' ')) score += 40
  // Shorter texts win ties.
  score -= Math.min(text.length, 200) / 40
  return { score, hits: [...hits].sort((a, b) => a - b) }
}

// `text` split into runs that matched and runs that did not, for highlighting.
export const fuzzyParts = (text: string, hits: number[]) => {
  const set = new Set(hits)
  const out: { text: string; hit: boolean }[] = []
  for (let i = 0; i < text.length; i++) {
    const hit = set.has(i)
    const last = out[out.length - 1]
    if (last && last.hit === hit) last.text += text[i]
    else out.push({ text: text[i], hit })
  }
  return out
}
