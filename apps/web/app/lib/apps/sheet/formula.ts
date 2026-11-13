// The sheet's formula evaluator for devices where WebAssembly can't run. It computes a core set of
// functions the way the full engine does. Anything else is NEEDS_WASM in the cell, never a guess.

export type CellVal = number | string | boolean | null | { err: string }
export const NEEDS_WASM = '#WASM'

type Tok = {
  t: 'num' | 'str' | 'ref' | 'range' | 'fn' | 'op' | 'bool' | '(' | ')' | ','
  v: string
}

const colNum = (s: string) => [...s].reduce((n, c) => n * 26 + c.charCodeAt(0) - 64, 0)

const MAX_ROW = 1048576
const MAX_COL = 16384

export const addr = (ref: string): [number, number] => {
  const m = /^\$?([A-Z]{1,3})\$?(\d{1,7})$/.exec(ref)
  if (!m) throw new Error('ref')
  const at: [number, number] = [Number(m[2]), colNum(m[1])]
  if (at[0] < 1 || at[0] > MAX_ROW || at[1] > MAX_COL) throw new Error('ref')
  return at
}

// A number at 15 significant digits, a half going to the even digit: what comparisons and ROUND see.
const digits15 = (n: number): number => {
  if (n === 0 || !Number.isFinite(n)) return n
  const up = Number(n.toExponential(14))
  if (!/5e/.test(n.toExponential(15))) return up
  const [m, e] = n.toExponential(60).split('e')
  const d = m.replace('-', '').replace('.', '')
  if (!/^50*$/.test(d.slice(15)) || (d.charCodeAt(14) - 48) % 2) return up
  return Number(`${n < 0 ? '-' : ''}${d[0]}.${d.slice(1, 15)}e${e}`)
}

// A number with so many decimals, a half going to the even digit.
const fixed = (n: number, decimals: number): string => {
  if (!Number.isFinite(n)) return Number.isNaN(n) ? 'NaN' : n < 0 ? '-inf' : 'inf'
  const a = Math.abs(n)
  const long = a.toFixed(decimals + 40)
  const cut = long.slice(0, -40)
  const even = (cut.charCodeAt(cut.length - 1) - 48) % 2 === 0
  const text = /^50*$/.test(long.slice(-40)) && even ? cut : a.toFixed(decimals)
  return n < 0 ? `-${text}` : text
}

// Whether a power is a number held exactly, so that every engine computes the same one.
const held = (a: number, b: number, x: number): boolean => {
  if (b === 1 || a === 0) return true
  if (!Number.isInteger(b) || Math.abs(x) < 2 ** -1022) return false
  let odd = Math.abs(a)
  while (!Number.isInteger(odd)) odd *= 2
  while (odd % 2 === 0) odd /= 2
  if (odd === 1) return true
  if (b < 0) return false
  let whole = 1
  for (let i = 0; i < b; i++) {
    whole *= odd
    if (whole >= 2 ** 53) return false
  }
  return true
}

// Decimal places where the full engine's own power of ten is not the nearest number to it.
const OFF_PLACES = [-5, -11]

// Whether two digit strings of the same length are equally near the number: the engines then pick differently.
const tied = (a: number): boolean => {
  const s = String(a)
  const dot = s.indexOf('.')
  if (dot < 0) {
    if (a < 2 ** 53) return false
    return /^50*$/.test(BigInt(a).toString().slice(s.replace(/0+$/, '').length))
  }
  return /^50*$/.test(a.toFixed(s.length - dot + 39).slice(-40))
}

