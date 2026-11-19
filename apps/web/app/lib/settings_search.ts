// Search over the rows of a settings page. No imports, so any page can use it.

export interface SearchRow {
  // The id of the section that shows the row.
  section: string
  // The heading the row sits under.
  group?: string
  id: string
  label: string
  line?: string
  keywords?: string[]
  // The name of the row's setting in the server config.
  env?: string
}

export interface SearchSection {
  id: string
  label: string
  rows?: SearchRow[]
}

export interface SearchHit {
  row: SearchRow
  // Section, group and label, as the result shows them.
  trail: string[]
}

// Lowercase, without accents.
export const fold = (text: string) => text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()

const has = (text: string, words: string[]) => words.every(w => text.includes(w))

// The rows that have every word of `query`, rows whose label has them first.
export const searchRows = (sections: SearchSection[], query: string, limit = 20): SearchHit[] => {
  const words = fold(query)
    .split(/[\s_]+/)
    .filter(Boolean)
  if (words.length === 0) return []
  const ranked = sections.flatMap(section =>
    (section.rows ?? []).flatMap(row => {
      const label = fold(row.label)
      const near = [
        label,
        fold(section.label),
        fold(row.group ?? ''),
        ...(row.keywords ?? []).map(fold),
      ]
      const env = fold(row.env ?? '').replaceAll('_', ' ')
      const all = [...near, fold(row.line ?? ''), env].join(' ')
      if (!has(all, words)) return []
      const rank = has(label, words) ? 0 : has(near.join(' '), words) ? 1 : 2
      const trail = [section.label, ...(row.group ? [row.group] : []), row.label]
      return [{ rank, hit: { row, trail } }]
    })
  )
  return ranked
    .map((r, at) => ({ ...r, at }))
    .sort((a, b) => a.rank - b.rank || a.at - b.at)
    .slice(0, limit)
    .map(r => r.hit)
}
