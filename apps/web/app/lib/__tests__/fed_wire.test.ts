import { describe, expect, test } from 'bun:test'
import { create, fromBinary, toBinary } from '@bufbuild/protobuf'
import { BinaryWriter, WireType } from '@bufbuild/protobuf/wire'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { AppsService } from '../fed/gen/rchat/fed/v1/apps_pb'
import { CallHeadSchema, RefusalReason, RefusalSchema } from '../fed/gen/rchat/fed/v1/call_pb'
import {
  HelloAnswerSchema,
  HelloRequestSchema,
  HelloResponseSchema,
  HelloSchema,
  InstanceService,
  Policy,
} from '../fed/gen/rchat/fed/v1/instance_pb'
import {
  DeliverRequestSchema,
  LetterCoreSchema,
  LetterEntrySchema,
  LetterKind,
  LettersService,
  P2pEntrySchema,
  Via,
  type LetterCore,
} from '../fed/gen/rchat/fed/v1/letters_pb'

const vectors = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../crates/fed/tests/vectors/fed.json', import.meta.url)),
    'utf8'
  )
)
const bytes = (hex: string) => new Uint8Array(Buffer.from(hex, 'hex'))
const hex = (b: Uint8Array) => Buffer.from(b).toString('hex')

const core = (): LetterCore =>
  create(LetterCoreSchema, {
    v: 1,
    kind: LetterKind.MESSAGE,
    author: 'alice@a.example',
    uid: 'u1',
    to: [create(LetterEntrySchema, { who: { case: 'acct', value: 'bob@b.example' } })],
    subject: 'Q3 plan',
    body: 'Hello',
    ts: BigInt(1_800_000_000_000),
    salt: new Uint8Array(16).fill(1),
  })

const withNewFields = (base: Uint8Array) => {
  const w = new BinaryWriter()
  w.tag(40, WireType.LengthDelimited).string('added later')
  w.tag(41, WireType.LengthDelimited).bytes(new Uint8Array([8, 1]))
  return new Uint8Array([...base, ...w.finish()])
}

describe('the generated types on the shared vectors', () => {
  test('the letter core is the vector, and reads back', () => {
    expect(hex(toBinary(LetterCoreSchema, core()))).toBe(vectors.letter.core)
    const read = fromBinary(LetterCoreSchema, bytes(vectors.letter.core))
    expect(read.subject).toBe('Q3 plan')
    expect(read.to[0].who).toEqual({ case: 'acct', value: 'bob@b.example' })
  })

  test('the call head reads as signed and writes back the same bytes', () => {
    const head = fromBinary(CallHeadSchema, bytes(vectors.call.head))
    expect(head.iss).toBe('https://a.example')
    expect(head.aud).toBe('https://b.example')
    expect(head.method).toBe('/rchat.fed.v1.LettersService/Deliver')
    expect(head.iat).toBe(BigInt(vectors.call.now))
    expect(head.exp).toBe(BigInt(vectors.call.now + 60))
    expect(head.kid).toBe(vectors.key.kid)
    expect(head.bodyLen).toBe(BigInt(vectors.call.body.length / 2))
    expect(hex(toBinary(CallHeadSchema, head))).toBe(vectors.call.head)
    const body = fromBinary(DeliverRequestSchema, bytes(vectors.call.body))
    expect(hex(body.objects[0].core)).toBe(vectors.letter.core)
    expect(body.objects[0].id).toBe(vectors.letter.id)
    expect(body.rcpt[0]).toMatchObject({ to: 'bob', via: Via.TO, object: vectors.letter.id })
  })

  test('the Hello request and answer read with their endorsement, proof and policy', () => {
    const request = fromBinary(HelloRequestSchema, bytes(vectors.hello.request))
    expect(request.caller?.callKids).toEqual([vectors.hello.rotated_kid])
    expect(request.caller?.endorsements[0]).toMatchObject({
      newKid: vectors.hello.rotated_kid,
      byKid: vectors.key.kid,
    })
    expect(request.caller?.endorsements[0].sig.length).toBe(64)
    expect(request.caller?.budgets).toMatchObject([{ service: 'letters', callsPerMinute: 600 }])
    expect(hex(toBinary(HelloRequestSchema, request))).toBe(vectors.hello.request)
    const response = fromBinary(HelloResponseSchema, bytes(vectors.hello.response))
    expect(response.proofKid).toBe(vectors.key.kid)
    expect(response.proof.length).toBe(64)
    const answer = fromBinary(HelloAnswerSchema, response.answer)
    expect(answer.now).toBe(BigInt(1_800_000_000))
    expect(answer.policy).toMatchObject([{ name: 'letters', policy: Policy.ACCEPTED }])
  })

  test('the services and their methods, with the apps slot reserved and empty', () => {
    expect(Object.keys(InstanceService.method)).toEqual(['hello'])
    expect(Object.keys(LettersService.method)).toEqual([
      'deliver',
      'putObjects',
      'pull',
      'pullFile',
      'getKey',
    ])
    expect(AppsService.typeName).toBe('rchat.fed.v1.AppsService')
    expect(AppsService.methods).toEqual([])
  })

  test('a refusal carries its reason and the work of a stamp', () => {
    const refusal = create(RefusalSchema, {
      reason: RefusalReason.STAMP_NEEDED,
      stampWork: BigInt(2_000_000),
    })
    const read = fromBinary(RefusalSchema, toBinary(RefusalSchema, refusal))
    expect(read.reason).toBe(7)
    expect(RefusalReason[read.reason]).toBe('STAMP_NEEDED')
    expect(read.stampWork).toBe(BigInt(2_000_000))
  })
})