const lex = (src: string): Tok[] => {
  const out: Tok[] = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === ' ') {
      i++
      continue
    }
    if (c === '"') {
      let j = i + 1
      let v = ''
      while (j < src.length) {
        if (src[j] === '"' && src[j + 1] === '"') {
          v += '"'
          j += 2
          continue
        }
        if (src[j] === '"') break
        v += src[j++]
      }
      if (j >= src.length) throw new Error('quote')
      out.push({ t: 'str', v })
      i = j + 1
      continue
    }
    const rest = src.slice(i)
    const num = /^(\d+(\.\d+)?([eE][+-]?\d+)?|\.\d+)/.exec(rest)
    if (num) {
      const n = Number(num[0])
      if (!Number.isFinite(n) || n !== Number(n.toPrecision(15))) throw new Error('number')
      out.push({ t: 'num', v: num[0] })
      i += num[0].length
      continue
    }
    const range = /^(\$?[A-Za-z]{1,3}\$?\d{1,7}):(\$?[A-Za-z]{1,3}\$?\d{1,7})/.exec(rest)
    if (range) {
      out.push({ t: 'range', v: range[0].toUpperCase() })
      i += range[0].length
      continue
    }
    const word = /^\$?[A-Za-z_][A-Za-z0-9_.$]*/.exec(rest)
    if (word) {
      const w = word[0]
      i += w.length
      if (src[i] === '(') out.push({ t: 'fn', v: w.toUpperCase() })
      else if (/^(TRUE|FALSE)$/i.test(w)) out.push({ t: 'bool', v: w.toUpperCase() })
      else out.push({ t: 'ref', v: w.toUpperCase() })
      continue
    }
    const two = src.slice(i, i + 2)
    if (two === '<=' || two === '>=' || two === '<>') {
      out.push({ t: 'op', v: two })
      i += 2
      continue
    }
    if ('+-*/^&=<>%'.includes(c)) out.push({ t: 'op', v: c })
    else if (c === '(' || c === ')' || c === ',') out.push({ t: c, v: c })
    else throw new Error('char')
    i++
  }
  return out
}

type Cell = [number, number]
type RefNode = { k: 'ref'; r: Cell }
type RangeNode = { k: 'range'; a: Cell; b: Cell }
type Node =
  | { k: 'lit'; v: CellVal }
  | RefNode
  | RangeNode
  | { k: 'fn'; name: string; args: Node[] }
  | { k: 'un'; op: string; e: Node }
  | { k: 'bin'; op: string; l: Node; r: Node }

const PREC: Record<string, number> = {
  '=': 1,
  '<>': 1,
  '<': 1,
  '<=': 1,
  '>': 1,
  '>=': 1,
  '&': 2,
  '+': 3,
  '-': 3,
  '*': 4,
  '/': 4,
  '^': 5,
}

// How many levels deep a cell's formulas may go, counted over every formula from the cell asked
// for to the last one it reads, before the full engine is asked for. A function counts two: it
// takes about twice the stack.
const MAX_DEPTH = 768

// Why an evaluation stops early. NEED: the cell needs the full engine, and so does every cell
// that reads it. DEEP: the formulas read deeper than MAX_DEPTH from the cell asked for.
const NEED = { stop: 'need' }
const DEEP = { stop: 'deep' }

const need = (): never => {
  throw NEED
}

const parse = (toks: Tok[]): Node => {
  let p = 0
  let nest = 0
  const expr = (min: number): Node => {
    let l = unary()
    for (;;) {
      const t = toks[p]
      if (!t || t.t !== 'op' || !(t.v in PREC) || PREC[t.v] < min) return l
      p++
      const r = expr(PREC[t.v] + 1)
      l = { k: 'bin', op: t.v, l, r }
    }
  }
  const unary = (): Node => {
    if (++nest > MAX_DEPTH) throw DEEP
    const t = toks[p]
    let e: Node
    if (t?.t === 'op' && (t.v === '-' || t.v === '+')) {
      p++
      e = t.v === '+' ? unary() : { k: 'un', op: t.v, e: unary() }
    } else {
      e = atom()
      while (toks[p]?.t === 'op' && toks[p].v === '%') {
        p++
        e = { k: 'bin', op: '/', l: e, r: { k: 'lit', v: 100 } }
      }
    }
    nest--
    return e
  }
  const atom = (): Node => {
    const t = toks[p++]
    if (!t) throw new Error('end')
    if (t.t === 'num') return { k: 'lit', v: Number(t.v) }
    if (t.t === 'str') return { k: 'lit', v: t.v }
    if (t.t === 'bool') return { k: 'lit', v: t.v === 'TRUE' }
    if (t.t === 'ref') return { k: 'ref', r: addr(t.v) }
    if (t.t === 'range') {
      const [a, b] = t.v.split(':').map(addr)
      return {
        k: 'range',
        a: [Math.min(a[0], b[0]), Math.min(a[1], b[1])],
        b: [Math.max(a[0], b[0]), Math.max(a[1], b[1])],
      }
    }
    if (t.t === '(') {
      const e = expr(0)
      if (toks[p++]?.t !== ')') throw new Error(')')
      return e
    }
    if (t.t === 'fn') {
      p++
      const args: Node[] = []
      if (toks[p]?.t !== ')') {
        args.push(expr(0))
        while (toks[p]?.t === ',') {
          p++
          args.push(expr(0))
        }
      }
      if (toks[p++]?.t !== ')') throw new Error(')')
      return { k: 'fn', name: t.v, args }
    }
    throw new Error('atom')
  }
  const e = expr(0)
  if (p !== toks.length) throw new Error('rest')
  return e
}

