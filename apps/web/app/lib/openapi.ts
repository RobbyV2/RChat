// The API console: reads the instance's OpenAPI document into operations with form fields,
// checks and builds requests from what was typed, and keeps a short local history without
// secrets. Only `/api/` paths of this instance are ever called, under the base this client uses.

import { apiTail } from './api_version'

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

const METHODS: Method[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE']

export type FieldKind =
  'string' | 'integer' | 'number' | 'boolean' | 'enum' | 'object' | 'array' | 'json'

export interface Field {
  name: string
  description: string | null
  required: boolean
  nullable: boolean
  kind: FieldKind
  options?: string[]
  format?: string
  minimum?: number
  maximum?: number
  minLength?: number
  maxLength?: number
  pattern?: string
  minItems?: number
  maxItems?: number
  fields?: Field[]
  items?: Field
  example?: unknown
  default?: unknown
}

export type ParamIn = 'path' | 'query' | 'header'

export interface Param extends Field {
  in: ParamIn
}

export interface Operation {
  id: string
  method: Method
  path: string
  summary: string
  description: string
  tag: string
  params: Param[]
  body: Field | null
  // The body can only be sent as a file upload, which the console does not do.
  multipart: boolean
  // Asks before it is sent (every method but GET).
  confirm: boolean
}

type Json = Record<string, unknown>

const isObj = (x: unknown): x is Json => typeof x === 'object' && x !== null && !Array.isArray(x)

const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : undefined)
const text = (x: unknown) => (typeof x === 'string' ? x : undefined)

const MAX_DEPTH = 6

const resolve = (doc: Json, schema: unknown, seen: string[] = []): Json | null => {
  if (!isObj(schema)) return null
  const ref = text(schema.$ref)
  if (!ref) return schema
  if (!ref.startsWith('#/') || seen.includes(ref) || seen.length > MAX_DEPTH) return null
  let at: unknown = doc
  for (const part of ref.slice(2).split('/'))
    at = isObj(at) ? at[part.replaceAll('~1', '/').replaceAll('~0', '~')] : undefined
  const target = resolve(doc, at, [...seen, ref])
  if (!target) return null
  // A description next to the `$ref` belongs to the property and wins.
  const { $ref: _ref, ...rest } = schema
  void _ref
  return { ...target, ...rest }
}

const mergeAll = (doc: Json, parts: unknown[]): Json => {
  const properties: Json = {}
  const required: string[] = []
  let out: Json = {}
  for (const p of parts) {
    const r = resolve(doc, p)
    if (!r) continue
    out = { ...out, ...r }
    if (isObj(r.properties)) Object.assign(properties, r.properties)
    if (Array.isArray(r.required)) required.push(...r.required.filter(x => typeof x === 'string'))
  }
  const { allOf: _a, ...rest } = out
  void _a
  return Object.keys(properties).length ? { ...rest, type: 'object', properties, required } : rest
}

