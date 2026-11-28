export interface Issue {
  path: string
  expected: string
}

// `unknown` marks a value from a newer peer or server (a tag or choice this build has no name
// for). It is not a fault of the sender.
export type Parsed<T> =
  | { ok: true; value: T }
  | { ok: false; unknown: true }
  | { ok: false; unknown: false; issue: Issue }

type Run<T> = (x: unknown) => Parsed<T>

const made: unique symbol = Symbol('schema')
const run: unique symbol = Symbol('run')

declare const branded: unique symbol
export type Brand<B extends string> = { readonly [branded]: B }

const good = <T>(value: T): Parsed<T> => ({ ok: true, value })
const bad = (expected: string, path = ''): Parsed<never> => ({
  ok: false,
  unknown: false,
  issue: { path, expected },
})
const NEWER: Parsed<never> = { ok: false, unknown: true }

const under = (key: string | number, issue: Issue): Parsed<never> => {
  const head = typeof key === 'number' ? `[${key}]` : key
  const sep = issue.path === '' || issue.path.startsWith('[') ? '' : '.'
  return bad(issue.expected, `${head}${sep}${issue.path}`)
}

const isObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x)

const has = (x: object, key: string) => Object.prototype.hasOwnProperty.call(x, key)

export class Schema<T> {
  readonly [run]: Run<T>

  constructor(key: typeof made, r: Run<T>) {
    if (key !== made) throw new TypeError('schemas come from the combinators')
    this[run] = r
  }

  parse(x: unknown): Parsed<T> {
    return this[run](x)
  }

  array(limits: { max?: number } = {}): Schema<T[]> {
    return arr(this, limits)
  }

  optional(): Optional<T> {
    return opt(this)
  }

  nullable(): Schema<T | null> {
    return nullable(this)
  }

  brand<B extends string>(): Schema<T & Brand<B>> {
    return this as unknown as Schema<T & Brand<B>>
  }

  refine(holds: (value: T) => boolean, expected: string): Schema<T> {
    return new Schema(made, x => {
      const r = this[run](x)
      return !r.ok || holds(r.value) ? r : bad(expected)
    })
  }

  map<U>(to: (value: T) => U): Schema<U> {
    return new Schema(made, x => {
      const r = this[run](x)
      return r.ok ? good(to(r.value)) : r
    })
  }
}

export class Optional<T> extends Schema<T | undefined> {
  readonly absentAllowed = true as const
}

export type Infer<S> = S extends Schema<infer T> ? T : never

export type Shape = Record<string, Schema<unknown>>

type OptionalKeys<S extends Shape> = {
  [K in keyof S]: S[K] extends Optional<unknown> ? K : never
}[keyof S]

type Flat<T> = { [K in keyof T]: T[K] }

export type ObjectOf<S extends Shape> = Flat<
  { [K in Exclude<keyof S, OptionalKeys<S>>]: Infer<S[K]> } & {
    [K in OptionalKeys<S>]?: Infer<S[K]>
  }
>

export class ObjectSchema<S extends Shape> extends Schema<ObjectOf<S>> {
  readonly shape: S

  constructor(key: typeof made, shape: S) {
    const fields = Object.entries(shape)
    super(key, x => {
      if (!isObject(x)) return bad('an object')
      const out: Record<string, unknown> = {}
      for (const [name, field] of fields) {
        const present = has(x, name) && x[name] !== undefined
        if (!present && field instanceof Optional) continue
        const r = field[run](present ? x[name] : undefined)
        if (!r.ok) return r.unknown ? r : under(name, r.issue)
        out[name] = r.value
      }
      return good(out as ObjectOf<S>)
    })
    this.shape = shape
  }

  extend<M extends Shape>(more: M): ObjectSchema<Flat<Omit<S, keyof M> & M>> {
    return obj({ ...this.shape, ...more } as unknown as Flat<Omit<S, keyof M> & M>)
  }
}

