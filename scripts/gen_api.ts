// Writes the client's API types from the server's OpenAPI document.
//   bun scripts/gen_api.ts
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { MASKS } from '../apps/web/app/lib/api/masks'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
export const DOCUMENT = join(root, 'assets', 'openapi.json')
export const OUTPUT = join(root, 'apps', 'web', 'app', 'lib', 'api', 'gen.ts')

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type Node = { [key: string]: Json }

const isNode = (x: Json | undefined): x is Node =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const nodes = (x: Json | undefined): Node[] => (Array.isArray(x) ? x.filter(isNode) : [])

const REF = '#/components/schemas/'

// The schemas that take client-only fields from `apps/web/app/lib/api/extend.ts`.
export const EXTENDED = ['ForwardRef', 'MemberLook', 'UserRef']

export const typeName = (schema: string) => schema.replace(/[^A-Za-z0-9_$]/g, '_')

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name))
const literal = (value: Json) => (typeof value === 'string' ? quote(value) : JSON.stringify(value))
const quote = (text: string) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const pad = (depth: number) => '  '.repeat(depth)

const union = (parts: string[]) => {
  const seen = [...new Set(parts)]
  if (seen.includes('unknown')) return 'unknown'
  const last = seen.filter(part => part === 'null')
  return [...seen.filter(part => part !== 'null'), ...last].join(' | ')
}

// A type that can stand before `[]` or inside `&` without changing its meaning.
const atom = (type: string) => (/[|&]| => /.test(stripNested(type)) ? `(${type})` : type)

// The text of a type with everything inside brackets removed.
const stripNested = (type: string) => {
  let depth = 0
  let out = ''
  for (const ch of type) {
    if ('{[(<'.includes(ch)) depth += 1
    else if ('}])>'.includes(ch)) depth -= 1
    else if (depth === 0) out += ch
  }
  return out
}

// Whether a schema admits null at its top.
const admitsNull = (schema: Node): boolean => {
  const named = schema.type
  if (named === 'null' || (Array.isArray(named) && named.includes('null'))) return true
  return [...nodes(schema.oneOf), ...nodes(schema.anyOf)].some(admitsNull)
}

// Set while a schema the client only receives is written: there a field that may be null is
// always present after decoding (a missing one reads as null), so it is not optional.
let received = false