describe('schema evolution', () => {
  test('an older reader decodes a newer message and keeps every known field', () => {
    const got = fromBinary(LetterCoreSchema, withNewFields(toBinary(LetterCoreSchema, core())))
    expect(got.subject).toBe('Q3 plan')
    expect(got.to[0].who).toEqual({ case: 'acct', value: 'bob@b.example' })
  })

  test('unknown fields are kept on a re-encode, so signed bytes survive a round trip here', () => {
    const newer = withNewFields(toBinary(LetterCoreSchema, core()))
    const read = fromBinary(LetterCoreSchema, newer)
    expect(hex(toBinary(LetterCoreSchema, read))).toBe(hex(newer))
    const stripped = toBinary(LetterCoreSchema, read, { writeUnknownFields: false })
    expect(hex(stripped)).toBe(vectors.letter.core)
  })

  test('an unknown enum value is read as its number', () => {
    const w = new BinaryWriter()
    w.tag(2, WireType.Varint).int32(9)
    const got = fromBinary(LetterCoreSchema, w.finish())
    expect(got.kind as number).toBe(9)
    expect(Object.values(LetterKind).includes(got.kind)).toBe(false)
  })

  test('a new oneof member reads as an entry of no known kind', () => {
    const w = new BinaryWriter()
    w.tag(3, WireType.LengthDelimited).string('future-kind-of-recipient')
    expect(fromBinary(LetterEntrySchema, w.finish()).who.case).toBeUndefined()
  })

  test('a known field with the wrong wire type fails to decode', () => {
    const w = new BinaryWriter()
    w.tag(9, WireType.Varint).int32(5)
    expect(() => fromBinary(LetterCoreSchema, w.finish())).toThrow()
  })

  test('invalid UTF-8 in a string field is malformed', () => {
    expect(() => fromBinary(LetterCoreSchema, new Uint8Array([0x52, 0x02, 0xff, 0xfe]))).toThrow()
  })

  test('a removed field from an older writer is an unknown field, ignored', () => {
    const w = new BinaryWriter()
    w.tag(1, WireType.LengthDelimited).string('blind123')
    w.tag(2, WireType.LengthDelimited).string('Dana')
    const got = fromBinary(P2pEntrySchema, w.finish())
    expect(got.blind).toBe('blind123')
    expect(JSON.stringify(got)).not.toContain('Dana')
  })

  test('defaults are absent on the wire: an empty Hello is zero bytes', () => {
    expect(toBinary(HelloSchema, create(HelloSchema, {})).length).toBe(0)
  })
})
