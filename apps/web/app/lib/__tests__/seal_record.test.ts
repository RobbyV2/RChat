import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import {
  DEVICE_RECORD,
  SERVER_RECORD,
  dekAad,
  deviceAad,
  openDevice,
  recordHeader,
  rowAad,
  sealDevice,
} from '../seal_record'

interface Vectors {
  v: number
  aad: { kind: 'row' | 'dek' | 'dev'; parts: string[]; hex: string }[]
  records: {
    name: string
    version: number
    key_id: number
    key: string
    nonce: string
    aad: string
    plain: string
    record: string
  }[]
  malformed: string[]
}

const vectors = JSON.parse(
  readFileSync(new URL('../../../../../assets/seal_vectors.json', import.meta.url), 'utf8')
) as Vectors

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')
const bytes = (text: string) => new Uint8Array(Buffer.from(text, 'hex'))
const aesKey = (raw: Uint8Array) =>
  crypto.subtle.importKey('raw', raw.slice().buffer, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ])

describe('assets/seal_vectors.json', () => {
  test('associated data is built as the instance builds it', () => {
    expect(vectors.v).toBe(1)
    expect(vectors.aad.length).toBeGreaterThan(0)
    for (const { kind, parts, hex: want } of vectors.aad) {
      const [a, b, c, d] = parts
      const built =
        kind === 'row'
          ? rowAad(a, b, c, Number(d))
          : kind === 'dek'
            ? dekAad(a, Number(b), c)
            : deviceAad(a, b, c)
      expect(hex(built)).toBe(want)
    }
  })

  test('every record names its version and key', () => {
    for (const record of vectors.records) {
      const head = recordHeader(bytes(record.record))
      expect(head).toEqual({
        version: record.version,
        keyId: record.key_id,
        nonceLen: record.version === SERVER_RECORD ? 24 : 12,
      })
    }
    for (const bad of vectors.malformed) expect(recordHeader(bytes(bad))).toBeNull()
  })

  test('device records open and are sealed to the same bytes', async () => {
    const device = vectors.records.filter(r => r.version === DEVICE_RECORD)
    expect(device.length).toBeGreaterThan(0)
    for (const record of device) {
      const key = await aesKey(bytes(record.key))
      const opened = await openDevice(key, bytes(record.aad), bytes(record.record))
      expect(opened && hex(opened)).toBe(record.plain)
      const sealed = await sealDevice(
        key,
        record.key_id,
        bytes(record.aad),
        bytes(record.plain),
        bytes(record.nonce)
      )
      expect(hex(sealed)).toBe(record.record)
    }
  })

  test('an instance record is not a device record', async () => {
    const server = vectors.records.find(r => r.version === SERVER_RECORD)!
    const key = await aesKey(bytes(server.key))
    expect(await openDevice(key, bytes(server.aad), bytes(server.record))).toBeNull()
  })
})

describe('device records', () => {
  const text = new TextEncoder()

  test('open only under their own store, key, room and device key', async () => {
    const key = await aesKey(new Uint8Array(32).fill(1))
    const aad = deviceAad('events', '41', 'room-1')
    const record = await sealDevice(key, 7, aad, text.encode('hello'))
    expect(record.length).toBe(5 + 34)
    expect(recordHeader(record)).toEqual({ version: DEVICE_RECORD, keyId: 7, nonceLen: 12 })
    expect(new TextDecoder().decode((await openDevice(key, aad, record))!)).toBe('hello')
    for (const other of [
      deviceAad('outbox', '41', 'room-1'),
      deviceAad('events', '42', 'room-1'),
      deviceAad('events', '41', 'room-2'),
    ])
      expect(await openDevice(key, other, record)).toBeNull()
    expect(await openDevice(await aesKey(new Uint8Array(32).fill(2)), aad, record)).toBeNull()
    expect(await openDevice(key, aad, record.subarray(0, record.length - 1))).toBeNull()
    const flipped = record.slice()
    flipped[flipped.length - 1] ^= 1
    expect(await openDevice(key, aad, flipped)).toBeNull()
    expect(
      await openDevice(key, aad, text.encode('plain text that is long enough to parse'))
    ).toBeNull()
  })

  test('take a fresh nonce each time and open from a view into a larger buffer', async () => {
    const key = await aesKey(new Uint8Array(32).fill(3))
    const aad = deviceAad('events', 'k', '')
    const a = await sealDevice(key, 1, aad, text.encode('same'))
    const b = await sealDevice(key, 1, aad, text.encode('same'))
    expect(hex(a)).not.toBe(hex(b))
    const padded = new Uint8Array(a.length + 8)
    padded.set(a, 4)
    const opened = await openDevice(key, aad, padded.subarray(4, 4 + a.length))
    expect(opened && new TextDecoder().decode(opened)).toBe('same')
    const refused = await sealDevice(key, 1, aad, text.encode('x'), new Uint8Array(24)).then(
      () => false,
      () => true
    )
    expect(refused).toBe(true)
  })
})
