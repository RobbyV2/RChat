// What the app keeps in Web Storage on this device. Web Storage throws in some browsers (blocked,
// full or failing site data), so this module is the only one that reaches it: a read that throws
// gives what nothing saved gives, and a write that throws answers false.
//
// A setting is defined once, with `defineSetting`: its key, whether each instance keeps its own
// (`account`) or the device keeps one (`device`), and how its text is read and written.

import { cause, logWarn } from './log'
import { lit, obj, parseJson, type Schema } from './schema'

export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const local = (): Storage | null => (typeof localStorage === 'undefined' ? null : localStorage)
const session = (): StorageLike | null => window.sessionStorage

// This device's storage, or none where reaching it throws.
export const deviceStorage = (): StorageLike | null => {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

// A value in the storage `store` gives; storage that throws reads as nothing saved.
export const readFrom = (store: () => StorageLike | null, key: string) => {
  try {
    return store()?.getItem(key) ?? null
  } catch {
    return null
  }
}

// Writes or removes a value in the storage `store` gives. False when getting the storage or
// writing to it throws; `warn` says so in the console.
export function writeTo(
  store: () => StorageLike | null,
  key: string,
  value: string | null,
  warn = true
) {
  try {
    const to = store()
    if (value === null) to?.removeItem(key)
    else to?.setItem(key, value)
    return true
  } catch (e) {
    if (warn) logWarn('localStorage write failed', cause(e))
    return false
  }
}

export function canReadSharedStorage() {
  try {
    const store = local()
    if (!store) return false
    store.getItem('rchat_book')
    return true
  } catch {
    return false
  }
}

export const readLocal = (key: string) => readFrom(local, key)

export const localKeys = (prefix: string): string[] => {
  try {
    const storage = local()
    const keys: string[] = []
    if (storage)
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(prefix)) keys.push(key)
      }
    return keys
  } catch {
    return []
  }
}

export const writeLocal = (key: string, value: string | null) => writeTo(local, key, value)

// This tab's sessionStorage, through the same guard.
export const sessionStore: StorageLike = {
  getItem: key => readFrom(session, key),
  setItem: (key, value) => void writeTo(session, key, value, false),
  removeItem: key => void writeTo(session, key, null, false),
}

// The instance whose account a setting belongs to: it names the key the instance keeps it under.
export interface SettingPlace {
  scoped(key: string): string
}

// How a setting's text is read and written. `decode(null)` is what nothing saved reads as, and
// unreadable text reads the same way. `encode` answers null for a value that is not kept.
export interface Codec<T> {
  decode: (raw: string | null) => T
  encode: (value: T) => string | null
}

// A record stored as `{ v: version, ...fields }`: `schema` reads the record into the value,
// `fields` gives the record of a value. Anything else stored reads as `fallback`.
export const versioned = <T>(
  version: number,
  schema: Schema<T>,
  fields: (value: T) => Record<string, unknown>,
  fallback: T
): Codec<T> => {
  const marked = obj({ v: lit(version) })
  return {
    decode: raw => {
      if (raw === null || !parseJson(raw, marked).ok) return fallback
      const read = parseJson(raw, schema)
      return read.ok ? read.value : fallback
    },
    encode: value => JSON.stringify({ v: version, ...fields(value) }),
  }
}

interface Definition<T, Owner extends unknown[]> extends Codec<T> {
  // The key of one owner's value (an account name, or what else tells its values apart).
  key: (...owner: Owner) => string
}

// A setting each instance keeps for its own accounts.
export interface AccountSetting<T, Owner extends unknown[]> extends Codec<T> {
  key(place: SettingPlace, ...owner: Owner): string
  read(place: SettingPlace, ...owner: Owner): T
  // False when the storage refused the write.
  write(place: SettingPlace, value: T, ...owner: Owner): boolean
  clear(place: SettingPlace, ...owner: Owner): boolean
}

// A setting the device keeps once, whatever the instance.
export interface DeviceSetting<T, Owner extends unknown[]> extends Codec<T> {
  key(...owner: Owner): string
  read(...owner: Owner): T
  write(value: T, ...owner: Owner): boolean
  clear(...owner: Owner): boolean
}

const reader =
  <T>(decode: Codec<T>['decode']) =>
  (key: string): T => {
    try {
      return decode(readLocal(key))
    } catch {
      return decode(null)
    }
  }

export function defineSetting<T, Owner extends unknown[] = [string | null]>(
  definition: Definition<T, Owner> & { scope: 'account' }
): AccountSetting<T, Owner>
export function defineSetting<T, Owner extends unknown[] = []>(
  definition: Definition<T, Owner> & { scope: 'device' }
): DeviceSetting<T, Owner>
export function defineSetting<T, Owner extends unknown[]>(
  definition: Definition<T, Owner> & { scope: 'account' | 'device' }
): AccountSetting<T, Owner> | DeviceSetting<T, Owner> {
  const { key, decode, encode, scope } = definition
  const read = reader(decode)
  if (scope === 'device') {
    const device: DeviceSetting<T, Owner> = {
      decode,
      encode,
      key,
      read: (...owner) => read(key(...owner)),
      write: (value, ...owner) => writeLocal(key(...owner), encode(value)),
      clear: (...owner) => writeLocal(key(...owner), null),
    }
    return device
  }
  const at = (place: SettingPlace, owner: Owner) => place.scoped(key(...owner))
  const account: AccountSetting<T, Owner> = {
    decode,
    encode,
    key: (place, ...owner) => at(place, owner),
    read: (place, ...owner) => read(at(place, owner)),
    write: (place, value, ...owner) => writeLocal(at(place, owner), encode(value)),
    clear: (place, ...owner) => writeLocal(at(place, owner), null),
  }
  return account
}