export const str = ({ min = 0, max }: { min?: number; max?: number } = {}): Schema<string> =>
  new Schema(made, x => {
    if (typeof x !== 'string') return bad('a string')
    if (x.length < min) return bad(`at least ${min} characters`)
    if (max !== undefined && x.length > max) return bad(`at most ${max} characters`)
    return good(x)
  })

const ranged =
  (what: string, fits: (n: number) => boolean) =>
  ({ min, max }: { min?: number; max?: number } = {}): Schema<number> =>
    new Schema(made, x => {
      if (typeof x !== 'number' || !fits(x)) return bad(what)
      if (min !== undefined && x < min) return bad(`at least ${min}`)
      if (max !== undefined && x > max) return bad(`at most ${max}`)
      return good(x)
    })

export const int = ranged('a whole number', Number.isSafeInteger)
export const num = ranged('a number', Number.isFinite)

export const bool: Schema<boolean> = new Schema(made, x =>
  typeof x === 'boolean' ? good(x) : bad('true or false')
)

export const anything: Schema<unknown> = new Schema(made, x => good(x))

export const lit = <const V extends string | number | boolean | null>(value: V): Schema<V> =>
  new Schema(made, x => (x === value ? good(value) : bad(JSON.stringify(value))))

// One of a growing set of names: a string outside the set is `unknown`, not an issue.
export const choice = <const V extends readonly string[]>(...values: V): Schema<V[number]> => {
  const known = new Set<string>(values)
  return new Schema(made, x => {
    if (typeof x !== 'string') return bad('a string')
    return known.has(x) ? good(x as V[number]) : NEWER
  })
}

export const obj = <S extends Shape>(shape: S): ObjectSchema<S> => new ObjectSchema(made, shape)

// Items this build cannot name are left out; the rest of the list stands.
export const arr = <T>(item: Schema<T>, { max }: { max?: number } = {}): Schema<T[]> =>
  new Schema(made, x => {
    if (!Array.isArray(x)) return bad('a list')
    if (max !== undefined && x.length > max) return bad(`at most ${max} items`)
    const out: T[] = []
    for (let i = 0; i < x.length; i += 1) {
      const r = item[run](x[i])
      if (r.ok) out.push(r.value)
      else if (!r.unknown) return under(i, r.issue)
    }
    return good(out)
  })

export const record = <T>(
  value: Schema<T>,
  { max }: { max?: number } = {}
): Schema<Record<string, T>> =>
  new Schema(made, x => {
    if (!isObject(x)) return bad('an object')
    const keys = Object.keys(x)
    if (max !== undefined && keys.length > max) return bad(`at most ${max} entries`)
    const out: [string, T][] = []
    for (const key of keys) {
      const r = value[run](x[key])
      if (r.ok) out.push([key, r.value])
      else if (!r.unknown) return under(key, r.issue)
    }
    return good(Object.fromEntries(out))
  })

export const opt = <T>(inner: Schema<T>): Optional<T> =>
  new Optional<T>(made, x => (x === undefined ? good(undefined) : inner[run](x)))

export const nullable = <T>(inner: Schema<T>): Schema<T | null> =>
  new Schema(made, x => (x === null ? good(null) : inner[run](x)))

export const lazy = <T>(get: () => Schema<T>): Schema<T> => new Schema(made, x => get()[run](x))

// A field a server may leave out where it means null: a missing one reads as null.
export const orNull = <T>(inner: Schema<T>): Schema<T | null> =>
  new Schema(made, x => (x === undefined || x === null ? good(null) : inner[run](x)))

// A permission mask: a whole number on the wire, a `bigint` once read (`readJson` already turns
// the known mask fields into `bigint`s).
export const mask: Schema<bigint> = new Schema(made, x => {
  if (typeof x === 'bigint') return good(x)
  return typeof x === 'number' && Number.isSafeInteger(x) ? good(BigInt(x)) : bad('a whole number')
})

