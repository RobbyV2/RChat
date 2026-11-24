import { ADD_MAX, parseNames } from '../friends'
import { parseQualified } from '../qualified'
import { routeName, type NameActor } from './route_name'

export function friendNames<T>(text: string, actor: T, choices: readonly NameActor<T>[]) {
  const names = new Set<string>()
  const tokens = text
    .trim()
    .split(/[\s,]+/)
    .filter(Boolean)
    .map(token => parseQualified(token.replace(/^@+/, '')))
  if (new Set(tokens.map(t => t.host).filter(Boolean)).size > 1)
    return { error: 'Add names from one instance at a time.' } as const
  for (const { name, host } of tokens) {
    const [username] = parseNames(name)
    if (!username || name.includes('@'))
      return { error: 'Enter a username or username@host.' } as const
    if (host) {
      const routed = routeName(username + '@' + host, actor, choices)
      if ('error' in routed)
        return {
          error: `You're not signed in on ${host}. Friends are per instance.`,
          host,
        } as const
      if (routed.account !== actor)
        return {
          error: `${username} is on ${host}. Send as your account there.`,
          as: routed.account,
        } as const
    }
    names.add(username)
    if (names.size > ADD_MAX) return { error: `Add up to ${ADD_MAX} friends at a time.` } as const
  }
  return { names: [...names] } as const
}
