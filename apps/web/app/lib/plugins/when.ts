// When a plugin action is available: a condition over the action's context, as plain data.
// A path is dot-separated names into the context, such as `target.kind`. In `eq` the second
// value is a literal, or `{ path }` for another place in the context.

export type Literal = string | number | boolean | null
export type Operand = Literal | { path: string }
export type When =
  | { all: When[] }
  | { any: When[] }
  | { not: When }
  | { eq: [string, Operand] }
  | { in: [string, Literal[]] }
  | { has: string }
  | { match: [string, string] }

// Runs a plugin's pattern over text in the linear-time matcher.
export type Matcher = (pattern: string, text: string) => boolean

export const WHEN_LIMITS = {
  depth: 8,
  nodes: 64,
  path: 128,
  list: 64,
  pattern: 1024,
  text: 65536,
  errors: 20,
} as const

const OPERATORS = ['all', 'any', 'not', 'eq', 'in', 'has', 'match']
const NAME = /^[A-Za-z0-9_]+$/
const INDEX = /^(0|[1-9]\d*)$/
const RESERVED = ['__proto__', 'constructor', 'prototype']

// A plain object, as postMessage makes one: not an array, a typed array or a map.
const record = (v: unknown): v is Record<string, unknown> => {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const okPath = (p: unknown): p is string =>
  typeof p === 'string' &&
  p.length <= WHEN_LIMITS.path &&
  p.split('.').every(s => NAME.test(s) && !RESERVED.includes(s))

const okLiteral = (v: unknown): v is Literal =>
  v === null ||
  typeof v === 'boolean' ||
  (typeof v === 'number' && Number.isFinite(v)) ||
  (typeof v === 'string' && v.length <= WHEN_LIMITS.pattern)

const okPattern = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= 1 && v.length <= WHEN_LIMITS.pattern

const pair = (v: unknown): v is [unknown, unknown] => Array.isArray(v) && v.length === 2

// Every entry, holes too: postMessage keeps a list's length even where it has no element.
const all = (v: readonly unknown[], ok: (x: unknown) => boolean) => {
  for (let i = 0; i < v.length; i++) if (!ok(v[i])) return false
  return true
}

// What is wrong with a condition; an empty list means it may be registered.
export const checkWhen = (w: unknown): string[] => {
  const errors: string[] = []
  let nodes = 0
  const fail = (error: string) => {
    if (errors.length < WHEN_LIMITS.errors) errors.push(error)
  }
  const walk = (node: unknown, depth: number) => {
    if (nodes > WHEN_LIMITS.nodes) return
    if (!record(node)) return fail('not a condition')
    if (depth > WHEN_LIMITS.depth) return fail('too deep')
    nodes += 1
    const keys = Object.keys(node)
    if (keys.length !== 1) return fail('needs one operator')
    const op = keys[0]
    const arg = node[op]
    if (!OPERATORS.includes(op)) return fail(`unknown operator ${op}`)
    if (op === 'all' || op === 'any') {
      if (!Array.isArray(arg)) return fail(`${op}: needs a list`)
      if (arg.length > WHEN_LIMITS.nodes - nodes) nodes = WHEN_LIMITS.nodes + 1
      for (let i = 0; i < arg.length && nodes <= WHEN_LIMITS.nodes; i++) walk(arg[i], depth + 1)
    } else if (op === 'not') walk(arg, depth + 1)
    else if (op === 'has') {
      if (!okPath(arg)) fail('has: bad path')
    } else if (op === 'eq') {
      if (!pair(arg)) return fail('eq: needs a path and a value')
      const [path, value] = arg
      if (!okPath(path)) fail('eq: bad path')
      else if (record(value)) {
        if (Object.keys(value).length !== 1 || !('path' in value)) fail('eq: bad value')
        else if (!okPath(value.path)) fail('eq: bad path')
      } else if (!okLiteral(value)) fail('eq: bad value')
    } else if (op === 'in') {
      if (!pair(arg) || !Array.isArray(arg[1])) return fail('in: needs a path and a list')
      if (!okPath(arg[0])) fail('in: bad path')
      else if (arg[1].length > WHEN_LIMITS.list) fail('in: too many values')
      else if (!all(arg[1], okLiteral)) fail('in: bad value')
    } else {
      if (!pair(arg) || typeof arg[1] !== 'string') return fail('match: needs a path and a pattern')
      if (!okPath(arg[0])) fail('match: bad path')
      else if (!okPattern(arg[1])) fail('match: bad pattern')
    }
  }
  walk(w, 1)
  return nodes > WHEN_LIMITS.nodes ? ['too many conditions'] : errors
}

// The value at a path: only what the context itself holds, never an inherited name.
const at = (ctx: unknown, path: unknown): unknown => {
  if (!okPath(path)) return undefined
  let cur = ctx
  for (const name of path.split('.')) {
    if (typeof cur !== 'object' || cur === null) return undefined
    if (Array.isArray(cur) && !INDEX.test(name)) return undefined
    if (!Object.prototype.propertyIsEnumerable.call(cur, name)) return undefined
    cur = (cur as Record<string, unknown>)[name]
  }
  return cur
}

const scalar = (v: unknown): v is Literal =>
  v === null || ['string', 'number', 'boolean'].includes(typeof v)

// True, false, or null for a condition that isn't one or holds more than `budget.nodes` of them.
const run = (
  w: unknown,
  ctx: unknown,
  match: Matcher,
  depth: number,
  budget: { nodes: number }
): boolean | null => {
  budget.nodes -= 1
  if (!record(w) || depth > WHEN_LIMITS.depth || budget.nodes < 0) return null
  const keys = Object.keys(w)
  if (keys.length !== 1) return null
  const op = keys[0]
  const arg = w[op]
  if (op === 'all' || op === 'any') {
    if (!Array.isArray(arg)) return null
    let out = op === 'all'
    for (const child of arg) {
      const v = run(child, ctx, match, depth + 1, budget)
      if (v === null) return null
      out = op === 'all' ? out && v : out || v
    }
    return out
  }
  if (op === 'not') {
    const v = run(arg, ctx, match, depth + 1, budget)
    return v === null ? null : !v
  }
  if (op === 'has') {
    if (!okPath(arg)) return null
    const v = at(ctx, arg)
    return v !== undefined && v !== null
  }
  if (!pair(arg)) return null
  const left = at(ctx, arg[0])
  if (op === 'eq') {
    const right = record(arg[1]) ? at(ctx, arg[1].path) : arg[1]
    return scalar(left) && scalar(right) && left === right
  }
  if (op === 'in') {
    if (!Array.isArray(arg[1]) || arg[1].length > WHEN_LIMITS.list) return null
    return scalar(left) && arg[1].includes(left)
  }
  if (op === 'match') {
    if (!okPattern(arg[1])) return null
    if (typeof left !== 'string' || left.length > WHEN_LIMITS.text) return false
    try {
      return match(arg[1], left) === true
    } catch {
      return false
    }
  }
  return null
}

export const evalWhen = (w: When, ctx: unknown, match: Matcher): boolean =>
  run(w, ctx, match, 1, { nodes: WHEN_LIMITS.nodes }) === true

// Every pattern a condition runs, in order, for the matcher's caps.
export const patternsOf = (w: When): string[] => {
  if ('all' in w) return w.all.flatMap(patternsOf)
  if ('any' in w) return w.any.flatMap(patternsOf)
  if ('not' in w) return patternsOf(w.not)
  return 'match' in w ? [w.match[1]] : []
}
