import { accountUsername, normalizeHost, parseQualified } from '../qualified'

export interface NameActor<T> {
  account: T
  host: string
  lastShown: number
}

type RoutedName<T> =
  | { account: T; name: string; error?: never; host?: never }
  | { error: string; host?: string; account?: never; name?: never }

export function routeName<T>(
  raw: string,
  actor: T,
  candidates: readonly NameActor<T>[]
): RoutedName<T> {
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
      ...(host ? { host } : {}),
      error: host ? `You're not signed in on ${host}.` : 'Sign in to start a direct message',
    }
  return { account: selected.account, name }
}