// How many levels deep a formula goes, counted without recursion.
const depth = (root: Node): number => {
  let most = 0
  const todo: [Node, number][] = [[root, 0]]
  for (let next = todo.pop(); next; next = todo.pop()) {
    const [n, above] = next
    const d = above + (n.k === 'fn' ? 2 : 1)
    most = Math.max(most, d)
    if (n.k === 'un') todo.push([n.e, d])
    else if (n.k === 'bin') todo.push([n.l, d], [n.r, d])
    else if (n.k === 'fn') for (const a of n.args) todo.push([a, d])
  }
  return most
}

// Each core function with the fewest and the most arguments it takes.
const ARITY: Record<string, [number, number]> = {
  SUM: [1, Infinity],
  AVERAGE: [1, Infinity],
  MIN: [0, Infinity],
  MAX: [0, Infinity],
  COUNT: [1, Infinity],
  COUNTA: [1, Infinity],
  IF: [2, 3],
  AND: [1, Infinity],
  OR: [1, Infinity],
  NOT: [1, 1],
  ROUND: [2, 2],
  ABS: [1, 1],
  LEN: [1, 1],
  CONCAT: [0, Infinity],
  UPPER: [1, 1],
  LOWER: [1, 1],
  IFERROR: [2, 2],
  SUMIF: [2, 3],
  VLOOKUP: [3, 4],
}

export const FALLBACK_FUNCTIONS = Object.keys(ARITY)

type Err = { err: string }

const isErr = (v: unknown): v is Err => typeof v === 'object' && v !== null && 'err' in v
const E = (err: string): Err => ({ err })
const needs = (v: unknown): v is Err => isErr(v) && v.err === NEEDS_WASM
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/
// Text the full engine may read as a number in a way this one does not: 1,000 or $5 or 50% or a date.
const NUMBER_LIKE = /^[\d+\-.($£€¥]/
const SPACE =
  '[\\t\\n\\v\\f\\r \\u0085\\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000]'
const EDGES = new RegExp(`^${SPACE}+|${SPACE}+$`, 'g')
const ERRORS = [
  '#REF!',
  '#NAME?',
  '#VALUE!',
  '#DIV/0!',
  '#N/A',
  '#NUM!',
  '#ERROR!',
  '#N/IMPL!',
  '#SPILL!',
  '#CALC!',
  '#CIRC!',
  '#NULL!',
]

const trim = (s: string) => s.replace(EDGES, '')

const exact = (s: string): number | null => {
  const n = DECIMAL.test(s) ? Number(s) : NaN
  return Number.isFinite(n) ? n : null
}

const decimal = (s: string): number | null => exact(trim(s))

const dateLike = (t: string): boolean => {
  const parts = t.split(t.includes('/') ? '/' : t.includes('-') ? '-' : '.')
  return parts.length === 3 && /^\d+$/.test(trim(parts[2]))
}

// Whether the full engine may read the text in a formula as an amount, a share, a date or a time.
const numberLike = (s: string): boolean => {
  const t = trim(s)
  return NUMBER_LIKE.test(t) || /[%$€]$/.test(t) || dateLike(t)
}

// Whether the full engine may read what is typed into a cell as an amount, a share, a date or a formula.
const typedLike = (s: string): boolean => {
  const t = trim(s)
  const digits = (x: string) => /^[\d.,eE+-]+$/.test(x) && /\d/.test(x)
  const bare = trim(
    t
      .replace(/%$/, '')
      .replace(/^(-?)[$€]/, '$1')
      .replace(/[$€]$/, '')
  )
  return /^[+-]./.test(t) || digits(bare) || dateLike(t)
}

// What is typed into a cell that holds no formula. A number typed with a power of ten is shown
// in powers of ten by the full engine, and so is what reads it.
const typed = (input: string): CellVal => {
  if (input.startsWith("'")) return input === "'" ? E(NEEDS_WASM) : input.slice(1)
  const n = decimal(input)
  if (n !== null) return /e/i.test(input) ? E(NEEDS_WASM) : n
  if (/^(TRUE|FALSE)$/i.test(input)) return input.toUpperCase() === 'TRUE'
  if (ERRORS.includes(input.toUpperCase())) return E(input.toUpperCase())
  return typedLike(input) ? E(NEEDS_WASM) : input
}

// A formula as it was typed, read to at most MAX_DEPTH levels, and how many levels deep it goes.
// It is read when it is typed, on a short stack, so that whether it can be read never depends on
// how deep the cell that first reads it is.
type Form = { input: string; ast: Node | null; d: number }

const read = (input: string): Form => {
  try {
    const ast = parse(lex(input.slice(1)))
    return { input, ast, d: depth(ast) }
  } catch {
    return { input, ast: null, d: 0 }
  }
}

// A cell's value, and how many levels deep its formulas go.
type Entry = { v: CellVal; h: number }

const BLANK: Entry = { v: null, h: 0 }
const CIRCLE: Entry = { v: E(NEEDS_WASM), h: 0 }

// Cells by number, in row order.
const WIDE = MAX_COL + 1

const first = (sorted: number[], x: number): number => {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (sorted[mid] < x) lo = mid + 1
    else hi = mid
  }
  return lo
}

