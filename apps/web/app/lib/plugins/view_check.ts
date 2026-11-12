import { internalPath, openTarget } from './links'
import { netCovers, netHost } from './perm_text'

// A view is a tree of plain nodes the host draws with its own components. This checks one a
// plugin sent: known nodes and fields only, labels where a control needs one, and the caps.
// It does not read inside `markdown` and `html` text: the renderer cleans those and applies the
// link rule to every link and image in them.

export const VIEW_LIMITS = {
  depth: 32,
  nodes: 2000,
  chars: 100000,
  canvasWidth: 3840,
  canvasHeight: 2160,
  url: 2048,
  errors: 20,
} as const

export interface ViewOpts {
  // The plugin's grants; an https image needs a `net:` grant for its host.
  grants?: readonly string[]
  // Component points may hold the `original` node.
  component?: boolean
}

type Rec = Record<string, unknown>
type Check = (v: unknown, node: Rec, opts: ViewOpts) => boolean | string

const TONES = ['default', 'muted', 'primary', 'error', 'success']
const RESERVED = ['__proto__', 'constructor', 'prototype']
const NAME = /^[A-Za-z0-9_.:-]{1,64}$/
const ICON = /^[a-z0-9]+(-[a-z0-9]+)*$/
const ASSET = /^[A-Za-z0-9_.-]+(\/[A-Za-z0-9_.-]+)*$/
const COLOR = /^#[0-9a-f]{6}$/i
// A blob is named by an id in the plugin's own store, never by an address or a path.
const BLOB = /^[A-Za-z0-9_-]{1,128}$/

// A plain object, as postMessage makes one: not an array, a typed array, a wrapped string or a map.
const record = (v: unknown): v is Rec => {
  if (typeof v !== 'object' || v === null) return false
  const proto: unknown = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}
const str = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const bool = (v: unknown) => typeof v === 'boolean'
const filled = (v: unknown) => str(v) && v.trim().length > 0
const oneOf =
  (...choices: unknown[]): Check =>
  v =>
    choices.includes(v)
const name: Check = v => str(v) && NAME.test(v) && !RESERVED.includes(v)
const icon: Check = v => str(v) && v.length <= 64 && ICON.test(v)
const id: Check = v => str(v) && v.length >= 1 && v.length <= 128
const positive: Check = v => num(v) && v > 0 && v <= VIEW_LIMITS.canvasWidth
const optional =
  (check: Check): Check =>
  (v, node, opts) =>
    v === undefined || check(v, node, opts)

const has = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k)
// Every entry, holes too: postMessage keeps a list's length even where it has no element.
const all = (v: readonly unknown[], ok: (x: unknown) => boolean) => {
  for (let i = 0; i < v.length; i++) if (!ok(v[i])) return false
  return true
}
const keys = (v: Rec, ...allowed: string[]) =>
  Object.keys(v).length === allowed.length && allowed.every(k => has(v, k))

const src: Check = (v, _node, opts) => {
  if (str(v)) {
    const target = openTarget(v)
    if (!target || target.scheme !== 'https') return false
    const hosts = (opts.grants ?? []).map(netHost).filter((h): h is string => h !== null)
    return hosts.some(h => netCovers(h, target.site)) || `no net grant for ${target.site}`
  }
  if (!record(v)) return false
  if (keys(v, 'blob')) return str(v.blob) && BLOB.test(v.blob)
  if (!keys(v, 'asset') || !str(v.asset)) return false
  return v.asset.length <= 256 && ASSET.test(v.asset) && !v.asset.split('/').includes('..')
}

const options: Check = v =>
  Array.isArray(v) &&
  v.length <= 200 &&
  all(v, o => record(o) && keys(o, 'value', 'label') && str(o.value) && str(o.label))