export const fieldOf = (
  doc: Json,
  raw: unknown,
  name: string,
  required: boolean,
  depth = 0
): Field => {
  const base: Field = { name, description: null, required, nullable: false, kind: 'json' }
  let schema = resolve(doc, raw)
  if (!schema || depth > MAX_DEPTH) return base
  if (Array.isArray(schema.allOf)) schema = mergeAll(doc, schema.allOf)
  const outerDescription = text(schema.description) ?? null
  const choice = Array.isArray(schema.oneOf)
    ? schema.oneOf
    : Array.isArray(schema.anyOf)
      ? schema.anyOf
      : null
  if (choice) {
    const parts = choice.map(c => resolve(doc, c)).filter((c): c is Json => c !== null)
    const nonNull = parts.filter(p => p.type !== 'null')
    const nullable = nonNull.length !== parts.length
    if (nonNull.length === 1) {
      const inner = fieldOf(doc, nonNull[0], name, required, depth + 1)
      return {
        ...inner,
        nullable: inner.nullable || nullable,
        description: outerDescription ?? inner.description,
      }
    }
    return { ...base, nullable, description: outerDescription }
  }
  let type = schema.type
  let nullable = false
  if (Array.isArray(type)) {
    nullable = type.includes('null')
    const rest = type.filter(t => t !== 'null')
    type = rest.length === 1 ? rest[0] : undefined
  }
  const field: Field = {
    ...base,
    description: outerDescription,
    nullable,
    format: text(schema.format),
    example: schema.example,
    default: schema.default,
  }
  if (Array.isArray(schema.enum)) {
    const options = schema.enum.filter((x): x is string => typeof x === 'string')
    return {
      ...field,
      kind: 'enum',
      options,
      nullable: nullable || schema.enum.includes(null),
    }
  }
  switch (type) {
    case 'string':
      return {
        ...field,
        kind: 'string',
        minLength: num(schema.minLength),
        maxLength: num(schema.maxLength),
        pattern: text(schema.pattern),
      }
    case 'integer':
    case 'number':
      return {
        ...field,
        kind: type,
        minimum: num(schema.minimum) ?? num(schema.exclusiveMinimum),
        maximum: num(schema.maximum) ?? num(schema.exclusiveMaximum),
      }
    case 'boolean':
      return { ...field, kind: 'boolean' }
    case 'array':
      return {
        ...field,
        kind: 'array',
        items: fieldOf(doc, schema.items, 'item', true, depth + 1),
        minItems: num(schema.minItems),
        maxItems: num(schema.maxItems),
      }
    case 'object':
    case undefined: {
      if (!isObj(schema.properties)) return field
      const req = new Set(Array.isArray(schema.required) ? schema.required : [])
      const fields = Object.entries(schema.properties).map(([k, v]) =>
        fieldOf(doc, v, k, req.has(k), depth + 1)
      )
      fields.sort((a, b) => Number(b.required) - Number(a.required))
      return { ...field, kind: 'object', fields }
    }
    default:
      return field
  }
}

// Every request that is not a GET asks before it is sent.
export const needsConfirm = (method: Method) => method !== 'GET'

// Template paths that could leave `/api/` once resolved are not offered.
const UNSAFE_PATH = /\\|%|\/\/|(^|\/)\.{1,2}(\/|$)/

export const parseOpenApi = (raw: unknown): Operation[] => {
  if (!isObj(raw) || !isObj(raw.paths)) return []
  const doc = raw
  const out: Operation[] = []
  for (const [path, item] of Object.entries(raw.paths)) {
    if (!path.startsWith('/api/') || UNSAFE_PATH.test(path) || !isObj(item)) continue
    const shared = Array.isArray(item.parameters) ? item.parameters : []
    for (const method of METHODS) {
      const op = item[method.toLowerCase()]
      if (!isObj(op)) continue
      const params: Param[] = []
      for (const p of [...shared, ...(Array.isArray(op.parameters) ? op.parameters : [])]) {
        const r = resolve(doc, p)
        const where = r?.in
        if (!r || (where !== 'path' && where !== 'query' && where !== 'header')) continue
        const name = text(r.name)
        if (!name || name.toLowerCase() === 'authorization') continue
        const f = fieldOf(doc, r.schema, name, where === 'path' || r.required === true)
        params.push({ ...f, description: text(r.description) ?? f.description, in: where })
      }
      let body: Field | null = null
      let multipart = false
      const rb = resolve(doc, op.requestBody)
      if (rb && isObj(rb.content)) {
        const json = rb.content['application/json']
        if (isObj(json)) body = fieldOf(doc, json.schema, 'body', rb.required === true)
        else multipart = true
      }
      out.push({
        id: text(op.operationId) ?? `${method} ${path}`,
        method,
        path,
        summary: text(op.summary) ?? `${method} ${path}`,
        description: text(op.description) ?? '',
        tag: Array.isArray(op.tags) && typeof op.tags[0] === 'string' ? op.tags[0] : 'Other',
        params,
        body,
        multipart,
        confirm: needsConfirm(method),
      })
    }
  }
  return out
}

// --- form values -----------------------------------------------------------------------------

// What the form holds: text for scalars (`''` is not set), `null` for an explicit null, lists for
// arrays and records for objects.
export type FormValue = string | null | FormValue[] | { [key: string]: FormValue }