export class FallbackSheet {
  inputs = new Map<string, string>()
  private cache = new Map<string, Entry>()
  private forms = new Map<string, Form>()
  private open = new Set<string>()
  private heights: number[] = []
  private weight = 0
  private root: Node | null = null
  private order: number[] | null = null

  set(r: number, c: number, input: string) {
    const k = `${r},${c}`
    if (input === '') this.inputs.delete(k)
    else this.inputs.set(k, input)
    if (input.startsWith('=') && input !== '=') this.forms.set(k, read(input))
    else this.forms.delete(k)
    this.cache.clear()
    this.order = null
  }

  value(r: number, c: number): CellVal {
    try {
      return this.entry(r, c).v
    } catch {
      return E(NEEDS_WASM)
    }
  }

  // A cell that reads one of the cells being computed, or reads too deep, needs the full engine.
  // What a formula computes is kept until a cell changes; it never depends on what was asked first.
  private entry(r: number, c: number): Entry {
    const k = `${r},${c}`
    const hit = this.cache.get(k)
    if (hit) return hit
    const input = this.inputs.get(k)
    if (input === undefined) return BLANK
    if (!input.startsWith('=') || input === '=') return { v: typed(input), h: 0 }
    if (this.open.has(k)) return CIRCLE
    const form = this.forms.get(k)
    const { ast, d } = form?.input === input ? form : read(input)
    let v: CellVal = E(NEEDS_WASM)
    let below = 0
    if (ast && d <= MAX_DEPTH) {
      if (this.weight + d > MAX_DEPTH) throw DEEP
      if (!uneven(ast)) {
        const outer = this.root
        this.open.add(k)
        this.weight += d
        this.heights.push(0)
        this.root = ast
        try {
          const x = this.ev(ast)
          v = x === null ? 0 : x
        } catch (e) {
          if (e !== NEED) throw e
        } finally {
          this.root = outer
          this.open.delete(k)
          this.weight -= d
          below = this.heights.pop() ?? 0
        }
      }
    }
    const entry = { v, h: d + below }
    this.cache.set(k, entry)
    return entry
  }

  // A cell read by the formula being computed.
  private at(r: number, c: number): CellVal {
    const { v, h } = this.entry(r, c)
    if (needs(v)) return need()
    if (this.weight + h > MAX_DEPTH) throw DEEP
    const top = this.heights.length - 1
    this.heights[top] = Math.max(this.heights[top], h)
    return v
  }