// A link inside the app needs nothing; one that leaves it opens through ui.open.
const url: Check = (v, _node, opts) => {
  if (!str(v) || v.length > VIEW_LIMITS.url) return false
  if (v.startsWith('/') && internalPath(v, 'https://app.invalid') !== null) return true
  if (openTarget(v) === null) return false
  return (opts.grants ?? []).includes('ui:open') || 'needs ui:open'
}

const menu: Check = v => Array.isArray(v) && v.length <= 32 && all(v, a => name(a, {}, {}) === true)

// Fields that hold nodes are walked, not checked here.
const NODES: Check = () => true

const box = {
  gap: optional(oneOf(0, 1, 2, 3, 4)),
  align: optional(oneOf('start', 'center', 'end', 'stretch')),
  wrap: optional(bool),
  children: NODES,
  key: optional(name),
  menu: optional(menu),
}
const control = { label: filled, on: name }

const SPECS: Record<string, Record<string, Check>> = {
  stack: box,
  row: box,
  text: {
    text: str,
    style: optional(oneOf('body', 'label', 'title', 'caption', 'code')),
    tone: optional(oneOf(...TONES)),
    name: optional(bool),
  },
  markdown: { text: str },
  icon: { label: filled, name: icon },
  image: {
    src,
    alt: (v, node) => node.decorative === true || filled(v),
    decorative: optional(bool),
    w: optional(positive),
    h: optional(positive),
    fit: optional(oneOf('contain', 'cover')),
  },
  button: {
    ...control,
    icon: optional(icon),
    variant: optional(oneOf('filled', 'tonal', 'text', 'danger')),
    disabled: optional(bool),
  },
  icon_button: { ...control, icon },
  toggle: { ...control, value: bool },
  checkbox: { ...control, value: bool },
  input: {
    ...control,
    value: str,
    placeholder: optional(str),
    multiline: optional(bool),
    max: optional(v => Number.isInteger(v) && (v as number) > 0),
    submit: optional(name),
  },
  select: { ...control, value: str, options },
  slider: {
    ...control,
    min: (v, node) => (num(v) && num(node.max) && v < node.max) || 'bad range',
    max: num,
    value: (v, node) => num(v) && v >= (node.min as number) && v <= (node.max as number),
    step: optional(v => num(v) && v > 0),
  },
  list: { items: NODES, virtual: optional(bool) },
  user: { account: id, username: id },
  place: { account: id, place: record },
  badge: { text: str, tone: optional(oneOf(...TONES)) },
  progress: { value: optional(v => num(v) && v >= 0 && v <= 1) },
  divider: {},
  tabs: { tabs: NODES },
  code: { text: str, lang: optional(v => str(v) && v.length <= 64) },
  link: { text: filled, url },
  canvas: {
    label: filled,
    key: name,
    width: (v, node) =>
      (Number.isInteger(v) &&
        Number.isInteger(node.height) &&
        (v as number) >= 1 &&
        (v as number) <= VIEW_LIMITS.canvasWidth &&
        (node.height as number) >= 1 &&
        (node.height as number) <= VIEW_LIMITS.canvasHeight) ||
      'bad size',
    height: () => true,
  },
  html: { html: str },
  original: {},
  color: { ...control, value: v => str(v) && COLOR.test(v) },
  paint: { ...control, value: record },
}

const OVER = new Error('over')
const ODD = new Error('odd')

// The size of a value as JSON, counted until it passes `left`, or -1 when it holds anything but
// plain objects, arrays and primitives. A view comes by postMessage, which keeps shared parts
// shared and carries typed arrays, so writing it out whole could take exponential time or go
// through millions of indexes. The value is read before `toJSON` turns a date into text.
const size = (v: object, left: number) => {
  let n = 0
  try {
    JSON.stringify(v, function (this: Rec, k: string) {
      const x = this[k]
      if (
        typeof x === 'bigint' ||
        (typeof x === 'object' && x !== null && !Array.isArray(x) && !record(x))
      )
        throw ODD
      n += k.length + 1 + (str(x) ? x.length : 0)
      if (n > left) throw OVER
      return x
    })
    return n
  } catch (e) {
    return e === ODD ? -1 : left + 1
  }
}

