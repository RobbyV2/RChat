// The hook lock: a stable point's kinds, lane, permissions and the shapes of its input and
// output. A change to a point is the same, additive (the lock is rewritten) or breaking (the
// point needs a new major). Input goes from the host to plugins and output comes back, so their
// rules mirror each other.

type Base =
  | { type: 'object'; properties: Record<string, Schema>; required?: string[] }
  | { type: 'array'; items: Schema }
  | { type: 'map'; values: Schema }
  | { type: 'string' | 'number' | 'boolean'; enum?: (string | number | boolean)[] }
export type Schema = Base & { nullable?: boolean }

export interface PointLock {
  kinds: string[]
  lane: 'sync' | 'async'
  perms: string[]
  input: Schema
  output: Schema
}

export type Change = 'same' | 'additive' | 'breaking'

const worst = (a: Change, b: Change): Change =>
  a === 'breaking' || b === 'breaking'
    ? 'breaking'
    : a === 'additive' || b === 'additive'
      ? 'additive'
      : 'same'

const enumOf = (s: Schema) => ('enum' in s ? s.enum : undefined)

const diff = (a: Schema, b: Schema, dir: 'in' | 'out'): Change => {
  if (a.type !== b.type) return 'breaking'
  let c: Change = 'same'
  if (!a.nullable && b.nullable) c = dir === 'in' ? 'breaking' : 'additive'
  if (a.nullable && !b.nullable) c = dir === 'in' ? 'additive' : 'breaking'
  if (a.type === 'array' && b.type === 'array') return worst(c, diff(a.items, b.items, dir))
  if (a.type === 'map' && b.type === 'map') return worst(c, diff(a.values, b.values, dir))
  if (a.type === 'object' && b.type === 'object') {
    const ra = new Set(a.required ?? [])
    const rb = new Set(b.required ?? [])
    for (const k of Object.keys(a.properties)) {
      if (!(k in b.properties)) return 'breaking'
      c = worst(c, diff(a.properties[k], b.properties[k], dir))
      if (ra.has(k) && !rb.has(k)) c = worst(c, dir === 'in' ? 'breaking' : 'additive')
      if (!ra.has(k) && rb.has(k)) c = worst(c, dir === 'in' ? 'additive' : 'breaking')
    }
    for (const k of Object.keys(b.properties)) {
      if (k in a.properties) continue
      // Old plugins don't send a new required output field.
      if (dir === 'out' && rb.has(k)) return 'breaking'
      c = worst(c, 'additive')
    }
    return c
  }
  const ea = enumOf(a)
  const eb = enumOf(b)
  if (!ea && !eb) return c
  if (!ea || !eb) {
    // Plugins must ignore input values they don't know, so opening or closing an input enum is
    // additive. An output enum may open, never close.
    if (dir === 'in') return worst(c, 'additive')
    return worst(c, ea ? 'additive' : 'breaking')
  }
  const sa = new Set(ea)
  const sb = new Set(eb)
  const added = eb.some(v => !sa.has(v))
  const removed = ea.some(v => !sb.has(v))
  if (dir === 'in') return worst(c, added || removed ? 'additive' : 'same')
  // Old plugins may still return a removed output value.
  if (removed) return 'breaking'
  return worst(c, added ? 'additive' : 'same')
}

export const classifyChange = (a: PointLock, b: PointLock): Change => {
  if (a.lane !== b.lane) return 'breaking'
  if (a.kinds.some(k => !b.kinds.includes(k))) return 'breaking'
  // A permission's reach must not grow under an old grant.
  if (b.perms.some(p => !a.perms.includes(p))) return 'breaking'
  let c: Change = 'same'
  if (b.kinds.some(k => !a.kinds.includes(k))) c = 'additive'
  if (a.perms.some(p => !b.perms.includes(p))) c = worst(c, 'additive')
  c = worst(c, diff(a.input, b.input, 'in'))
  c = worst(c, diff(a.output, b.output, 'out'))
  return c
}