export const emptyValue = (f: Field): FormValue => {
  if (f.kind === 'object')
    return Object.fromEntries((f.fields ?? []).map(x => [x.name, emptyValue(x)]))
  if (f.kind === 'array') return []
  return ''
}

const isRecord = (v: FormValue): v is { [key: string]: FormValue } =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// The value of `f` in a record (`null` kept), or its empty value.
export const valueAt = (rec: Record<string, FormValue> | null | undefined, f: Field): FormValue => {
  const v = rec && Object.hasOwn(rec, f.name) ? rec[f.name] : undefined
  return v === undefined ? emptyValue(f) : v
}

const isSet = (f: Field, v: FormValue): boolean => {
  if (v === null) return true
  if (typeof v === 'string') return v !== ''
  if (Array.isArray(v)) return v.length > 0
  return (f.fields ?? []).some(x => isSet(x, valueAt(v, x)))
}

const chars = (s: string) => [...s].length

// Control characters other than tab and line breaks are removed from typed text.
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g

export const sanitize = (s: string) => s.replace(CONTROL, '')

export type Errors = Record<string, string>

export const validate = (f: Field, v: FormValue, path = f.name, out: Errors = {}): Errors => {
  if (!isSet(f, v)) {
    // A required object reports its own required fields.
    if (f.required && f.kind === 'object' && isRecord(v)) {
      for (const x of f.fields ?? []) validate(x, valueAt(v, x), `${path}.${x.name}`, out)
      return out
    }
    if (f.required) out[path] = 'Required'
    return out
  }
  if (v === null) {
    if (!f.nullable) out[path] = 'Cannot be null'
    return out
  }
  if (typeof v === 'string') {
    const t = v.trim()
    switch (f.kind) {
      case 'integer': {
        const n = Number(t)
        if (!/^-?\d+$/.test(t) || !Number.isSafeInteger(n)) out[path] = 'Use a whole number'
        else if (f.minimum !== undefined && n < f.minimum) out[path] = `At least ${f.minimum}`
        else if (f.maximum !== undefined && n > f.maximum) out[path] = `At most ${f.maximum}`
        break
      }
      case 'number': {
        const n = Number(t)
        if (!t || !Number.isFinite(n)) out[path] = 'Use a number'
        else if (f.minimum !== undefined && n < f.minimum) out[path] = `At least ${f.minimum}`
        else if (f.maximum !== undefined && n > f.maximum) out[path] = `At most ${f.maximum}`
        break
      }
      case 'boolean':
        if (v !== 'true' && v !== 'false') out[path] = 'Pick true or false'
        break
      case 'enum':
        if (!(f.options ?? []).includes(v)) out[path] = 'Pick one of the options'
        break
      case 'json':
        try {
          JSON.parse(v)
        } catch {
          out[path] = 'Not valid JSON'
        }
        break
      default: {
        const n = chars(sanitize(v))
        if (f.minLength !== undefined && n < f.minLength)
          out[path] = `At least ${f.minLength} characters`
        else if (f.maxLength !== undefined && n > f.maxLength)
          out[path] = `At most ${f.maxLength} characters`
        else if (f.pattern) {
          try {
            if (!new RegExp(f.pattern, 'u').test(v)) out[path] = 'Does not match the format'
          } catch {
            // A pattern this browser can't read is not checked.
          }
        }
      }
    }
    return out
  }
  if (Array.isArray(v)) {
    if (f.kind !== 'array' || !f.items) return out
    if (f.minItems !== undefined && v.length < f.minItems)
      out[path] = `At least ${f.minItems} items`
    if (f.maxItems !== undefined && v.length > f.maxItems) out[path] = `At most ${f.maxItems} items`
    v.forEach((item, i) => validate({ ...f.items!, required: true }, item, `${path}.${i}`, out))
    return out
  }
  for (const x of f.fields ?? []) validate(x, valueAt(v, x), `${path}.${x.name}`, out)
  return out
}

