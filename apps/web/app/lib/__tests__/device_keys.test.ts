import 'fake-indexeddb/auto'
import { afterEach, describe, expect, test } from 'bun:test'
import { P2pStore } from '../p2p/db'
import { deviceKeys, setDeviceKeys, setDeviceStore } from '../platform'
import {
  DEVICE_KEYS_META,
  DEVICE_WRAP_KEY,
  shellDeviceKeys,
  webDeviceKeys,
  wrapKeyName,
  type DeviceKeys,
  type KeyVault,
} from '../platform/device_keys'
import type { DeviceStore } from '../platform/device_store'
import { webDeviceStore } from '../platform/web_device_store'
import { deviceAad, openDevice, sealDevice } from '../seal_record'

let vaults = 0

const vault = () => {
  const kept = new Map<string, unknown>()
  const store: KeyVault & { kept: Map<string, unknown> } = {
    name: `rchat-p2p:test:${(vaults += 1)}`,
    kept,
    meta: async <T>(key: string) => kept.get(key) as T | undefined,
    updateMeta: async (key, fn) => {
      await Promise.resolve()
      const next = fn(kept.get(key))
      if (next !== null) kept.set(key, next)
      return next ?? kept.get(key)
    },
  }
  return store
}

const wrapKeys = (chain: { kept: Map<string, string> }, v: KeyVault) =>
  [...chain.kept.keys()].filter(k => k.startsWith(`${DEVICE_WRAP_KEY}:${v.name}:`))

const keychain = () => {
  const kept = new Map<string, string>()
  const store: DeviceStore & { kept: Map<string, string> } = {
    kept,
    read: key => kept.get(key) ?? null,
    write: (key, value) => {
      if (value === null) kept.delete(key)
      else kept.set(key, value)
      return true
    },
  }
  return store
}

const text = new TextEncoder()
const fails = (p: Promise<unknown>) =>
  p.then(
    () => false,
    () => true
  )
const aad = deviceAad('events', '1', 'room')

const roundTrip = async (seal: DeviceKeys, open: DeviceKeys) => {
  const { id, key } = await seal.current()
  const record = await sealDevice(key, id, aad, text.encode('hello'))
  const with_ = await open.byId(id)
  const plain = with_ && (await openDevice(with_, aad, record))
  return plain ? new TextDecoder().decode(plain) : null
}

afterEach(() => {
  setDeviceKeys()
  setDeviceStore(webDeviceStore)
})

describe('the web device key', () => {
  test('is made on first need, kept non-extractable, and found again', async () => {
    const v = vault()
    const keys = webDeviceKeys(v)
    expect(v.kept.size).toBe(0)
    const first = await keys.current()
    expect(first.id).toBe(1)
    expect(first.key.extractable).toBe(false)
    expect(first.key.algorithm).toMatchObject({ name: 'AES-GCM', length: 256 })
    expect(await keys.get()).toBe(first.key)
    expect(v.kept.has(DEVICE_KEYS_META)).toBe(true)
    expect(await fails(crypto.subtle.exportKey('raw', first.key))).toBe(true)
    expect(await roundTrip(keys, webDeviceKeys(v))).toBe('hello')
    expect(keys.durable()).toBe(false)
  })

  test('makes one key when asked many times at once', async () => {
    const keys = webDeviceKeys(vault())
    const all = await Promise.all([keys.current(), keys.current(), keys.get(), keys.current()])
    expect(new Set(all.map(k => ('id' in k ? k.key : k))).size).toBe(1)
  })

  test('makes one key when two instances ask at once over one vault', async () => {
    const v = vault()
    const [a, b] = [webDeviceKeys(v), webDeviceKeys(v)]
    const [one, two] = await Promise.all([a.current(), b.current()])
    expect([one.id, two.id]).toEqual([1, 1])
    expect(one.key).toBe(two.key)
    expect(await roundTrip(a, webDeviceKeys(v))).toBe('hello')
    expect(await roundTrip(b, webDeviceKeys(v))).toBe('hello')
    expect((v.kept.get(DEVICE_KEYS_META) as { keys: unknown[] }).keys).toHaveLength(1)
  })

  test('keeps the older keys when the current entry is unreadable, and never reuses its id', async () => {
    const v = vault()
    const keys = webDeviceKeys(v)
    const old = await keys.current()
    const record = await sealDevice(old.key, old.id, aad, text.encode('kept'))
    const state = v.kept.get(DEVICE_KEYS_META) as { current: number; keys: unknown[] }
    v.kept.set(DEVICE_KEYS_META, {
      ...state,
      current: 2,
      keys: [...state.keys, { id: 2, key: 'x' }],
    })
    const fresh = webDeviceKeys(v)
    expect((await fresh.current()).id).toBe(3)
    const kept = await fresh.byId(1)
    expect(kept && new TextDecoder().decode((await openDevice(kept, aad, record))!)).toBe('kept')
  })

  test('rotates to a new key and keeps the earlier one until it is dropped', async () => {
    const v = vault()
    const keys = webDeviceKeys(v)
    const old = await keys.current()
    const record = await sealDevice(old.key, old.id, aad, text.encode('before'))
    const next = await keys.rotate()
    expect(next.id).toBe(2)
    expect((await keys.current()).id).toBe(2)
    expect(await openDevice(next.key, aad, record)).toBeNull()
    const kept = await webDeviceKeys(v).byId(1)
    expect(kept && (await openDevice(kept, aad, record))).not.toBeNull()
    await keys.drop(2)
    expect((await keys.current()).id).toBe(2)
    await keys.drop(1)
    expect(await keys.byId(1)).toBeNull()
    expect(await webDeviceKeys(v).byId(1)).toBeNull()
    expect(await keys.byId(9)).toBeNull()
  })

  test('starts over from stored state it cannot read', async () => {
    for (const bad of ['junk', { v: 2, current: 1, keys: [] }, { v: 1, current: 1, keys: [{}] }]) {
      const v = vault()
      v.kept.set(DEVICE_KEYS_META, bad)
      const keys = webDeviceKeys(v)
      expect(await keys.byId(1)).toBeNull()
      expect((await keys.current()).id).toBe(1)
    }
  })
})

