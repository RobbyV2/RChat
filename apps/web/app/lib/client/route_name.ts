import { accountUsername, normalizeHost, parseQualified } from '../qualified'

export interface NameActor<T> {
  account: T
  host: string
  lastShown: number
}

export function routeName<T>(raw: string, actor: T, candidates: readonly NameActor<T>[]) {
  const parsed = parseQualified(raw.trim())
  const name = accountUsername(parsed.name)
  const { host } = parsed
  if (!name) return { error: 'Enter a username or username@host' } as const
  const eligible = candidates.filter(c => !host || normalizeHost(c.host) === host)
  const selected =
    eligible.find(c => c.account === actor) ??
    (host
      ? eligible.reduce<NameActor<T> | undefined>(
          (best, c) => (!best || c.lastShown > best.lastShown ? c : best),
          undefined
        )
      : undefined)
  if (!selected)
    return {
      error: host ? `You're not signed in on ${host}.` : 'Sign in to start a direct message',
    } as const
  return { account: selected.account, name } as const
}