// Every shape read from one value, their fields together (a shape with the fields of others).
export const merged = <T>(...shapes: readonly Schema<object>[]): Schema<T> =>
  new Schema(made, x => {
    const out: Record<string, unknown> = {}
    for (const shape of shapes) {
      const r = shape[run](x)
      if (!r.ok) return r
      Object.assign(out, r.value)
    }
    return good(out as T)
  })

type Variants = Record<string, Schema<object>>

export type TaggedOf<K extends string, V extends Variants> = {
  [T in keyof V]: Flat<Infer<V[T]> & { [P in K]: T }>
}[keyof V]

// An object whose `key` field names its shape. A name outside `variants` is `unknown`.
export const tagged = <K extends string, V extends Variants>(
  key: K,
  variants: V
): Schema<TaggedOf<K, V>> =>
  new Schema(made, x => {
    if (!isObject(x)) return bad('an object')
    const tag = x[key]
    if (typeof tag !== 'string') return bad('a string', key)
    if (!has(variants, tag)) return NEWER
    const r = variants[tag][run](x)
    return r.ok ? good({ ...r.value, [key]: tag } as TaggedOf<K, V>) : r
  })

// The first shape that fits. With none, `unknown` when any shape met a newer value.
export const union = <const S extends readonly Schema<unknown>[]>(
  ...shapes: S
): Schema<Infer<S[number]>> =>
  new Schema(made, x => {
    let newer = false
    for (const shape of shapes) {
      const r = shape[run](x)
      if (r.ok) return r as Parsed<Infer<S[number]>>
      newer ||= r.unknown
    }
    return newer ? NEWER : bad(`one of ${shapes.length} shapes`)
  })

export const bytes = ({ max }: { max?: number } = {}): Schema<Uint8Array> =>
  new Schema(made, x => {
    if (!(x instanceof Uint8Array)) return bad('bytes')
    return max !== undefined && x.length > max ? bad(`at most ${max} bytes`) : good(x)
  })

const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}(?:==)?|[A-Za-z0-9+/]{3}=?)?$/

// Bytes written as base64 text, in the standard or the URL alphabet, padded or not.
export const base64 = ({ max }: { max?: number } = {}): Schema<Uint8Array> =>
  new Schema(made, x => {
    if (typeof x !== 'string') return bad('base64 text')
    const text = x.replace(/-/g, '+').replace(/_/g, '/')
    if (!BASE64.test(text)) return bad('base64 text')
    const size = Math.floor((text.replace(/=+$/, '').length * 3) / 4)
    if (max !== undefined && size > max) return bad(`at most ${max} bytes`)
    const bin = atob(text)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i)
    return good(out)
  })

// Any JSON object, its fields as they are (a stored record whose fields are read one by one).
export const jsonObject: Schema<Record<string, unknown>> = new Schema(made, x =>
  isObject(x) ? good(x) : bad('an object')
)

// A shape whose check is a type guard the code already has: `expected` names it in issues.
export const guarded = <T>(is: (x: unknown) => x is T, expected: string): Schema<T> =>
  new Schema(made, x => (is(x) ? good(x) : bad(expected)))

// The one place JSON text becomes a value: read against `schema`. `revive` changes values as
// they are read (JSON.parse's reviver).
export const parseJson = <T>(
  text: string,
  schema: Schema<T>,
  revive?: (key: string, value: unknown) => unknown
): Parsed<T> => {
  let value: unknown
  try {
    value = JSON.parse(text, revive)
  } catch {
    return bad('JSON')
  }
  return schema.parse(value)
}

// What `text` reads as against `schema`, or `fallback` for no text, text that is not JSON, and a
// value of another shape.
export const jsonOr = <T, F = T>(text: string | null, schema: Schema<T>, fallback: F): T | F => {
  if (text === null) return fallback
  const read = parseJson(text, schema)
  return read.ok ? read.value : fallback
}

export const issueText = (issue: Issue) =>
  issue.path === '' ? `expected ${issue.expected}` : `${issue.path}: expected ${issue.expected}`
