// The key a device seals its P2P stores with: one AES-256-GCM key per profile, made on first
// need. The web keeps it as a non-extractable WebCrypto key in the P2P database's `meta` store;
// the desktop and mobile shells keep it wrapped by a key in the shell's `DeviceStore`.
import type { DeviceStore } from './device_store'

export interface DeviceKey {
  id: number
  key: CryptoKey
}

export interface DeviceKeys {
  // The key new records are sealed with.
  get(): Promise<CryptoKey>
  current(): Promise<DeviceKey>
  // The key a stored record names, or null when this device no longer has it.
  byId(id: number): Promise<CryptoKey | null>
  // Makes a new current key. The earlier ones stay until `drop`.
  rotate(): Promise<DeviceKey>
  drop(id: number): Promise<void>
  // Whether a copy of the app's data alone can't open what this key sealed.
  durable(): boolean
}

// Where the keys are kept: the P2P database's `meta` store. `name` is the database's own name,
// which is scoped to the instance and account.
export interface KeyVault {
  readonly name: string
  meta<T>(key: string): Promise<T | undefined>
  // Reads and writes `key` in one transaction: `fn` answers the new value, or null to keep it.
  // Answers what is stored afterwards.
  updateMeta(key: string, fn: (cur: unknown) => unknown): Promise<unknown>
}

export const DEVICE_KEYS_META = 'device_keys'
export const DEVICE_WRAP_KEY = 'device_wrap_key'

const AES = { name: 'AES-GCM', length: 256 } as const
const USES: KeyUsage[] = ['encrypt', 'decrypt']

interface Kept<K> {
  v: 1
  // Null when the stored current key can't be read.
  current: number | null
  keys: { id: number; key: K }[]
}

// The stored entries as they are, readable or not, so a write never loses one: empty when the
// stored value is no key list at all.
const entries = (value: unknown): unknown[] => {
  if (typeof value !== 'object' || value === null) return []
  const { v, keys } = value as Partial<Kept<unknown>>
  return v === 1 && Array.isArray(keys) ? keys : []
}

const idOf = (entry: unknown) => {
  const id = typeof entry === 'object' && entry !== null ? (entry as { id?: unknown }).id : null
  return typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : null
}

// The stored keys that read; the current one is null when it doesn't.
const kept = <K>(value: unknown, isKey: (k: unknown) => k is K): Kept<K> | null => {
  if (typeof value !== 'object' || value === null) return null
  const { v, current, keys } = value as Partial<Kept<unknown>>
  if (v !== 1 || !Array.isArray(keys)) return null
  const good = keys.filter(
    (k): k is { id: number; key: K } => idOf(k) !== null && isKey((k as { key?: unknown }).key)
  )
  const found = good.some(k => k.id === current) ? (current as number) : null
  return { v: 1, current: found, keys: good }
}

interface Codec<K> {
  isKey: (k: unknown) => k is K
  make: () => Promise<{ kept: K; key: CryptoKey }>
  open: (kept: K) => Promise<CryptoKey | null>
  // Removes what `make` kept outside the vault for a key that is not stored.
  discard: (kept: K) => void
  durable: () => boolean
}

const TRIES = 3

function deviceKeys<K>(vault: KeyVault, codec: Codec<K>): DeviceKeys {
  const opened = new Map<number, CryptoKey>()
  let work: Promise<unknown> = Promise.resolve()
  const serial = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = work.then(fn, fn)
    work = next.catch(() => {})
    return next
  }
  const load = async () => kept(await vault.meta(DEVICE_KEYS_META), codec.isKey)
  const open = async (state: Kept<K>, id: number) => {
    const have = opened.get(id)
    if (have) return have
    const row = state.keys.find(k => k.id === id)
    const key = row ? await codec.open(row.key) : null
    if (key) opened.set(id, key)
    return key
  }
  // Adds a new current key unless the stored current key is no longer `seen`: another tab or
  // instance changed it first, and its key is used instead.
  const add = async (seen: number | null): Promise<DeviceKey | Kept<K> | null> => {
    const made = await codec.make()
    let mine = null as number | null
    const stored = await vault.updateMeta(DEVICE_KEYS_META, raw => {
      if ((kept(raw, codec.isKey)?.current ?? null) !== seen) return null
      const keys = entries(raw)
      mine = Math.max(0, ...keys.map(k => idOf(k) ?? 0)) + 1
      return { v: 1, current: mine, keys: [...keys, { id: mine, key: made.kept }] }
    })
    if (mine !== null) {
      opened.set(mine, made.key)
      return { id: mine, key: made.key }
    }
    codec.discard(made.kept)
    return kept(stored, codec.isKey)
  }
  // The current key: made when there is none, and again when the stored one can't be opened.
  const current = () =>
    serial(async () => {
      let state = await load()
      for (let i = 0; i < TRIES; i++) {
        const at = state?.current ?? null
        const key = state && at !== null ? await open(state, at) : null
        if (key && at !== null) return { id: at, key }
        const added = await add(at)
        if (added && 'id' in added) return added
        state = added
      }
      throw new Error('the device key keeps changing')
    })
  return {
    current,
    get: async () => (await current()).key,
    byId: id =>
      serial(async () => {
        const state = await load()
        return state ? open(state, id) : null
      }),
    rotate: () =>
      serial(async () => {
        const added = await add((await load())?.current ?? null)
        if (added && 'id' in added) return added
        const at = added?.current ?? null
        const key = added && at !== null ? await open(added, at) : null
        if (!key || at === null) throw new Error('the device key keeps changing')
        return { id: at, key }
      }),
    drop: id =>
      serial(async () => {
        let gone = null as K | null
        await vault.updateMeta(DEVICE_KEYS_META, raw => {
          const state = kept(raw, codec.isKey)
          const row = state?.keys.find(k => k.id === id)
          if (!state || !row || state.current === id) return null
          gone = row.key
          return { ...(raw as object), keys: entries(raw).filter(k => idOf(k) !== id) }
        })
        opened.delete(id)
        if (gone !== null) codec.discard(gone)
      }),
    durable: codec.durable,
  }
}