// The JSON value for a field, or undefined when it is left out. Call after `validate`.
export const buildValue = (f: Field, v: FormValue): unknown => {
  if (!isSet(f, v)) return f.kind === 'object' && f.required ? {} : undefined
  if (v === null) return null
  if (typeof v === 'string') {
    switch (f.kind) {
      case 'integer':
      case 'number':
        return Number(v.trim())
      case 'boolean':
        return v === 'true'
      case 'json':
        return JSON.parse(v) as unknown
      default:
        return sanitize(v)
    }
  }
  if (Array.isArray(v))
    return v.flatMap(item => {
      const built = f.items ? buildValue({ ...f.items, required: true }, item) : undefined
      return built === undefined ? [] : [built]
    })
  const out: Record<string, unknown> = {}
  for (const x of f.fields ?? []) {
    const built = buildValue(x, isRecord(v) ? valueAt(v, x) : emptyValue(x))
    if (built !== undefined) out[x.name] = built
  }
  return out
}

export interface Values {
  params: Record<string, FormValue>
  body: FormValue
}

export const emptyValues = (op: Operation): Values => ({
  params: Object.fromEntries(op.params.map(p => [p.name, emptyValue(p)])),
  body: op.body ? emptyValue(op.body) : '',
})

export interface BuiltRequest {
  method: Method
  // `/api/...` with path parameters filled in, and the query string.
  path: string
  query: string
  headers: Record<string, string>
  body: unknown
}

export type BuildResult = { ok: true; request: BuiltRequest } | { ok: false; errors: Errors }

export const buildRequest = (op: Operation, values: Values, guest: boolean): BuildResult => {
  const errors: Errors = {}
  if (guest && op.method !== 'GET') errors._ = 'Guests can only send GET requests.'
  if (op.multipart) errors._ = 'File uploads are not supported here.'
  for (const p of op.params) validate(p, valueAt(values.params, p), `param.${p.name}`, errors)
  if (op.body) validate(op.body, values.body, 'body', errors)
  let path = op.path
  const query = new URLSearchParams()
  const headers: Record<string, string> = {}
  for (const p of op.params) {
    const built = buildValue(p, valueAt(values.params, p))
    if (built === undefined || built === null) continue
    const list = Array.isArray(built) ? built : [built]
    if (p.in === 'path') {
      const raw = String(built)
      if (raw === '.' || raw === '..' || raw.includes('/')) {
        errors[`param.${p.name}`] = 'Not a valid value'
        continue
      }
      path = path.replace(`{${p.name}}`, encodeURIComponent(raw))
    } else if (p.in === 'query') {
      for (const x of list)
        query.append(p.name, typeof x === 'object' ? JSON.stringify(x) : String(x))
    } else {
      headers[p.name] = String(built)
    }
  }
  if (Object.keys(errors).length) return { ok: false, errors }
  const body = op.body ? buildValue(op.body, values.body) : undefined
  return {
    ok: true,
    request: { method: op.method, path, query: query.toString(), headers, body },
  }
}

// What pressing Send does: show the errors, ask first (anything but GET), or send.
export type SendPlan =
  | { kind: 'errors'; errors: Errors }
  | { kind: 'confirm'; request: BuiltRequest }
  | { kind: 'send'; request: BuiltRequest }

export const planSend = (op: Operation, values: Values, guest: boolean): SendPlan => {
  const built = buildRequest(op, values, guest)
  if (!built.ok) return { kind: 'errors', errors: built.errors }
  return { kind: op.confirm ? 'confirm' : 'send', request: built.request }
}

// The path to send under the API base, from the documented `/api/v1/...` (or, on instances from
// before versions, `/api/...`) path. Anything else is refused, so the console never reaches
// another origin or a non-API route.
const ESCAPES = /\\|%2e|%2f|%5c|(^|\/)\.{1,2}(\/|$)|\/\//i

export const requestPath = (r: Pick<BuiltRequest, 'path' | 'query'>) => {
  const tail = apiTail(r.path)
  if (tail === null || ESCAPES.test(r.path)) return null
  return `${tail}${r.query ? `?${r.query}` : ''}`
}