const fields = (schema: Node, depth: number): string[] => {
  const props = isNode(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  return Object.keys(props).map(name => {
    const field = props[name]
    const node = isNode(field) ? field : {}
    const present = required.has(name) || (received && admitsNull(node))
    const type = typeOf(node, depth)
    const shown = MASKS.has(name) ? type.replace(/\bnumber\b/g, 'bigint') : type
    return `${pad(depth)}${key(name)}${present ? '' : '?'}: ${shown}`
  })
}

const objectType = (schema: Node, depth: number): string => {
  const lines = fields(schema, depth + 1)
  const extra = schema.additionalProperties
  const record =
    extra === true ? 'Record<string, unknown>' : isNode(extra) ? record_(extra, depth) : null
  if (!lines.length) return record ?? 'Record<string, unknown>'
  const body = `{\n${lines.join('\n')}\n${pad(depth)}}`
  return record ? `${body} & ${record}` : body
}

const record_ = (value: Node, depth: number) => `Record<string, ${typeOf(value, depth)}>`

const single = (schema: Node, type: string, depth: number): string => {
  if (Array.isArray(schema.enum)) return union(schema.enum.map(literal))
  switch (type) {
    case 'null':
      return 'null'
    case 'string':
      return 'string'
    case 'integer':
    case 'number':
      return 'number'
    case 'boolean':
      return 'boolean'
    case 'array': {
      const tuple = nodes(schema.prefixItems)
      if (tuple.length) return `[${tuple.map(item => typeOf(item, depth)).join(', ')}]`
      return `${atom(typeOf(isNode(schema.items) ? schema.items : {}, depth))}[]`
    }
    case 'object':
      return objectType(schema, depth)
    default:
      return 'unknown'
  }
}

// The schemas of the document being written, for `$ref`s an untagged union looks into.
let known: Node = {}

const resolved = (schema: Node): Node => {
  const to =
    typeof schema.$ref === 'string' && schema.$ref.startsWith(REF)
      ? known[schema.$ref.slice(REF.length)]
      : undefined
  return isNode(to) ? resolved(to) : schema
}

// The field names an object schema has, through its `allOf` parts.
const keysOf = (schema: Node): string[] => {
  const at = resolved(schema)
  const own = isNode(at.properties) ? Object.keys(at.properties) : []
  return [...own, ...nodes(at.allOf).flatMap(keysOf)]
}

const tagged = (schema: Node) => keysOf(schema).includes('type')

// The options of an untagged union of objects, each with the others' fields as `never`, so a
// field read on the union narrows it.
const exclusive = (options: Node[], depth: number): string[] => {
  const objects = options.filter(o => keysOf(o).length > 0)
  if (objects.length < 2 || objects.some(tagged)) return options.map(o => typeOf(o, depth))
  const all = [...new Set(objects.flatMap(keysOf))].sort()
  return options.map(option => {
    const type = typeOf(option, depth)
    const mine = new Set(keysOf(option))
    if (!mine.size) return type
    const absent = all.filter(k => !mine.has(k))
    return absent.length
      ? `${atom(type)} & { ${absent.map(k => `${key(k)}?: never`).join('; ')} }`
      : type
  })
}

// Every keyword of a schema applies at once, so its parts are intersected.
export const typeOf = (schema: Node, depth = 0): string => {
  if (typeof schema.$ref === 'string') {
    return schema.$ref.startsWith(REF) ? typeName(schema.$ref.slice(REF.length)) : 'unknown'
  }
  if ('const' in schema) return literal(schema.const)
  const named = schema.type
  const types = (Array.isArray(named) ? named : [named]).filter(t => typeof t === 'string')
  const nullable = types.includes('null')
  const own = types.filter(t => t !== 'null')
  const shaped = isNode(schema.properties) || schema.additionalProperties !== undefined
  const pieces = nodes(schema.allOf).map(part => typeOf(part, depth))
  for (const word of ['oneOf', 'anyOf']) {
    const options = nodes(schema[word])
    if (options.length) pieces.push(union(exclusive(options, depth)))
  }
  if (own.length) {
    const bare = own.length === 1 && own[0] === 'object' && !shaped && pieces.length > 0
    if (!bare) pieces.push(union(own.map(t => single(schema, t, depth))))
  } else if (Array.isArray(schema.enum)) pieces.push(union(schema.enum.map(literal)))
  else if (shaped) pieces.push(objectType(schema, depth))
  if (!pieces.length) return nullable ? 'null' : 'unknown'
  const core = pieces.length === 1 ? pieces[0] : pieces.map(atom).join(' & ')
  return nullable ? union([core, 'null']) : core
}

// The decoder of a schema, as an expression over the combinators of `lib/schema.ts`.
const decoderOf = (schema: Node, name = ''): string => {
  if (typeof schema.$ref === 'string') {
    return schema.$ref.startsWith(REF)
      ? `ref(() => decode.${typeName(schema.$ref.slice(REF.length))})`
      : 'anything'
  }
  if ('const' in schema) return `lit(${literal(schema.const)})`
  const named = schema.type
  const types = (Array.isArray(named) ? named : [named]).filter(t => typeof t === 'string')
  const own = types.filter(t => t !== 'null')
  const nullOption = [...nodes(schema.oneOf), ...nodes(schema.anyOf)].some(o => o.type === 'null')
  const nullable = types.includes('null') || nullOption
  const core = coreDecoder(schema, own, name)
  return nullable ? `nullable(${core})` : core
}

const tagOf = (schema: Node): string | undefined => {
  const at = resolved(schema)
  const own = isNode(at.properties) && isNode(at.properties.type) ? at.properties.type : undefined
  if (own && Array.isArray(own.enum) && own.enum.length === 1 && typeof own.enum[0] === 'string')
    return own.enum[0]
  for (const part of nodes(at.allOf)) {
    const t = tagOf(part)
    if (t !== undefined) return t
  }
  return undefined
}

const coreDecoder = (schema: Node, own: string[], name: string): string => {
  const parts: string[] = nodes(schema.allOf).map(p => decoderOf(p))
  const options = [...nodes(schema.oneOf), ...nodes(schema.anyOf)].filter(o => o.type !== 'null')
  if (options.length) {
    const tags = options.map(tagOf)
    if (options.length > 1 && tags.every(t => t !== undefined))
      parts.push(
        `tagged('type', {\n${options.map((o, i) => `    ${key(tags[i] as string)}: ${decoderOf(o)},`).join('\n')}\n  })`
      )
    else
      parts.push(
        options.length === 1
          ? decoderOf(options[0])
          : `union(${options.map(o => decoderOf(o)).join(', ')})`
      )
  }
  const shaped = isNode(schema.properties) || schema.additionalProperties !== undefined
  if (own.length === 1 || (!own.length && (shaped || Array.isArray(schema.enum)))) {
    const kind = own[0] ?? (shaped ? 'object' : 'string')
    if (!(kind === 'object' && !shaped && parts.length)) parts.push(single_(schema, kind, name))
  } else if (own.length > 1) parts.push('anything')
  if (!parts.length) return 'anything'
  return parts.length === 1 ? parts[0] : `merged(${parts.join(', ')})`
}

const single_ = (schema: Node, kind: string, name: string): string => {
  if (Array.isArray(schema.enum)) {
    const values = schema.enum.filter(v => typeof v === 'string')
    return values.length === schema.enum.length
      ? `choice(${values.map(literal).join(', ')})`
      : 'anything'
  }
  switch (kind) {
    case 'string':
      return 'str()'
    case 'integer':
      return MASKS.has(name) ? 'mask' : 'int()'
    case 'number':
      return 'num()'
    case 'boolean':
      return 'bool'
    case 'array': {
      if (nodes(schema.prefixItems).length) return 'anything'
      return `arr(${decoderOf(isNode(schema.items) ? schema.items : {})})`
    }
    case 'object':
      return objectDecoder(schema)
    default:
      return 'anything'
  }
}

const objectDecoder = (schema: Node): string => {
  const props = isNode(schema.properties) ? schema.properties : {}
  const required = new Set(Array.isArray(schema.required) ? schema.required : [])
  const extra = schema.additionalProperties
  const names = Object.keys(props)
  if (!names.length) {
    if (isNode(extra)) return `record(${decoderOf(extra)})`
    return 'jsonObject'
  }
  const fields = names.map(n => {
    const node = isNode(props[n]) ? (props[n] as Node) : {}
    const inner = decoderOf(node, n)
    const field = required.has(n)
      ? inner
      : received && admitsNull(node)
        ? `orNull(${inner.startsWith('nullable(') ? inner.slice(9, -1) : inner})`
        : `opt(${inner})`
    return `${key(n)}: ${field}`
  })
  return `obj({ ${fields.join(', ')} })`
}

const plainObject = (schema: Node) =>
  schema.type === 'object' &&
  isNode(schema.properties) &&
  schema.additionalProperties === undefined &&
  !schema.allOf &&
  !schema.oneOf &&
  !schema.anyOf &&
  !schema.enum

const declaration = (name: string, schema: Node, sent: boolean): string => {
  const id = typeName(name)
  received = !sent
  try {
    const extra = EXTENDED.includes(id) ? ` extends ${id}Extra` : ''
    if (plainObject(schema))
      return `export interface ${id}${extra} {\n${fields(schema, 1).join('\n')}\n}`
    if (extra) throw new Error(`${name} is not a plain object, so it can not take client fields`)
    return `export type ${id} = ${typeOf(schema)}`
  } finally {
    received = false
  }
}

const refsIn = (x: Json, into: Set<string>) => {
  if (Array.isArray(x)) for (const item of x) refsIn(item, into)
  else if (isNode(x))
    for (const [word, value] of Object.entries(x)) {
      if (word === '$ref' && typeof value === 'string' && value.startsWith(REF))
        into.add(value.slice(REF.length))
      else refsIn(value, into)
    }
}

// The schemas the client writes: everything a request body or parameter reaches.
export const sentSchemas = (doc: Json, schemas: Node): Set<string> => {
  const sent = new Set<string>()
  const paths = isNode(doc) && isNode(doc.paths) ? doc.paths : {}
  for (const item of Object.values(paths)) {
    if (!isNode(item)) continue
    refsIn(item.parameters ?? null, sent)
    for (const operation of Object.values(item)) {
      if (!isNode(operation)) continue
      refsIn(operation.requestBody ?? null, sent)
      refsIn(operation.parameters ?? null, sent)
    }
  }
  const queue = [...sent]
  for (let name = queue.pop(); name !== undefined; name = queue.pop()) {
    const inner = new Set<string>()
    refsIn(schemas[name] ?? null, inner)
    for (const next of inner)
      if (!sent.has(next)) {
        sent.add(next)
        queue.push(next)
      }
  }
  return sent
}

// The combinators the decoders may use, as `lib/schema.ts` names them.
const COMBINATORS = [
  'anything',
  'arr',
  'bool',
  'choice',
  'int',
  'jsonObject',
  'lit',
  'mask',
  'merged',
  'nullable',
  'num',
  'obj',
  'opt',
  'orNull',
  'record',
  'str',
  'tagged',
  'union',
]

const importsFor = (code: string) =>
  `import {\n${COMBINATORS.filter(c => new RegExp(`\\b${c}\\b`).test(code))
    .map(c => `  ${c},\n`)
    .join('')}  lazy as ref,\n  type Schema,\n} from '../schema'\n`

// Every schema's decoder: what a body or event of that shape reads as. A field the client only
// receives that may be null reads as null when it is left out; a value of a newer server (a kind
// this build has no name for) reads as \`unknown\` (see \`lib/schema.ts\`).
const DECODE_HEAD = `// The decoder of every schema, by name.
export const decode: { readonly [K in keyof Decoded]: Schema<Decoded[K]> } = {
`

const HEADER = `// Generated by scripts/gen_api.ts from assets/openapi.json. Do not edit: change the server's
// document and run \`bun scripts/gen_api.ts\`.
`

export const generate = (doc: Json): string => {
  const components = isNode(doc) && isNode(doc.components) ? doc.components : {}
  const schemas = isNode(components.schemas) ? components.schemas : {}
  known = schemas
  const names = Object.keys(schemas).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const seen = new Map<string, string>()
  for (const name of names) {
    const id = typeName(name)
    const other = seen.get(id)
    if (other !== undefined) throw new Error(`schemas ${other} and ${name} share the name ${id}`)
    seen.set(id, name)
  }
  const sent = sentSchemas(doc, schemas)
  const out = names.map(name => {
    const schema = schemas[name]
    return declaration(name, isNode(schema) ? schema : {}, sent.has(name))
  })
  const decoders = names.map(name => {
    const schema = schemas[name]
    received = !sent.has(name)
    try {
      const id = typeName(name)
      return `  ${id}: ref((): Schema<${id}> => ${decoderOf(isNode(schema) ? schema : {})} as Schema<${id}>),`
    } finally {
      received = false
    }
  })
  const extras = EXTENDED.map(id => `${id}Extra`).join(', ')
  return `${HEADER}\n${importsFor(decoders.join('\n'))}import type { ${extras} } from './extend'\n\n${out.join('\n\n')}\n\n// Every schema by name.\nexport interface Decoded {\n${names.map(n => `  ${typeName(n)}: ${typeName(n)}`).join('\n')}\n}\n\n${DECODE_HEAD}${decoders.join('\n')}\n}\n`
}

if (import.meta.main) {
  writeFileSync(OUTPUT, generate(JSON.parse(readFileSync(DOCUMENT, 'utf8')) as Json))
  console.log(`wrote ${OUTPUT}`)
}