const isCryptoKey = (k: unknown): k is CryptoKey =>
  typeof CryptoKey !== 'undefined' && k instanceof CryptoKey && !k.extractable

// A non-extractable key kept as a `CryptoKey`: script can't read it out and an exported file
// can't carry it, but whoever holds the unlocked browser profile can use it.
export const webDeviceKeys = (vault: KeyVault): DeviceKeys =>
  deviceKeys<CryptoKey>(vault, {
    isKey: isCryptoKey,
    make: async () => {
      const key = await crypto.subtle.generateKey(AES, false, USES)
      return { kept: key, key }
    },
    open: async key => key,
    discard: () => {},
    durable: () => false,
  })

const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes))

const unb64 = (text: string): Uint8Array | null => {
  try {
    return Uint8Array.from(atob(text), c => c.charCodeAt(0))
  } catch {
    return null
  }
}

const hex = (bytes: Uint8Array) => Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('')

const buffer = (bytes: Uint8Array) =>
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

const WRAP_AAD = new TextEncoder().encode('rchat-devkey1')

// The name of one wrapping key in the device store: each device key has its own, so making a key
// never writes over the one an earlier key needs.
export const wrapKeyName = (vault: KeyVault, tag: string) =>
  `${DEVICE_WRAP_KEY}:${vault.name}:${tag}`

const TAG = /^[0-9a-f]{16}$/

// The key wrapped by a key the shell keeps in its `DeviceStore`. `keychain` is whether that
// store is the OS keychain, so a copy of the app's data without it can't open the key.
export function shellDeviceKeys(
  vault: KeyVault,
  store: DeviceStore,
  keychain: boolean
): DeviceKeys {
  const importAes = (raw: Uint8Array) =>
    crypto.subtle.importKey('raw', buffer(raw), AES, false, USES)
  const parts = (text: string) => {
    const [tag, nonce, sealed] = text.split('.')
    return TAG.test(tag ?? '')
      ? { tag, nonce: unb64(nonce ?? ''), sealed: unb64(sealed ?? '') }
      : null
  }
  return deviceKeys<string>(vault, {
    isKey: (k): k is string => typeof k === 'string',
    make: async () => {
      const tag = hex(crypto.getRandomValues(new Uint8Array(8)))
      const name = wrapKeyName(vault, tag)
      const wrapRaw = crypto.getRandomValues(new Uint8Array(32))
      const text = b64(wrapRaw)
      if (!store.write(name, text) || store.read(name) !== text)
        throw new Error('the device key was not kept')
      const wrap = await importAes(wrapRaw)
      wrapRaw.fill(0)
      const raw = crypto.getRandomValues(new Uint8Array(32))
      const nonce = crypto.getRandomValues(new Uint8Array(12))
      const sealed = new Uint8Array(
        await crypto.subtle.encrypt(
          { name: 'AES-GCM', iv: buffer(nonce), additionalData: buffer(WRAP_AAD) },
          wrap,
          buffer(raw)
        )
      )
      const key = await importAes(raw)
      raw.fill(0)
      return { kept: `${tag}.${b64(nonce)}.${b64(sealed)}`, key }
    },
    open: async text => {
      const part = parts(text)
      const wrapRaw = part && unb64(store.read(wrapKeyName(vault, part.tag)) ?? '')
      if (!part || wrapRaw?.length !== 32 || part.nonce?.length !== 12 || !part.sealed) return null
      const wrap = await importAes(wrapRaw)
      wrapRaw.fill(0)
      try {
        const raw = new Uint8Array(
          await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv: buffer(part.nonce), additionalData: buffer(WRAP_AAD) },
            wrap,
            buffer(part.sealed)
          )
        )
        const key = await importAes(raw)
        raw.fill(0)
        return key
      } catch {
        return null
      }
    },
    discard: text => {
      const part = parts(text)
      if (part) store.write(wrapKeyName(vault, part.tag), null)
    },
    durable: () => keychain,
  })
}