export const requestUrl = (apiBase: string, r: Pick<BuiltRequest, 'path' | 'query'>) => {
  const path = requestPath(r)
  return path === null ? null : `${apiBase.replace(/\/+$/, '')}${path}`
}

const quote = (s: string) => `'${s.replaceAll("'", `'\\''`)}'`

// A curl command for the request. Without `token` the header reads `$RCHAT_TOKEN`.
export const toCurl = (url: string, r: BuiltRequest, token: string | null) => {
  const lines = [`curl -X ${r.method} ${quote(url)}`]
  lines.push(
    token === null
      ? `-H "Authorization: Bearer $RCHAT_TOKEN"`
      : `-H ${quote(`Authorization: Bearer ${token}`)}`
  )
  for (const [k, v] of Object.entries(r.headers)) lines.push(`-H ${quote(`${k}: ${v}`)}`)
  if (r.body !== undefined) {
    lines.push(`-H 'Content-Type: application/json'`)
    lines.push(`--data-raw ${quote(JSON.stringify(r.body))}`)
  }
  return lines.join(' \\\n  ')
}

// --- secrets ---------------------------------------------------------------------------------

const SECRET =
  /(^|[_-])(password|passwords|passphrase|token|tokens|secret|secrets|words|credential|credentials|grant|assertion|key|keys|api_key|private_key|seed|code|codes|otp)($|[_-])/i

export const REDACTED = '[redacted]'

export const isSecretName = (name: string) => SECRET.test(name)

// Form values with every secret-looking field replaced.
export const redact = (v: FormValue, name = ''): FormValue => {
  if (name && isSecretName(name) && v !== '' && !(Array.isArray(v) && !v.length)) return REDACTED
  if (Array.isArray(v)) return v.map(x => redact(x))
  if (isRecord(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redact(x, k)]))
  return v
}

// A built JSON value with every secret-looking key replaced.
const redactJson = (v: unknown, name = ''): unknown => {
  if (name && isSecretName(name) && v !== undefined && v !== null) return REDACTED
  if (Array.isArray(v)) return v.map(x => redactJson(x))
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactJson(x, k)]))
  return v
}

// The operation's path with the values filled in, except secret ones (and anything not set or
// redacted), which stay as `{name}`.
export const fillPath = (op: Operation, values: Values) =>
  op.path.replace(/\{([^}]+)\}/g, (all, name: string) => {
    const p = op.params.find(x => x.in === 'path' && x.name === name)
    if (!p || isSecretName(name)) return all
    const v = valueAt(values.params, p)
    if (v === REDACTED || !isSet(p, v) || validate(p, v, 'x').x) return all
    const built = buildValue(p, v)
    const raw = built === undefined || built === null ? '' : String(built)
    if (!raw || raw === '.' || raw === '..' || raw.includes('/')) return all
    return encodeURIComponent(raw)
  })

// The request as it may be shown or copied: secret path values back to `{name}`, secret query,
// header and body values replaced.
export const hideSecrets = (op: Operation, values: Values, r: BuiltRequest): BuiltRequest => {
  const query = new URLSearchParams(
    [...new URLSearchParams(r.query)].map(([k, v]) => [k, isSecretName(k) ? REDACTED : v])
  )
  return {
    method: r.method,
    path: fillPath(op, values),
    query: query.toString(),
    headers: Object.fromEntries(
      Object.entries(r.headers).map(([k, v]) => [k, isSecretName(k) ? REDACTED : v])
    ),
    body: r.body === undefined ? undefined : redactJson(r.body),
  }
}

// --- history ---------------------------------------------------------------------------------

export interface HistoryEntry {
  op: string
  method: Method
  // The operation's path template (`/api/webhooks/{id}/{token}`), never the filled-in path; empty
  // for entries saved before templates were kept.
  path: string
  status: number
  at: number
  values: Values
}

export interface ApiHistory {
  v: 2
  items: HistoryEntry[]
}

export const HISTORY_MAX = 25
const HISTORY_VALUES_MAX = 8 * 1024

export const EMPTY_HISTORY: ApiHistory = { v: 2, items: [] }

export const historyKey = (username: string | null) => `rchat_api_history:${username ?? 'guest'}`

const isFormValue = (x: unknown, depth = 0): x is FormValue => {
  if (depth > 12) return false
  if (x === null || typeof x === 'string') return true
  if (Array.isArray(x)) return x.every(i => isFormValue(i, depth + 1))
  return isObj(x) && Object.values(x).every(i => isFormValue(i, depth + 1))
}

const valuesOf = (x: unknown): Values | null => {
  if (!isObj(x) || !isObj(x.params) || !isFormValue(x.params) || !isFormValue(x.body)) return null
  return { params: x.params as Record<string, FormValue>, body: x.body }
}

// Version 1 kept the filled-in path, secrets included: those paths are dropped (the row is built
// from the operation's template again).
export const parseHistory = (raw: string | null): ApiHistory => {
  try {
    const data = raw ? (JSON.parse(raw) as unknown) : null
    if (!isObj(data) || (data.v !== 1 && data.v !== 2) || !Array.isArray(data.items))
      return EMPTY_HISTORY
    const legacy = data.v === 1
    const items = data.items.flatMap((x): HistoryEntry[] => {
      if (!isObj(x)) return []
      const method = METHODS.find(m => m === x.method)
      const values = valuesOf(x.values)
      if (!method || typeof x.op !== 'string' || typeof x.path !== 'string' || !values) return []
      if (!x.path.startsWith('/api/')) return []
      const status = Number.isSafeInteger(x.status) ? (x.status as number) : 0
      const at = typeof x.at === 'number' && Number.isFinite(x.at) ? x.at : 0
      const path = legacy ? '' : x.path
      return [{ op: x.op, method, path, status, at, values: redactValues(values) }]
    })
    return { v: 2, items: items.slice(0, HISTORY_MAX) }
  } catch {
    return EMPTY_HISTORY
  }
}

export const redactValues = (values: Values): Values => {
  const params = Object.fromEntries(
    Object.entries(values.params).map(([k, v]) => [k, redact(v, k)])
  )
  const body = redact(values.body)
  // Large bodies are not kept.
  const keep = JSON.stringify(body).length <= HISTORY_VALUES_MAX
  return { params, body: keep ? body : '' }
}

export const pushHistory = (h: ApiHistory, entry: HistoryEntry): ApiHistory => ({
  v: 2,
  items: [{ ...entry, values: redactValues(entry.values) }, ...h.items].slice(0, HISTORY_MAX),
})

export const historyValue = (h: ApiHistory) => JSON.stringify(h)

// Saved values back on the operation's current fields: unknown keys and redacted secrets are
// left empty.
export const restoreValues = (op: Operation, saved: Values): Values => {
  const fit = (f: Field, v: FormValue | undefined): FormValue => {
    if (v === undefined || v === REDACTED) return emptyValue(f)
    if (f.kind === 'object') {
      if (!isRecord(v)) return emptyValue(f)
      return Object.fromEntries((f.fields ?? []).map(x => [x.name, fit(x, v[x.name])]))
    }
    if (f.kind === 'array') return Array.isArray(v) ? v.map(i => fit(f.items!, i)) : []
    return typeof v === 'string' || v === null ? v : emptyValue(f)
  }
  return {
    params: Object.fromEntries(op.params.map(p => [p.name, fit(p, saved.params[p.name])])),
    body: op.body ? fit(op.body, saved.body) : '',
  }
}

// --- responses -------------------------------------------------------------------------------

export const RENDER_MAX = 512 * 1024

// The body as shown: JSON pretty-printed, everything cut at `max` characters.
export const prettyBody = (raw: string, type: string | null, max = RENDER_MAX) => {
  let out = raw
  let json = false
  if (type?.includes('json') || /^\s*[[{]/.test(raw)) {
    try {
      out = JSON.stringify(JSON.parse(raw), null, 2)
      json = true
    } catch {
      out = raw
    }
  }
  const cut = out.length > max
  return { text: cut ? out.slice(0, max) : out, json, cut }
}