  // Every filled cell of a range, row by row, until `visit` says to stop. A blank cell has no
  // formula to compute, so a range costs no more than the cells filled in it.
  private scan(n: RangeNode, visit: (r: number, c: number) => boolean | void) {
    const [top, left] = n.a
    const [bottom, right] = n.b
    if ((bottom - top + 1) * (right - left + 1) <= this.inputs.size) {
      for (let r = top; r <= bottom; r++)
        for (let c = left; c <= right; c++) if (this.inputs.has(`${r},${c}`) && visit(r, c)) return
      return
    }
    if (!this.order)
      this.order = [...this.inputs.keys()]
        .map(k => {
          const [r, c] = k.split(',').map(Number)
          return r * WIDE + c
        })
        .sort((x, y) => x - y)
    for (let i = first(this.order, top * WIDE); i < this.order.length; i++) {
      const r = Math.floor(this.order[i] / WIDE)
      const c = this.order[i] % WIDE
      if (r > bottom) return
      if (c >= left && c <= right && visit(r, c)) return
    }
  }

  // The values of a cell, or of the filled cells of a range in row order, until `visit` gives
  // something back.
  private each<T>(n: RefNode | RangeNode, visit: (v: CellVal) => T | undefined): T | undefined {
    if (n.k === 'ref') return visit(this.at(n.r[0], n.r[1]))
    let out: T | undefined
    this.scan(n, (r, c) => (out = visit(this.at(r, c))) !== undefined)
    return out
  }

  // A result too large for a number: an error where the cell ends, and the full engine's to carry on with.
  private sized(n: number, at: Node): number | Err {
    if (Number.isFinite(n)) return n
    return at === this.root ? E('#NUM!') : need()
  }

  private num(v: CellVal): number | Err {
    if (isErr(v)) return v
    if (typeof v === 'number') return v
    if (typeof v === 'boolean') return v ? 1 : 0
    if (v === null) return 0
    const n = decimal(v)
    if (n !== null) return n
    return numberLike(v) ? need() : E('#VALUE!')
  }

  private text(v: CellVal): string | Err {
    if (v === null) return ''
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
    if (typeof v === 'number') {
      const a = Math.abs(v)
      const own = Object.is(v, -0) || a >= 1e21 || (a < 1e-6 && a > 0)
      return own || tied(a) ? need() : String(v)
    }
    return v
  }

  private truth(v: CellVal): boolean | Err {
    if (isErr(v) || typeof v === 'boolean') return v
    if (typeof v === 'number') return v !== 0
    if (v === null) return false
    return /^(TRUE|FALSE)$/i.test(v) ? v.toUpperCase() === 'TRUE' : E('#VALUE!')
  }

  private join(vs: CellVal[]): string | Err {
    let out = ''
    for (const v of vs) {
      const t = this.text(v)
      if (isErr(t)) return t
      out += t
    }
    return out
  }

  // The numbers of the arguments, as SUM reads them: in a range or a cell only the numbers count,
  // and the first error ends the reading.
  private nums(args: Node[]): number[] | Err {
    const out: number[] = []
    for (const a of args) {
      if (a.k === 'range' || a.k === 'ref') {
        const err = this.each(a, v => {
          if (isErr(v)) return v
          if (typeof v === 'number') out.push(v)
        })
        if (err) return err
        continue
      }
      const e = this.ev(a)
      if (e === null) continue
      const v = this.num(e)
      if (isErr(v)) return v
      out.push(v)
    }
    return out
  }

  // What a function that takes a range makes of anything else: its error, or #VALUE!.
  private lone(n: Node): CellVal {
    const v = this.ev(n)
    return isErr(v) ? v : E('#VALUE!')
  }

