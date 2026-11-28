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
    if (options.length) pieces.push(union(options.map(option => typeOf(option, depth))))
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

const HEADER = `// Generated by scripts/gen_api.ts from assets/openapi.json. Do not edit: change the server's
// document and run \`bun scripts/gen_api.ts\`.
`

export const generate = (doc: Json): string => {
  const components = isNode(doc) && isNode(doc.components) ? doc.components : {}
  const schemas = isNode(components.schemas) ? components.schemas : {}
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
  const extras = EXTENDED.map(id => `${id}Extra`).join(', ')
  return `${HEADER}\nimport type { ${extras} } from './extend'\n\n${out.join('\n\n')}\n`
}

if (import.meta.main) {
  writeFileSync(OUTPUT, generate(JSON.parse(readFileSync(DOCUMENT, 'utf8')) as Json))
  console.log(`wrote ${OUTPUT}`)
}
