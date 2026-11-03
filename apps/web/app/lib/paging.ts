// Long local lists (P2P members, bans, names in notices): 50 at a time, and a few names inline
// with "and N more" in front of the rest.

export const PAGE = 50
export const FEW = 3

// The first `n` entries of a list.
export const page = <T>(list: readonly T[], n: number) => ({
  items: list.slice(0, n),
  more: list.length > n,
})

// The first `n` entries over groups in order; each group keeps its full count in `total`, and
// groups with nothing shown yet are left out.
export const pageGroups = <G extends { list: readonly unknown[] }>(
  groups: readonly G[],
  n: number
) => {
  let left = n
  const out: (G & { total: number })[] = []
  let all = 0
  for (const g of groups) {
    all += g.list.length
    const take = Math.max(0, Math.min(left, g.list.length))
    left -= take
    if (take) out.push({ ...g, total: g.list.length, list: g.list.slice(0, take) })
  }
  return { groups: out, more: all > n }
}

// The next page size, never past the list.
export const nextPage = (shown: number, total: number) => Math.min(total, shown + PAGE)

// A few entries inline, and how many more there are.
export const fewOf = <T>(list: readonly T[], few = FEW) => ({
  first: list.slice(0, few),
  more: Math.max(0, list.length - few),
})

export const andMore = (n: number) => `and ${n} more`

// Entries whose name contains `q` (any case), all of them for an empty query.
export const matching = <T>(list: readonly T[], q: string, name: (x: T) => string) => {
  const t = q.trim().toLowerCase()
  return t ? list.filter(x => name(x).toLowerCase().includes(t)) : [...list]
}