  private ev(n: Node): CellVal {
    switch (n.k) {
      case 'lit':
        return n.v
      case 'ref':
        return this.at(n.r[0], n.r[1])
      case 'range':
        return need()
      case 'un': {
        const v = this.num(this.ev(n.e))
        return isErr(v) ? v : n.op === '-' ? -v : v
      }
      case 'bin': {
        const l = this.ev(n.l)
        const r = this.ev(n.r)
        if (isErr(l)) return l
        const text = n.op === '&' || n.op in COMPARE
        const a = text ? 0 : this.num(l)
        if (isErr(a)) return a
        if (isErr(r)) return r
        if (n.op === '&') return this.join([l, r])
        if (n.op in COMPARE) return compare(n.op, l, r)
        const b = this.num(r)
        if (isErr(b)) return b
        if (n.op === '+') return this.sized(a + b, n)
        if (n.op === '-') return this.sized(a - b, n)
        if (n.op === '*') return this.sized(a * b, n)
        if (n.op === '/') return b === 0 ? E('#DIV/0!') : this.sized(a / b, n)
        if (a === 0 && b === 0) return E('#NUM!')
        if (b === 0) return 1
        if (a < 0 && !Number.isInteger(b)) return need()
        const x = Math.pow(a, b)
        if (Number.isNaN(x)) return E('#NUM!')
        if (!Number.isFinite(x)) return E('#DIV/0!')
        return held(a, b, x) ? x : need()
      }
      case 'fn':
        return this.call(n, n.name, n.args)
    }
  }

