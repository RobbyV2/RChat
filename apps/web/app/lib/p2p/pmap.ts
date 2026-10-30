// A persistent (immutable) hash map with string keys: a hash array mapped trie. Every change
// returns a new map that shares all untouched nodes with the old one, so state resolution can keep
// the state at every event's position for the price of a few small nodes per event, and two
// states that share most of their history are compared in time proportional to what differs.

interface Leaf<V> {
  t: 0
  h: number
  k: string
  v: V
}

interface Branch<V> {
  t: 1
  bm: number
  a: Entry<V>[]
}

// Keys whose hashes are equal in all 32 bits.
interface Coll<V> {
  t: 2
  h: number
  a: Leaf<V>[]
}

type Entry<V> = Leaf<V> | Branch<V> | Coll<V>

const BITS = 5
const MASK = 31

// FNV-1a over the key, remembered per key (the engine's own string hashing finds it again much
// faster than this loop runs), and the last one at hand (lookups of one key come in runs).
const hashes = new Map<string, number>()
let lastKey = ''
let lastHash = 0x811c9dc5

export const hashKey = (k: string) => {
  if (k === lastKey) return lastHash
  let h = hashes.get(k)
  if (h === undefined) {
    h = 0x811c9dc5
    for (let i = 0; i < k.length; i += 1) {
      h ^= k.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h >>>= 0
    if (hashes.size >= 200_000) hashes.clear()
    hashes.set(k, h)
  }
  lastKey = k
  lastHash = h
  return h
}

const popcount = (x: number) => {
  x -= (x >>> 1) & 0x55555555
  x = (x & 0x33333333) + ((x >>> 2) & 0x33333333)
  return (((x + (x >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24
}

const hashOf = <V>(e: Leaf<V> | Coll<V>) => e.h

// A branch (at `shift`) holding two entries with different keys.
const join = <V>(x: Leaf<V> | Coll<V>, y: Leaf<V>, shift: number): Entry<V> => {
  const hx = hashOf(x)
  if (hx === y.h) {
    const leaves = x.t === 2 ? x.a : [x]
    return { t: 2, h: hx, a: [...leaves, y] }
  }
  const ix = (hx >>> shift) & MASK
  const iy = (y.h >>> shift) & MASK
  if (ix === iy) return { t: 1, bm: 1 << ix, a: [join(x, y, shift + BITS)] }
  return { t: 1, bm: (1 << ix) | (1 << iy), a: ix < iy ? [x, y] : [y, x] }
}

const setIn = <V>(node: Entry<V>, leaf: Leaf<V>, shift: number, added: { n: number }): Entry<V> => {
  if (node.t === 0) {
    if (node.k === leaf.k) return node.v === leaf.v ? node : leaf
    added.n = 1
    return join(node, leaf, shift)
  }
  if (node.t === 2) {
    if (node.h !== leaf.h) {
      added.n = 1
      return join(node, leaf, shift)
    }
    const i = node.a.findIndex(l => l.k === leaf.k)
    if (i >= 0) {
      if (node.a[i].v === leaf.v) return node
      const a = node.a.slice()
      a[i] = leaf
      return { t: 2, h: node.h, a }
    }
    added.n = 1
    return { t: 2, h: node.h, a: [...node.a, leaf] }
  }
  const bit = 1 << ((leaf.h >>> shift) & MASK)
  const idx = popcount(node.bm & (bit - 1))
  if (!(node.bm & bit)) {
    added.n = 1
    const a = node.a.slice()
    a.splice(idx, 0, leaf)
    return { t: 1, bm: node.bm | bit, a }
  }
  const child = node.a[idx]
  const next = setIn(child, leaf, shift + BITS, added)
  if (next === child) return node
  const a = node.a.slice()
  a[idx] = next
  return { t: 1, bm: node.bm, a }
}

// The entry without `k`, null when nothing is left, the same entry when `k` isn't there.
const deleteIn = <V>(node: Entry<V>, h: number, k: string, shift: number): Entry<V> | null => {
  if (node.t === 0) return node.k === k ? null : node
  if (node.t === 2) {
    if (node.h !== h) return node
    const a = node.a.filter(l => l.k !== k)
    if (a.length === node.a.length) return node
    return a.length === 1 ? a[0] : { t: 2, h: node.h, a }
  }
  const bit = 1 << ((h >>> shift) & MASK)
  if (!(node.bm & bit)) return node
  const idx = popcount(node.bm & (bit - 1))
  const child = node.a[idx]
  const next = deleteIn(child, h, k, shift + BITS)
  if (next === child) return node
  if (next === null) {
    if (node.a.length === 1) return null
    const a = node.a.slice()
    a.splice(idx, 1)
    // A branch left with one leaf (not at the root) becomes that leaf.
    if (a.length === 1 && a[0].t !== 1 && shift > 0) return a[0]
    return { t: 1, bm: node.bm & ~bit, a }
  }
  const a = node.a.slice()
  a[idx] = next
  return { t: 1, bm: node.bm, a }
}

function* leavesOf<V>(node: Entry<V> | null): Generator<Leaf<V>> {
  if (!node) return
  if (node.t === 0) yield node
  else if (node.t === 2) yield* node.a
  else for (const c of node.a) yield* leavesOf(c)
}

const childAt = <V>(node: Branch<V>, i: number): Entry<V> | null => {
  const bit = 1 << i
  return node.bm & bit ? node.a[popcount(node.bm & (bit - 1))] : null
}

const diffIn = <V>(
  x: Entry<V> | null,
  y: Entry<V> | null,
  shift: number,
  cb: (k: string, a: V | undefined, b: V | undefined) => void
) => {
  if (x === y) return
  if (x && y && x.t === 1 && y.t === 1) {
    const bm = x.bm | y.bm
    for (let i = 0; i < 32; i += 1)
      if (bm & (1 << i)) diffIn(childAt(x, i), childAt(y, i), shift + BITS, cb)
    return
  }
  const left = new Map<string, V>()
  for (const l of leavesOf(x)) left.set(l.k, l.v)
  for (const l of leavesOf(y)) {
    const a = left.get(l.k)
    if (a === undefined) cb(l.k, undefined, l.v)
    else {
      left.delete(l.k)
      if (a !== l.v) cb(l.k, a, l.v)
    }
  }
  for (const [k, v] of left) cb(k, v, undefined)
}

export class PMap<V> {
  private constructor(
    private readonly root: Entry<V> | null,
    readonly size: number
  ) {}

  static empty<V>(): PMap<V> {
    return new PMap<V>(null, 0)
  }

  static of<V>(entries: Iterable<[string, V]>): PMap<V> {
    let m = PMap.empty<V>()
    for (const [k, v] of entries) m = m.set(k, v)
    return m
  }

  get(k: string): V | undefined {
    let node = this.root
    const h = hashKey(k)
    let shift = 0
    while (node) {
      if (node.t === 0) return node.k === k ? node.v : undefined
      if (node.t === 2) return node.a.find(l => l.k === k)?.v
      const bit = 1 << ((h >>> shift) & MASK)
      if (!(node.bm & bit)) return undefined
      node = node.a[popcount(node.bm & (bit - 1))]
      shift += BITS
    }
    return undefined
  }

  has(k: string) {
    return this.get(k) !== undefined
  }

  set(k: string, v: V): PMap<V> {
    const leaf: Leaf<V> = { t: 0, h: hashKey(k), k, v }
    if (!this.root) return new PMap<V>(leaf, 1)
    const added = { n: 0 }
    const root = setIn(this.root, leaf, 0, added)
    return root === this.root ? this : new PMap<V>(root, this.size + added.n)
  }

  delete(k: string): PMap<V> {
    if (!this.root) return this
    const root = deleteIn(this.root, hashKey(k), k, 0)
    return root === this.root ? this : new PMap<V>(root, this.size - 1)
  }

  *entries(): Generator<[string, V]> {
    for (const l of leavesOf(this.root)) yield [l.k, l.v]
  }

  *keys(): Generator<string> {
    for (const l of leavesOf(this.root)) yield l.k
  }

  *values(): Generator<V> {
    for (const l of leavesOf(this.root)) yield l.v
  }

  [Symbol.iterator]() {
    return this.entries()
  }

  forEach(fn: (v: V, k: string, m: PMap<V>) => void) {
    for (const l of leavesOf(this.root)) fn(l.v, l.k, this)
  }

  // Calls `cb` for every key whose value differs (undefined: absent on that side). Subtrees the
  // two maps share are skipped, so maps derived from each other compare in time proportional to
  // their differences.
  static diff<V>(
    a: PMap<V>,
    b: PMap<V>,
    cb: (k: string, a: V | undefined, b: V | undefined) => void
  ) {
    diffIn(a.root, b.root, 0, cb)
  }
}
