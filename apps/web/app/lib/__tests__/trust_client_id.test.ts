import { describe, expect, test } from 'bun:test'
import { clientId, clientIdFor, clientIdKey, clientIdOk, newClientId } from '../trust/client_id'

const ORIGIN = 'https://chat.example.com'
const VECTOR = 'AAECAwQFBgcICQoLDA0ODw'

const memory = (initial: Record<string, string> = {}) => {
  const map = new Map(Object.entries(initial))
  return {
    map,
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
  }
}

const counting = () => {
  let n = 0
  return (bytes: Uint8Array) => {
    n += 1
    return bytes.fill(n)
  }
}

describe('clientIdOk', () => {
  test('is the 22 base64url characters of 16 bytes, as the server checks it', () => {
    expect(clientIdOk(VECTOR)).toBe(true)
    expect(clientIdOk('_wECAwQFBgcICQoLDA0ODw')).toBe(true)
    expect(clientIdOk('-_-_-_-_-_-_-_-_-_-_-Q')).toBe(true)
    for (const bad of [
      '',
      'AAECAwQFBgcICQoLDA0OD',
      'AAECAwQFBgcICQoLDA0ODwA',
      'AAECAwQFBgcICQoLDA0OD+',
      'AAECAwQFBgcICQoLDA0OD/',
      'AAECAwQFBgcICQoLDA0OD=',
      'AAECAwQFBgcICQoLDA0ODx',
      'AAECAwQFBgcICQoLDA0OD ',
      null,
      undefined,
      22,
    ])
      expect(clientIdOk(bad)).toBe(false)
  })
})

describe('newClientId', () => {
  test('encodes 16 random bytes', () => {
    expect(newClientId(bytes => bytes.map((_, i) => i))).toBe(VECTOR)
    expect(newClientId(bytes => bytes.fill(255))).toBe('_____________________w')
    const id = newClientId()
    expect(clientIdOk(id)).toBe(true)
    expect(newClientId() === id).toBe(false)
  })
})

describe('clientId', () => {
  test('is made once per origin and kept across reloads', () => {
    const storage = memory()
    const random = counting()
    const first = clientId(storage, ORIGIN, random)
    expect(clientIdOk(first)).toBe(true)
    expect(storage.map.get('rchat_trust_client@https://chat.example.com')).toBe(
      JSON.stringify({ v: 1, id: first })
    )
    expect(clientId(storage, ORIGIN, random)).toBe(first)
    expect(clientId(memory(Object.fromEntries(storage.map)), ORIGIN, random)).toBe(first)
  })

  test('each instance origin has its own', () => {
    const storage = memory()
    const random = counting()
    const a = clientId(storage, ORIGIN, random)
    const b = clientId(storage, 'https://other.example.org', random)
    expect(a === b).toBe(false)
    expect(clientId(storage, ORIGIN, random)).toBe(a)
    expect([...storage.map.keys()].sort()).toEqual([
      clientIdKey(ORIGIN),
      clientIdKey('https://other.example.org'),
    ])
  })

  test('a bad stored value is replaced', () => {
    for (const stored of [
      'not json',
      '{}',
      'null',
      JSON.stringify({ v: 2, id: VECTOR }),
      JSON.stringify({ v: 1, id: 'short' }),
      JSON.stringify({ v: 1 }),
      JSON.stringify(VECTOR),
    ]) {
      const storage = memory({ [clientIdKey(ORIGIN)]: stored })
      const id = clientId(storage, ORIGIN, counting())
      expect(clientIdOk(id)).toBe(true)
      expect(id === VECTOR).toBe(false)
      expect(storage.map.get(clientIdKey(ORIGIN))).toBe(JSON.stringify({ v: 1, id }))
    }
  })

  test('storage that throws still gives an id for this run', () => {
    const broken = {
      get: () => {
        throw new Error('denied')
      },
      set: () => {
        throw new Error('denied')
      },
    }
    expect(clientIdOk(clientId(broken, ORIGIN, counting()))).toBe(true)
  })
})

describe('clientIdFor', () => {
  test('goes to the instance it was made for and never to another origin', () => {
    expect(clientIdFor('https://chat.example.com/api/v1/pow/challenge', ORIGIN, VECTOR)).toBe(
      VECTOR
    )
    expect(clientIdFor('/api/v1/servers/lobby', ORIGIN, VECTOR)).toBe(VECTOR)
    for (const url of [
      'https://other.example.org/api/v1/pow/challenge',
      'http://chat.example.com/api/v1/me',
      'https://chat.example.com:8443/api/v1/me',
      'https://chat.example.com.evil.test/api/v1/me',
      '//evil.test/api/v1/me',
      'https://',
    ])
      expect(clientIdFor(url, ORIGIN, VECTOR)).toBeNull()
  })
})
