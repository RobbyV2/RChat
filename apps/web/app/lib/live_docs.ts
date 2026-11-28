// Interactive docs: the accounts the app on this origin holds, what each may run, the requests a
// docs snippet makes and how answers are shown. Requests go through the app's own connections and
// stored credentials (client/saved_session.ts, client/credentials.ts); nothing here signs in.

import type { Book } from './client/book'
import { REDACTED, isSecretName } from './openapi'
import { hostOf } from './qualified'
import type { Secret } from './secret'
import { anything, jsonObject, jsonOr, parseJson } from './schema'

export interface LiveAccount {
  // `origin` and `username` together.
  key: string
  origin: string
  host: string
  // The instance's name as the app saved it.
  instance: string
  username: string
  display: string | null
  token: Secret | null
}

// What a docs page may do with an account: run requests, nothing until it signs in, nothing while
// its instance has interactive docs off, or nothing yet while the switch is being read.
export type LiveState = 'ready' | 'signed_out' | 'off' | 'checking'

export const accountKey = (origin: string, username: string) => `${username}@${origin}`

// Every instance account the book holds, in its order. Guests and P2P identities have no HTTP API
// account and are left out.
export function liveAccounts(
  book: Book,
  token: (origin: string, username: string) => Secret | null
): LiveAccount[] {
  return book.instances.flatMap(i =>
    i.accounts.map(a => ({
      key: accountKey(i.origin, a.username),
      origin: i.origin,
      host: hostOf(i.origin) ?? i.origin,
      instance: i.name,
      username: a.username,
      display: a.display,
      token: token(i.origin, a.username),
    }))
  )
}

export const liveState = (a: LiveAccount, on: boolean | undefined): LiveState =>
  a.token === null ? 'signed_out' : on === undefined ? 'checking' : on ? 'ready' : 'off'

export const stateText = (a: LiveAccount, state: LiveState) =>
  state === 'ready'
    ? 'Ready'
    : state === 'signed_out'
      ? 'Sign in to use it'
      : state === 'off'
        ? `Trying requests is turned off on ${a.host}`
        : 'Checking'

export const runLabel = (a: LiveAccount) => `Run as ${a.username} on ${a.host}`

// What a write does, for the question before it runs (the account and instance follow).
export const effectOf = (effect: string | undefined, method: string, path: string) =>
  (effect ?? `Sends ${method.toUpperCase()} ${path}`).replace(/\.$/, '')

// The whole question, in plain text.
export const confirmText = (
  effect: string | undefined,
  method: string,
  path: string,
  a: LiveAccount
) => `${effectOf(effect, method, path)} as ${a.username} on ${a.host}.`

export const isWrite = (method: string) => method.toUpperCase() !== 'GET'

// The `{name}` placeholders of a path, in order, each once.
export const placeholders = (path: string) => [
  ...new Set([...path.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m => m[1])),
]

// `path` with its placeholders filled; null while one is empty.
export function fillPath(path: string, values: Record<string, string>): string | null {
  let missing = false
  const filled = path.replace(/\{([A-Za-z0-9_]+)\}/g, (_, name: string) => {
    const v = values[name]?.trim()
    if (!v) missing = true
    return encodeURIComponent(v ?? '')
  })
  return missing ? null : filled
}

// The request as a curl command, with a placeholder where the token goes.
export function curlFor(apiBase: string, method: string, path: string, body: string | null) {
  const lines = [
    `curl -X ${method.toUpperCase()} '${apiBase}${path}'`,
    `  -H 'Authorization: Bearer <token>'`,
  ]
  if (body !== null && body.trim()) {
    lines.push(`  -H 'Content-Type: application/json'`)
    lines.push(`  -d '${body.trim().replace(/'/g, `'\\''`)}'`)
  }
  return lines.join(' \\\n')
}

// A JSON body as typed: null when empty, an error text when it doesn't parse.
export function parseBody(
  text: string
): { ok: true; value: unknown } | { ok: false; error: string } {
  if (!text.trim()) return { ok: true, value: undefined }
  try {
    const read = parseJson(text, anything)
    return read.ok
      ? { ok: true, value: read.value }
      : { ok: false, error: 'The body is not valid JSON.' }
  } catch {
    return { ok: false, error: 'The body is not valid JSON.' }
  }
}

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// The answer with every secret-looking field replaced, in every mode. Yes or no answers stay.
export function redactSecrets(v: unknown, name = ''): unknown {
  const empty = v === null || v === undefined || v === '' || typeof v === 'boolean'
  if (name && isSecretName(name) && !empty) return REDACTED
  if (Array.isArray(v)) return v.map(x => redactSecrets(x))
  if (isObj(v))
    return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactSecrets(x, k)]))
  return v
}

// Fields that name or show a person or a place, masked while streamer mode is on.
const PERSONAL =
  /^(username|usernames|display_name|name|names|old_name|author|owner|creator|from|to|sender|hoster|user|users|friend|other|blocked|pinned_by|content|text|topic|description|bio|filename|file_name|avatar|avatar_url|banner|url|public_url|host|ip|address|email|reason|title|label|server|servers|channel_name|dm_users|online|members|scope_users|display)$/i

// A part of a shown JSON value: plain text, or a personal string to blur.
export interface Shown {
  text: string
  personal: boolean
}

// `v` as indented JSON in parts, with personal strings marked while `streamer` is on.
export function showJson(v: unknown, streamer: boolean): Shown[] {
  const out: Shown[] = []
  const put = (text: string, personal = false) => {
    const last = out[out.length - 1]
    if (last && !last.personal && !personal) last.text += text
    else out.push({ text, personal })
  }
  const walk = (x: unknown, indent: string, personal: boolean) => {
    if (Array.isArray(x)) {
      if (!x.length) return put('[]')
      put('[\n')
      x.forEach((item, i) => {
        put(indent + '  ')
        walk(item, indent + '  ', personal)
        put(i < x.length - 1 ? ',\n' : '\n')
      })
      return put(indent + ']')
    }
    if (isObj(x)) {
      const entries = Object.entries(x)
      if (!entries.length) return put('{}')
      put('{\n')
      entries.forEach(([k, item], i) => {
        put(`${indent}  ${JSON.stringify(k)}: `)
        walk(item, indent + '  ', personal || (streamer && PERSONAL.test(k)))
        put(i < entries.length - 1 ? ',\n' : '\n')
      })
      return put(indent + '}')
    }
    const text = x === undefined ? 'null' : JSON.stringify(x)
    put(text, personal && typeof x === 'string' && x !== REDACTED)
  }
  walk(v, '', false)
  return out
}

// Response headers worth showing: paging, limits and caching.
export const SHOWN_HEADERS = ['content-type', 'retry-after', 'x-next-cursor', 'etag'] as const

// The docs' own choice of account, per device.
export const RUN_AS_KEY = 'rchat_docs_run_as'

export function parseRunAs(raw: string | null): string | null {
  if (!raw) return null
  try {
    const v = jsonOr(raw, jsonObject, null)
    return isObj(v) && v.v === 1 && typeof v.key === 'string' ? v.key : null
  } catch {
    return null
  }
}

export const runAsValue = (key: string) => JSON.stringify({ v: 1, key })

// The account a page runs as: the saved choice while it is listed, else the first ready one,
// else the first listed.
export function pickAccount(
  accounts: LiveAccount[],
  saved: string | null,
  ready: (a: LiveAccount) => boolean
): LiveAccount | null {
  return accounts.find(a => a.key === saved) ?? accounts.find(ready) ?? accounts[0] ?? null
}