// A name from the plugin, cut short for an error line.
const brief = (v: unknown) => (str(v) ? v.slice(0, 40) : typeof v)

// What is wrong with a view, each with where it is; an empty list means the host may draw it.
export const checkView = (view: unknown, opts: ViewOpts = {}): string[] => {
  const errors: string[] = []
  let nodes = 0
  let chars = 0
  const full = () =>
    errors.length >= VIEW_LIMITS.errors || nodes > VIEW_LIMITS.nodes || chars > VIEW_LIMITS.chars
  const fail = (path: string, message: string) => {
    if (errors.length < VIEW_LIMITS.errors) errors.push(path ? `${path}: ${message}` : message)
  }
  // Text counts by its length, and a value checked elsewhere (a place, a paint) by its size.
  // False for a value that is not plain data.
  const count = (v: unknown) => {
    if (str(v)) chars += v.length
    else if (record(v)) {
      const n = size(v, VIEW_LIMITS.chars - chars)
      if (n < 0) return false
      chars += n
    }
    return true
  }
  const join = (path: string, part: string) => (path ? `${path}.${part}` : part)

  const walk = (node: unknown, path: string, depth: number) => {
    if (full()) return
    if (!record(node)) return fail(path, 'not a node')
    if (depth > VIEW_LIMITS.depth) return fail(path, 'too deep')
    nodes += 1
    const type = node.type
    if (!str(type) || !has(SPECS, type)) return fail(path, `unknown node ${brief(type)}`)
    if (type === 'original' && !opts.component)
      return fail(path, 'original is for component points')
    const spec = SPECS[type]
    for (const k of Object.keys(node))
      if (k !== 'type' && !has(spec, k)) fail(path, `${type} has no ${brief(k)}`)
    for (const [field, check] of Object.entries(spec)) {
      const value = node[field]
      const ok = count(value) && check(value, node, opts)
      if (ok === true) continue
      if (field === 'label') fail(path, `${type} needs a label`)
      else if (field === 'alt') fail(path, 'image needs alt text')
      else fail(path, `${type}: ${str(ok) ? ok : `bad ${field}`}`)
    }
    if (type === 'select' && options(node.options, node, opts) === true)
      for (const o of node.options as Rec[]) {
        count(o.value)
        count(o.label)
      }
    for (const field of ['children', 'items'])
      if (has(spec, field)) {
        const list = node[field]
        if (!Array.isArray(list)) fail(path, `${type}: bad ${field}`)
        else each(list, (child, i) => walk(child, join(path, `${field}[${i}]`), depth + 1))
      }
    if (type !== 'tabs') return
    const tabs = node.tabs
    if (!Array.isArray(tabs) || tabs.length < 1) return fail(path, 'tabs: bad tabs')
    each(tabs, (tab, i) => {
      const at = join(path, `tabs[${i}]`)
      if (!record(tab)) return fail(at, 'not a tab')
      for (const k of Object.keys(tab))
        if (k !== 'label' && k !== 'view') fail(at, `tab has no ${brief(k)}`)
      count(tab.label)
      if (!filled(tab.label)) fail(at, 'tab needs a label')
      walk(tab.view, `${at}.view`, depth + 1)
    })
  }
  // Each entry of a list of nodes, holes too; a list longer than the nodes left is too many.
  const each = (list: readonly unknown[], visit: (v: unknown, i: number) => void) => {
    if (list.length > VIEW_LIMITS.nodes - nodes) nodes = VIEW_LIMITS.nodes + 1
    for (let i = 0; i < list.length && !full(); i++) visit(list[i], i)
  }

  walk(view, '', 1)
  if (nodes > VIEW_LIMITS.nodes) return ['too many nodes']
  if (chars > VIEW_LIMITS.chars) return ['too much text']
  return errors
}
