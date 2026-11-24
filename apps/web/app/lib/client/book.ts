import { accountUsername } from '../qualified'
import type { AvatarKind } from '../types'

export interface BookIdentity {
  local: string
  enrollment?: string
  pendingImport?: { id: string; ik: string }
  ik: string | null
  name: string
  background: boolean
  added: number
}
export interface BookAccount {
  username: string
  display: string | null
  avatar: { kind: AvatarKind; color: string | null } | null
  primary?: true
  connect: boolean
  added: number
  identities: BookIdentity[]
}
export interface BookInstance {
  origin: string
  id: string
  name: string
  accounts: BookAccount[]
  guest: boolean
}
export interface Book {
  v: 1
  instances: BookInstance[]
}

function originOf(raw: unknown) {
  if (typeof raw !== 'string') return null
  try {
    const url = new URL(raw)
    return /^https?:$/.test(url.protocol) &&
      !url.username &&
      !url.password &&
      url.pathname === '/' &&
      !url.search &&
      !url.hash
      ? url.origin
      : null
  } catch {
    return null
  }
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
function json(raw: string | null): unknown {
  try {
    return JSON.parse(raw ?? 'null')
  } catch {
    return null
  }
}
function edit(book: Book, origin: string, apply: (instance: BookInstance) => BookInstance): Book {
  return {
    ...book,
    instances: book.instances.map(i => (i.origin === originOf(origin) ? apply(i) : i)),
  }
}
function towards<T>(items: T[], i: number, to: number) {
  const next = [...items]
  if (i >= 0 && Number.isInteger(to))
    next.splice(Math.max(0, Math.min(next.length - 1, to)), 0, ...next.splice(i, 1))
  return next
}
export function addInstance(book: Book, input: Pick<BookInstance, 'origin' | 'id' | 'name'>): Book {
  const origin = originOf(input.origin)
  if (
    !origin ||
    !input.id ||
    typeof input.name !== 'string' ||
    book.instances.some(i => i.id === input.id && i.origin !== origin)
  )
    return book
  if (book.instances.some(i => i.origin === origin))
    return edit(book, origin, i => ({ ...i, id: input.id, name: input.name }))
  return {
    ...book,
    instances: [
      ...book.instances,
      { origin, id: input.id, name: input.name, guest: false, accounts: [] },
    ],
  }
}
export const removeInstance = (book: Book, origin: string): Book => ({
  ...book,
  instances: book.instances.filter(i => i.origin !== originOf(origin)),
})
export const moveInstance = (book: Book, origin: string, to: number): Book => ({
  ...book,
  instances: towards(
    book.instances,
    book.instances.findIndex(i => i.origin === originOf(origin)),
    to
  ),
})
export const setGuest = (book: Book, origin: string, guest: boolean) =>
  edit(book, origin, i => ({ ...i, guest }))
export function accountAdmission(book: Book, origin: string, username: string): string | null {
  const instance = book.instances.find(i => i.origin === origin)
  if (instance?.accounts.some(account => account.username === username.toLowerCase())) return null
  return book.instances.reduce((n, i) => n + i.accounts.length, 0) >= 50
    ? 'This device already has 50 saved accounts.'
    : null
}
export function addAccount(
  book: Book,
  origin: string,
  input: BookAccount,
  own: string | null
): Book {
  const username = accountUsername(input.username)
  if (!username || accountAdmission(book, origin, username)) return book
  return edit(book, origin, i => {
    const old = i.accounts.find(a => a.username === username)
    const account: BookAccount = { ...input, username }
    delete account.primary
    if (old?.primary || (!old && own && originOf(own) === i.origin && !i.accounts.length))
      account.primary = true
    return {
      ...i,
      accounts: old ? i.accounts.map(a => (a === old ? account : a)) : [...i.accounts, account],
    }
  })
}
export const removeAccount = (book: Book, origin: string, username: string) =>
  edit(book, origin, i => ({ ...i, accounts: i.accounts.filter(a => a.username !== username) }))
export const moveAccount = (book: Book, origin: string, username: string, to: number) =>
  edit(book, origin, i => ({
    ...i,
    accounts: towards(
      i.accounts,
      i.accounts.findIndex(a => a.username === username),
      to
    ),
  }))
function peers(
  book: Book,
  origin: string,
  username: string,
  fn: (ids: BookIdentity[]) => BookIdentity[]
) {
  return edit(book, origin, i => ({
    ...i,
    accounts: i.accounts.map(a =>
      a.username === username ? { ...a, identities: fn(a.identities) } : a
    ),
  }))
}
export const addIdentity = (book: Book, origin: string, username: string, identity: BookIdentity) =>
  peers(book, origin, username, ids =>
    ids.some(i => i.local === identity.local) || ids.length >= 8 ? ids : [...ids, identity]
  )
export const describeIdentity = (
  book: Book,
  origin: string,
  username: string,
  local: string,
  added: number,
  ik: string | null,
  name: string
) =>
  peers(book, origin, username, ids =>
    ids.map(i =>
      i.local === local && i.added === added && !i.pendingImport
        ? { ...i, ik, name: name || i.name }
        : i
    )
  )

// The caller validates the record inside a serialized book edit.
export const editIdentity = (
  book: Book,
  origin: string,
  username: string,
  local: string,
  apply: (record: BookIdentity) => BookIdentity
) => peers(book, origin, username, ids => ids.map(i => (i.local === local ? apply(i) : i)))

export const removeIdentity = (book: Book, origin: string, username: string, local: string) =>
  peers(book, origin, username, ids => ids.filter(i => i.local !== local))
export const moveIdentity = (
  book: Book,
  origin: string,
  username: string,
  local: string,
  to: number
) =>
  peers(book, origin, username, ids =>
    towards(
      ids,
      ids.findIndex(i => i.local === local),
      to
    )
  )

export const setConnected = (book: Book, origin: string, username: string, connect: boolean) =>
  edit(book, origin, i => ({
    ...i,
    accounts: i.accounts.map(a => (a.username === username ? { ...a, connect } : a)),
  }))

export const setIdentityBackground = (
  book: Book,
  origin: string,
  username: string,
  local: string,
  background: boolean
) =>
  peers(book, origin, username, ids => ids.map(i => (i.local === local ? { ...i, background } : i)))

export function parseBook(raw: string | null): Book {
  const data = json(raw)
  let book: Book = { v: 1, instances: [] }
  if (!record(data) || data.v !== 1 || !Array.isArray(data.instances)) return book
  for (const inst of data.instances) {
    if (!record(inst) || typeof inst.id !== 'string' || typeof inst.name !== 'string') continue
    const origin = originOf(inst.origin)
    if (!origin || book.instances.some(i => i.origin === origin || i.id === inst.id)) continue
    book = addInstance(book, { origin, id: inst.id, name: inst.name })
    book = setGuest(book, origin, inst.guest === true)
    if (!Array.isArray(inst.accounts)) continue
    for (const a of inst.accounts) {
      if (!record(a) || typeof a.username !== 'string') continue
      const username = a.username.toLowerCase()
      if (
        book.instances.find(i => i.origin === origin)?.accounts.some(x => x.username === username)
      )
        continue
      const av = a.avatar
      const avatar =
        record(av) && (av.kind === 'color' || av.kind === 'identicon')
          ? { kind: av.kind as AvatarKind, color: typeof av.color === 'string' ? av.color : null }
          : null
      book = addAccount(
        book,
        origin,
        {
          username: a.username,
          avatar,
          display: typeof a.display === 'string' ? a.display : null,
          connect: a.connect !== false,
          added: typeof a.added === 'number' ? a.added : 0,
          identities: [],
        },
        null
      )
      if (a.primary === true)
        book = edit(book, origin, i =>
          i.accounts.some(x => x.primary)
            ? i
            : {
                ...i,
                accounts: i.accounts.map(x =>
                  x.username === username ? { ...x, primary: true } : x
                ),
              }
        )
      if (Array.isArray(a.identities))
        for (const p of a.identities) {
          if (
            record(p) &&
            typeof p.local === 'string' &&
            /^[a-zA-Z0-9_-]+$/.test(p.local) &&
            typeof p.name === 'string'
          )
            book = addIdentity(book, origin, a.username.toLowerCase(), {
              local: p.local,
              ...(typeof p.enrollment === 'string' ? { enrollment: p.enrollment } : {}),
              ...(record(p.pendingImport) &&
              typeof p.pendingImport.id === 'string' &&
              typeof p.pendingImport.ik === 'string'
                ? { pendingImport: { id: p.pendingImport.id, ik: p.pendingImport.ik } }
                : {}),
              name: p.name,
              ik: typeof p.ik === 'string' ? p.ik : null,
              background: p.background !== false,
              added: typeof p.added === 'number' ? p.added : 0,
            })
        }
    }
  }
  return book
}
export function migrateBook(
  keys: string[],
  read: (key: string) => string | null,
  own: string | null
): Book {
  let book: Book = { v: 1, instances: [] }
  const known = json(read('rchat_instances'))
  if (record(known))
    for (const [origin, info] of Object.entries(known)) {
      if (record(info) && typeof info.id === 'string' && typeof info.name === 'string')
        book = addInstance(book, { origin, id: info.id, name: info.name })
    }
  const selected = originOf(read('rchat_home'))
  const defaultOrigin = originOf(own)
  for (const origin of [defaultOrigin, selected]) {
    if (!origin || book.instances.some(i => i.origin === origin)) continue
    const suffix = origin === defaultOrigin ? '' : '@' + new URL(origin).host
    if (read('rchat_guest' + suffix) === '1')
      book = addInstance(book, { origin, id: origin, name: new URL(origin).host })
  }
  for (const i of book.instances) {
    const host = new URL(i.origin).host
    const suffix = i.origin === defaultOrigin ? '' : '@' + host
    const key = 'rchat_guest' + suffix
    const candidates = book.instances.filter(
      other => other.origin !== defaultOrigin && new URL(other.origin).host === host
    )
    const owner = read('rchat_auth_origin' + suffix)
    if (
      keys.includes(key) &&
      read(key) === '1' &&
      (owner === i.origin ||
        (owner === null && (i.origin === defaultOrigin || candidates.length === 1)))
    )
      book = setGuest(book, i.origin, true)
  }
  return book
}