  private call(at: Node, name: string, args: Node[]): CellVal {
    if (!(name in ARITY)) return need()
    if (args.length < ARITY[name][0] || args.length > ARITY[name][1]) return E('#ERROR!')
    switch (name) {
      case 'SUM': {
        const xs = this.nums(args)
        return isErr(xs) ? xs : this.sized(sum(xs), at)
      }
      case 'AVERAGE': {
        const xs = this.nums(args)
        if (isErr(xs)) return xs
        return xs.length ? this.sized(sum(xs) / xs.length, at) : E('#DIV/0!')
      }
      case 'MIN':
      case 'MAX': {
        const xs = this.nums(args)
        if (isErr(xs)) return xs
        const pick = name === 'MIN' ? Math.min : Math.max
        return xs.length ? xs.reduce((m, x) => pick(m, x)) : 0
      }
      case 'COUNT':
      case 'COUNTA': {
        let count = 0
        for (const a of args) {
          if (a.k === 'range' || a.k === 'ref') {
            this.each(a, v => {
              if (name === 'COUNT' ? typeof v === 'number' : v !== null) count++
            })
            continue
          }
          const v = this.ev(a)
          if (name === 'COUNTA') {
            if (v !== null) count++
          } else if (typeof v === 'number' || typeof v === 'boolean') count++
          else if (typeof v === 'string') {
            if (exact(v) !== null) count++
            else if (numberLike(v)) return need()
          }
        }
        return count
      }
      case 'IF': {
        const t = this.truth(this.ev(args[0]))
        if (isErr(t)) return t
        return t ? this.ev(args[1]) : args[2] ? this.ev(args[2]) : false
      }
      case 'AND':
      case 'OR': {
        const stop = name === 'OR'
        let seen = false
        const weigh = (v: CellVal, cell: boolean): CellVal | undefined => {
          if (isErr(v)) return v
          let b: boolean
          if (typeof v === 'boolean') b = v
          else if (typeof v === 'number') b = v !== 0
          else if (!cell && typeof v === 'string' && /^(TRUE|FALSE)$/i.test(v))
            b = v.toUpperCase() === 'TRUE'
          else return undefined
          if (b === stop) return stop
          seen = true
          return undefined
        }
        for (const a of args) {
          const cells = a.k === 'range' || a.k === 'ref'
          const end = cells ? this.each(a, v => weigh(v, true)) : weigh(this.ev(a), false)
          if (end !== undefined) return end
        }
        return seen ? !stop : E('#VALUE!')
      }
      case 'NOT': {
        const t = this.truth(this.ev(args[0]))
        return isErr(t) ? t : !t
      }
      case 'ROUND': {
        const x = this.num(this.ev(args[0]))
        if (isErr(x)) return x
        const d = this.num(this.ev(args[1]))
        if (isErr(d)) return d
        const v = digits15(x)
        const places = Math.trunc(d)
        if (places < -323) return 0
        if (places > 308) return v
        const scale = Number(`1e${places}`)
        const scaled = v * scale
        if (!Number.isFinite(scaled)) return v
        if (Math.abs(places) > 22 || OFF_PLACES.includes(places))
          return Math.abs(scaled) < 0.4 ? scaled * 0 : need()
        const near = digits15(scaled)
        const y = (Math.sign(near) * Math.round(Math.abs(near))) / scale
        return Number.isFinite(y) ? y : E('#NUM!')
      }
      case 'ABS': {
        const x = this.num(this.ev(args[0]))
        return isErr(x) ? x : Math.abs(x)
      }
      case 'LEN': {
        const t = this.text(this.ev(args[0]))
        return isErr(t) ? t : [...t].length
      }
      case 'CONCAT': {
        const vs: CellVal[] = []
        const add = (v: CellVal) => {
          if (isErr(v)) return v
          vs.push(v)
        }
        for (const a of args) {
          const err = a.k === 'range' ? this.each(a, add) : add(this.ev(a))
          if (err) return err
        }
        return this.join(vs)
      }
      case 'UPPER':
      case 'LOWER': {
        const t = this.text(this.ev(args[0]))
        if (isErr(t)) return t
        return name === 'UPPER' ? t.toUpperCase() : t.toLowerCase()
      }
      case 'IFERROR': {
        const v = this.ev(args[0])
        return isErr(v) ? this.ev(args[1]) : v
      }
      case 'SUMIF': {
        const [over, by, from] = args
        const crit = this.ev(by)
        const sums = from ?? over
        if (sums.k !== 'range') return this.lone(sums)
        if (over.k !== 'range') return this.lone(over)
        const test = isErr(crit) ? null : criterion(crit)
        if (!test) return need()
        const spots = new Set<number>()
        const mark = (n: RangeNode) =>
          this.scan(n, (r, c) => {
            spots.add((r - n.a[0]) * WIDE + c - n.a[1])
          })
        mark(sums)
        if (sums !== over) mark(over)
        let s = 0
        for (const spot of [...spots].sort((x, y) => x - y)) {
          const dr = Math.floor(spot / WIDE)
          const dc = spot % WIDE
          if (!test(this.at(over.a[0] + dr, over.a[1] + dc))) continue
          const x = this.at(sums.a[0] + dr, sums.a[1] + dc)
          if (isErr(x)) return x
          if (typeof x === 'number') s += x
        }
        return this.sized(s, at)
      }
      case 'VLOOKUP': {
        const key = this.ev(args[0])
        if (isErr(key)) return key
        const col = this.num(this.ev(args[2]))
        if (isErr(col)) return col
        const approx = args[3] ? this.ev(args[3]) : true
        const tab = args[1]
        if (tab.k !== 'range') return need()
        if (approx !== false && approx !== 0) return need()
        if (typeof key === 'string' && /[*?~]/.test(key)) return need()
        const [top, left] = tab.a
        const [bottom, right] = tab.b
        const index = Math.trunc(col)
        if (index < 1 || index > right - left + 1) return E('#REF!')
        const rows: number[] = []
        this.scan({ k: 'range', a: [top, left], b: [bottom, left] }, r => {
          rows.push(r)
        })
        const keys = rows.map(r => this.at(r, left))
        const found = (v: CellVal) =>
          typeof key === 'string'
            ? typeof v === 'string' && v.toLowerCase() === key.toLowerCase()
            : !isErr(v) && compare('=', v, key)
        let gap = top
        for (const r of rows) {
          if (r !== gap) break
          gap++
        }
        const hit = keys.findIndex(found)
        const row = Math.min(
          hit < 0 ? Infinity : rows[hit],
          gap <= bottom && found(null) ? gap : Infinity
        )
        return row === Infinity ? E('#N/A') : this.at(row, left + index - 1)
      }
    }
    return need()
  }
}

const COMPARE = { '=': 1, '<>': 1, '<': 1, '<=': 1, '>': 1, '>=': 1 }

const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0)

const order = (l: CellVal, r: CellVal): number => {
  if (typeof l === 'number' && typeof r === 'number') {
    const a = digits15(l)
    const b = digits15(r)
    return Math.abs(b - a) < Number.EPSILON ? 0 : a < b ? -1 : 1
  }
  if (typeof l === 'string' && typeof r === 'string') {
    const a = [...l.toUpperCase()]
    const b = [...r.toUpperCase()]
    for (let i = 0; i < a.length && i < b.length; i++) {
      const d = a[i].codePointAt(0)! - b[i].codePointAt(0)!
      if (d !== 0) return d
    }
    return a.length - b.length
  }
  const rank = (v: CellVal) => (typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2)
  return rank(l) !== rank(r) ? rank(l) - rank(r) : Number(l) - Number(r)
}

