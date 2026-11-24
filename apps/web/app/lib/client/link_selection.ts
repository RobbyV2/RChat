// Callers supply only owners eligible for this destination. Ties retain book order.
export function selectLinkOwner<T>(
  eligible: readonly T[],
  preferred: T | undefined,
  actor: T | undefined,
  recency: (owner: T) => number
): { kind: 'add' } | { kind: 'open' | 'choose'; owner: T } {
  if (!eligible.length) return { kind: 'add' }
  for (const candidate of [preferred, actor])
    if (candidate !== undefined && eligible.includes(candidate))
      return { kind: 'open', owner: candidate }
  if (eligible.length === 1) return { kind: 'open', owner: eligible[0] }
  return {
    kind: 'choose',
    owner: eligible.reduce((a, b) => (recency(b) > recency(a) ? b : a)),
  }
}
