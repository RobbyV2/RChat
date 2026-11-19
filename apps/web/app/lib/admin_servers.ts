// The site administration page's server controls: the lists it edits, the form that makes a
// server for someone, and what counts as the built-in server.

import { NAME_MAX } from './rules'
import type { SiteSettings, SiteSettingsPatch } from './types'

export const DEFAULT_SERVERS_MAX = 10
export const CREATORS_MAX = 500

export interface ListEdit {
  list: string[]
  // Why nothing was added.
  error: string | null
}

// The entries of a list as the config view shows it; `none` and an empty value are no entries.
export const listOf = (shown: string | undefined | null): string[] =>
  !shown || shown === 'none'
    ? []
    : shown
        .split(',')
        .map(e => e.trim())
        .filter(Boolean)

const refused = (list: string[], error: string): ListEdit => ({ list, error })

// Adds a server, by its key, to the servers new accounts join.
export const addDefaultServer = (list: string[], name: string): ListEdit => {
  const key = name.trim().toLowerCase()
  if (key === '') return refused(list, 'Choose a server.')
  if (key.includes(',')) return refused(list, "A server name can't have a comma.")
  if (list.includes(key)) return refused(list, 'That server is already on the list.')
  if (list.length >= DEFAULT_SERVERS_MAX)
    return refused(list, `The list holds up to ${DEFAULT_SERVERS_MAX} servers.`)
  return { list: [...list, key], error: null }
}

// Adds a server typed by name to the list `list()` gives, once `exists` says a server has that
// key. The list is read again after the check, so a change made meanwhile stays.
export const addTypedServer = async (
  list: () => string[],
  name: string,
  exists: (key: string) => Promise<boolean>
): Promise<ListEdit> => {
  const first = addDefaultServer(list(), name)
  if (first.error !== null) return first
  if (!(await exists(name.trim().toLowerCase())))
    return refused(list(), 'No server with that name.')
  return addDefaultServer(list(), name)
}

// Adds a username, or a server and one of its roles as `server:role`, to who can create servers.
export const addCreator = (list: string[], entry: string): ListEdit => {
  const text = entry.trim().replace(/^@+/, '')
  if (text === '') return refused(list, 'Type a username or server:role.')
  if (text.includes(',')) return refused(list, "An entry can't have a comma.")
  const parts = text.split(':')
  if (parts.length > 1 && (parts.length > 2 || parts.some(p => p.trim() === '')))
    return refused(list, 'Write a role as server:role.')
  if (list.includes(text)) return refused(list, 'That entry is already on the list.')
  if (list.length >= CREATORS_MAX)
    return refused(list, `The list holds up to ${CREATORS_MAX} entries.`)
  return { list: [...list, text], error: null }
}

// The list with the entry at `index` one place up (`by` -1) or down (1).
export const moveEntry = (list: string[], index: number, by: -1 | 1): string[] => {
  const to = index + by
  if (index < 0 || index >= list.length || to < 0 || to >= list.length) return list
  const next = [...list]
  ;[next[index], next[to]] = [next[to], next[index]]
  return next
}

export const removeEntry = (list: string[], index: number): string[] =>
  index < 0 || index >= list.length ? list : list.filter((_, i) => i !== index)

export interface CreateServerForm {
  name: string
  owner: string
  // Empty for a server without a password.
  password: string
}

// What is wrong with the form that makes a server for someone; null when it can be sent.
export const createServerError = (form: CreateServerForm): string | null => {
  const name = form.name.trim()
  if (name === '') return 'Type a server name.'
  if (Array.from(name).length > NAME_MAX) return `A server name has up to ${NAME_MAX} characters.`
  if (form.owner.trim() === '') return "Type the owner's username."
  if (form.password !== '' && Array.from(form.password).length < 8)
    return 'A password has 8 characters or more.'
  return null
}

// The key of the server every instance starts with.
export const BUILTIN_SERVER = 'rchat'

// Whether `name` is the built-in server: the one with that key, until the site admin removes it.
export const isBuiltin = (name: string, settings: Pick<SiteSettings, 'builtin_server'>) =>
  settings.builtin_server !== 'removed' && name === BUILTIN_SERVER

type P2pSwitches = Pick<SiteSettings, 'p2p' | 'p2p_attachments' | 'p2p_backup'>

export const P2P_KEYS = ['p2p', 'p2p_attachments', 'p2p_backup'] as const

// The one change that turns all of P2P off, or on once all of it is off.
export const p2pAll = (settings: P2pSwitches): { label: string; patch: SiteSettingsPatch } => {
  const on = P2P_KEYS.every(k => !settings[k])
  return {
    label: on ? 'Turn on all P2P' : 'Turn off all P2P',
    patch: { p2p: on, p2p_attachments: on, p2p_backup: on },
  }
}