const compare = (op: string, l: CellVal, r: CellVal): boolean => {
  if (l === null) l = typeof r === 'number' ? 0 : typeof r === 'boolean' ? false : ''
  if (r === null) r = typeof l === 'number' ? 0 : typeof l === 'boolean' ? false : ''
  const d = order(l, r)
  if (op === '=') return d === 0
  if (op === '<>') return d !== 0
  if (op === '<') return d < 0
  if (op === '<=') return d <= 0
  if (op === '>') return d > 0
  return d >= 0
}

const sameShape = (a: RangeNode, b: RangeNode) =>
  Math.abs(a.a[0] - a.b[0]) === Math.abs(b.a[0] - b.b[0]) &&
  Math.abs(a.a[1] - a.b[1]) === Math.abs(b.a[1] - b.b[1])

// Whether a SUMIF anywhere in the formula sums over a range of another shape than the one it tests.
const uneven = (n: Node): boolean => {
  if (n.k === 'un') return uneven(n.e)
  if (n.k === 'bin') return uneven(n.l) || uneven(n.r)
  if (n.k !== 'fn') return false
  const [over, , from] = n.args
  if (n.name === 'SUMIF' && over?.k === 'range' && from?.k === 'range' && !sameShape(over, from))
    return true
  return n.args.some(uneven)
}

// What a SUMIF criterion asks of a cell, or null when only the full engine can tell.
const criterion = (crit: CellVal): ((v: CellVal) => boolean) | null => {
  if (crit === null) return null
  if (typeof crit === 'number') return v => near(v, crit)
  if (typeof crit !== 'string') return v => v === crit
  const m = /^(<=|>=|<>|=|<|>)?([\s\S]*)$/.exec(crit)!
  const op = m[1] ?? '='
  const what = m[2]
  const n = exact(what)
  if (n !== null) {
    if (op === '=') return v => near(v, n)
    if (op === '<>') return v => typeof v !== 'number' || Math.abs(v - n) > Number.EPSILON
    if (op === '<') return v => typeof v === 'number' && v < n
    if (op === '<=') return v => typeof v === 'number' && v <= n
    if (op === '>') return v => typeof v === 'number' && v > n
    return v => typeof v === 'number' && v >= n
  }
  if (/[*?~#]/.test(what) || (decimal(what) === null && numberLike(what))) return null
  if (/^(TRUE|FALSE)$/i.test(what)) {
    const b = what.toUpperCase() === 'TRUE'
    return op === '=' ? v => v === b : op === '<>' ? v => v !== b : null
  }
  if (what === '') {
    if (op === '=') return v => v === null || v === ''
    return op === '<>' ? v => v !== null : null
  }
  const low = what.toLowerCase()
  if (op === '<>') return v => typeof v === 'string' && v.toLowerCase() !== low
  return op === '=' ? v => typeof v === 'string' && v.toLowerCase() === low : null
}

// Whether a cell holds the number, as a number or as its text.
const near = (v: CellVal, n: number): boolean => {
  const x = typeof v === 'string' ? exact(v) : v
  return typeof x === 'number' && Math.abs(x - n) < Number.EPSILON
}

// The General number format: nine decimals, and powers of ten for the very large and the very small.
export const formatGeneral = (n: number): string => {
  const a = Math.abs(n)
  if (a === 0) return '0'
  const short = (s: string) => s.replace(/0+$/, '').replace(/\.$/, '')
  if (a >= 1e-8 && a < 1e11) return short(fixed(n, 9))
  const power = Math.floor(Math.log10(a))
  const digits = short(fixed(n / Number(`1e${power}`), 5))
  return `${digits}E${power < 0 ? '-' : '+'}${String(Math.abs(power)).padStart(2, '0')}`
}

export const show = (v: CellVal): string => {
  if (v === null) return ''
  if (isErr(v)) return v.err
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'
  return typeof v === 'number' ? formatGeneral(v) : v
}
