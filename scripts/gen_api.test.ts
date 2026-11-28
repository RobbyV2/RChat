import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

import { DOCUMENT, OUTPUT, generate, typeOf } from './gen_api'

describe('generated API types', () => {
  test('apps/web/app/lib/api/gen.ts is what the generator writes for assets/openapi.json', () => {
    const want = generate(JSON.parse(readFileSync(DOCUMENT, 'utf8')))
    const have = readFileSync(OUTPUT, 'utf8')
    if (have !== want)
      throw new Error('apps/web/app/lib/api/gen.ts is out of date: run `bun scripts/gen_api.ts`')
    expect(have).toBe(want)
  })

  test('schemas become TypeScript types', () => {
    expect(typeOf({ type: ['string', 'null'] })).toBe('string | null')
    expect(typeOf({ type: 'array', items: { $ref: '#/components/schemas/Role' } })).toBe('Role[]')
    expect(typeOf({ type: 'string', enum: ['a', 'b'] })).toBe("'a' | 'b'")
    expect(typeOf({ oneOf: [{ type: 'null' }, { $ref: '#/components/schemas/UserRef' }] })).toBe(
      'UserRef | null'
    )
    expect(typeOf({ type: 'object', additionalProperties: { type: 'integer' } })).toBe(
      'Record<string, number>'
    )
  })

  test('a field a client only receives is present, a null one too; a sent one stays optional', () => {
    const doc = {
      paths: {
        '/x': {
          post: {
            requestBody: {
              content: { 'application/json': { schema: { $ref: '#/components/schemas/Sent' } } },
            },
          },
        },
      },
      components: {
        schemas: {
          Got: {
            type: 'object',
            properties: { a: { type: ['string', 'null'] }, perms: { type: 'integer' } },
          },
          Sent: { type: 'object', properties: { a: { type: ['string', 'null'] } } },
        },
      },
    }
    const out = generate(doc)
    expect(out).toContain('export interface Got {\n  a: string | null\n  perms?: bigint\n}')
    expect(out).toContain('export interface Sent {\n  a?: string | null\n}')
  })
})