describe('the shell device key', () => {
  test('is kept wrapped, and opens only with the key in the device store', async () => {
    const [v, chain] = [vault(), keychain()]
    const keys = shellDeviceKeys(v, chain, true)
    const first = await keys.current()
    expect(first.key.extractable).toBe(false)
    expect(keys.durable()).toBe(true)
    const [wrapName] = wrapKeys(chain, v)
    expect(wrapKeys(chain, v)).toHaveLength(1)
    const stored = JSON.stringify(v.kept.get(DEVICE_KEYS_META))
    expect(stored).not.toContain(chain.kept.get(wrapName)!)
    expect(typeof (v.kept.get(DEVICE_KEYS_META) as { keys: { key: unknown }[] }).keys[0].key).toBe(
      'string'
    )
    expect(await roundTrip(keys, shellDeviceKeys(v, chain, true))).toBe('hello')

    const copied = shellDeviceKeys(v, keychain(), true)
    expect(await copied.byId(first.id)).toBeNull()
    const again = await copied.current()
    expect(again.id).toBe(2)
    expect(await roundTrip(keys, copied)).toBeNull()
  })

  test('never writes over the wrapping key of a stored key when a read fails once', async () => {
    const [v, chain] = [vault(), keychain()]
    const keys = shellDeviceKeys(v, chain, true)
    const first = await keys.current()
    const record = await sealDevice(first.key, first.id, aad, text.encode('before'))
    const [wrapName] = wrapKeys(chain, v)
    const wrapValue = chain.kept.get(wrapName)
    let failures = 1
    const flaky: DeviceStore = {
      read: key => (failures-- > 0 ? null : chain.read(key)),
      write: (key, value) => chain.write(key, value),
    }
    await shellDeviceKeys(v, flaky, true).current()
    expect(chain.kept.get(wrapName)).toBe(wrapValue)
    const later = await shellDeviceKeys(v, chain, true).byId(first.id)
    expect(later && new TextDecoder().decode((await openDevice(later, aad, record))!)).toBe(
      'before'
    )
  })

  test('makes one key for two instances over one P2P database, and leaves no stray wrapping key', async () => {
    const store = await P2pStore.create(`test-device-keys-${Math.random()}`)
    const chain = keychain()
    const [a, b] = [shellDeviceKeys(store, chain, true), shellDeviceKeys(store, chain, true)]
    const [one, two] = await Promise.all([a.current(), b.current()])
    expect([one.id, two.id]).toEqual([1, 1])
    expect(await roundTrip(a, shellDeviceKeys(store, chain, true))).toBe('hello')
    expect(await roundTrip(b, shellDeviceKeys(store, chain, true))).toBe('hello')
    expect(wrapKeys(chain, store)).toHaveLength(1)
    const next = await a.rotate()
    expect(wrapKeys(chain, store)).toHaveLength(2)
    await a.drop(1)
    expect(wrapKeys(chain, store)).toHaveLength(1)
    expect(await a.byId(1)).toBeNull()
    expect((await b.current()).id).toBe(next.id)
    store.close()
  })

  test('keeps each wrapping key under the database it belongs to', () => {
    const v = vault()
    expect(wrapKeyName(v, 'aa')).toBe(`${DEVICE_WRAP_KEY}:${v.name}:aa`)
  })

  test('says it is not durable when the device store is no keychain', async () => {
    expect(shellDeviceKeys(vault(), keychain(), false).durable()).toBe(false)
  })

  test('fails loudly when the device store keeps nothing', async () => {
    const refusing: DeviceStore = { read: () => null, write: () => false }
    expect(await fails(shellDeviceKeys(vault(), refusing, true).current())).toBe(true)
  })

  test('ignores a wrapped key that was tampered with', async () => {
    const [v, chain] = [vault(), keychain()]
    await shellDeviceKeys(v, chain, true).current()
    const state = v.kept.get(DEVICE_KEYS_META) as { keys: { key: string }[] }
    state.keys[0].key = state.keys[0].key.replace(/.$/, c => (c === 'A' ? 'B' : 'A'))
    expect(await shellDeviceKeys(v, chain, true).byId(1)).toBeNull()
    state.keys[0].key = 'not a wrapped key'
    expect(await shellDeviceKeys(v, chain, true).byId(1)).toBeNull()
  })
})

describe('the platform device keys', () => {
  test('are the web ones outside a shell, and a registered factory wins', async () => {
    const v = vault()
    const keys = deviceKeys(v)
    expect(keys.durable()).toBe(false)
    expect((await keys.current()).key.extractable).toBe(false)
    expect(deviceKeys(v)).toBe(keys)
    expect(deviceKeys(vault())).not.toBe(keys)
    const fake = webDeviceKeys(vault())
    setDeviceKeys(() => fake)
    expect(deviceKeys(v)).toBe(fake)
  })
})
