import { describe, expect, test } from 'bun:test'
import { netCovers } from '../plugins/perm_text'
import { VIEW_LIMITS, checkView } from '../plugins/view_check'
import vectors from './fixtures/plugins_vectors.json'

const text = (t = 'hi') => ({ type: 'text', text: t })
const first = (view: unknown, opts = {}) => checkView(view, opts)[0]

const EVERY: Record<string, unknown> = {
  stack: {
    type: 'stack',
    gap: 2,
    align: 'center',
    wrap: true,
    children: [text()],
    key: 'k1',
    menu: ['roll'],
  },
  row: { type: 'row', children: [] },
  text: { type: 'text', text: 'Bo', style: 'label', tone: 'muted', name: true },
  markdown: { type: 'markdown', text: '**hi**' },
  icon: { type: 'icon', name: 'dice-5', label: 'Dice' },
  image: { type: 'image', src: { asset: 'img/cat.png' }, alt: 'A cat', w: 64, h: 64, fit: 'cover' },
  button: {
    type: 'button',
    label: 'Roll',
    icon: 'dice-5',
    variant: 'tonal',
    on: 'roll',
    disabled: false,
  },
  icon_button: { type: 'icon_button', icon: 'x', label: 'Close', on: 'close' },
  toggle: { type: 'toggle', label: 'Sound', value: true, on: 'sound' },
  checkbox: { type: 'checkbox', label: 'Keep', value: false, on: 'keep' },
  input: {
    type: 'input',
    label: 'Name',
    value: '',
    placeholder: 'Bo',
    multiline: true,
    max: 80,
    on: 'name',
    submit: 'save',
  },
  select: {
    type: 'select',
    label: 'Sides',
    value: '6',
    options: [{ value: '6', label: 'Six' }],
    on: 'sides',
  },
  slider: { type: 'slider', label: 'Size', value: 2, min: 1, max: 5, step: 0.5, on: 'size' },
  list: { type: 'list', items: [text(), text()], virtual: true },
  user: { type: 'user', account: 'a1', username: 'bo' },
  place: { type: 'place', account: 'a1', place: { kind: 'channel', id: 'c1' } },
  badge: { type: 'badge', text: 'New', tone: 'primary' },
  progress: { type: 'progress', value: 0.4 },
  divider: { type: 'divider' },
  tabs: { type: 'tabs', tabs: [{ label: 'One', view: text() }] },
  code: { type: 'code', text: 'x = 1', lang: 'py' },
  link: { type: 'link', text: 'Docs', url: 'https://example.com/docs' },
  canvas: { type: 'canvas', key: 'board', width: 320, height: 200, label: 'Board' },
  html: { type: 'html', html: '<p>hi</p>' },
  color: { type: 'color', label: 'Tint', value: '#00aaff', on: 'tint' },
  paint: { type: 'paint', label: 'Fill', value: { kind: 'solid', color: '#00aaff' }, on: 'fill' },
}

describe('views: what a plugin may send', () => {
  test('every node type in its full form passes', () => {
    expect(Object.keys(EVERY)).toHaveLength(26)
    for (const [name, view] of Object.entries(EVERY)) {
      const errors = checkView(view, { grants: ['ui:open'] })
      if (errors.length) throw new Error(`${name}: ${errors.join('; ')}`)
    }
  })

  test('a tree of them passes, and the answer says where an error is', () => {
    const tree = {
      type: 'stack',
      children: [EVERY.tabs, { type: 'list', items: [EVERY.row, { type: 'icon', name: 'x' }] }],
    }
    expect(checkView(tree)).toEqual(['children[1].items[1]: icon needs a label'])
    expect(checkView({ type: 'tabs', tabs: [{ label: 'A', view: { type: 'nope' } }] })).toEqual([
      'tabs[0].view: unknown node nope',
    ])
  })

  test('what is not a node is refused', () => {
    for (const bad of [null, undefined, 'text', 7, [], [text()]])
      expect(first(bad)).toBe('not a node')
    expect(first({})).toBe('unknown node undefined')
    expect(first({ type: 'frame', url: 'https://example.com' })).toBe('unknown node frame')
    expect(first({ type: 'script' })).toBe('unknown node script')
    expect(first({ type: 'toString' })).toBe('unknown node toString')
    expect(first({ type: { toString: () => 'text' } })).toBe('unknown node object')
    expect(first({ type: 'x'.repeat(5000) })).toBe(`unknown node ${'x'.repeat(40)}`)
    expect(first({ type: 'divider', ['k'.repeat(5000)]: 1 })).toBe(
      `divider has no ${'k'.repeat(40)}`
    )
  })

  test('a field a node does not have is refused: no password inputs, no raw colors', () => {
    expect(first({ ...text(), color: '#ff0000' })).toBe('text has no color')
    expect(first({ ...text(), tone: '#ff0000' })).toBe('text: bad tone')
    expect(first({ type: 'input', label: 'Key', value: '', on: 'k', password: true })).toBe(
      'input has no password'
    )
    expect(first({ type: 'input', label: 'Key', value: '', on: 'k', kind: 'password' })).toBe(
      'input has no kind'
    )
    expect(first({ type: 'divider', style: 'x' })).toBe('divider has no style')
    expect(first({ ...text(), motion: 'plugin.dice.roll' })).toBe('text has no motion')
    expect(first({ type: 'button', label: 'Go', on: 'go', href: 'https://example.com' })).toBe(
      'button has no href'
    )
  })

  test('the original node is for component points only', () => {
    expect(first({ type: 'original' })).toBe('original is for component points')
    expect(
      checkView({ type: 'stack', children: [{ type: 'original' }, text()] }, { component: true })
    ).toEqual([])
  })
})

describe('views: labels', () => {
  test('icons, icon buttons, canvases and controls need a label', () => {
    const cases: [object, string][] = [
      [{ type: 'icon', name: 'x' }, 'icon needs a label'],
      [{ type: 'icon', name: 'x', label: ' ' }, 'icon needs a label'],
      [{ type: 'icon_button', icon: 'x', on: 'close' }, 'icon_button needs a label'],
      [{ type: 'canvas', key: 'b', width: 10, height: 10 }, 'canvas needs a label'],
      [{ type: 'button', on: 'go' }, 'button needs a label'],
      [{ type: 'toggle', value: true, on: 't' }, 'toggle needs a label'],
      [{ type: 'checkbox', value: true, on: 't', label: '' }, 'checkbox needs a label'],
      [{ type: 'input', value: '', on: 't' }, 'input needs a label'],
      [{ type: 'select', value: '', options: [], on: 't' }, 'select needs a label'],
      [{ type: 'slider', value: 1, min: 0, max: 2, on: 't' }, 'slider needs a label'],
      [{ type: 'color', value: '#000000', on: 't' }, 'color needs a label'],
      [{ type: 'paint', value: {}, on: 't' }, 'paint needs a label'],
      [{ type: 'tabs', tabs: [{ view: text() }] }, 'tabs[0]: tab needs a label'],
    ]
    for (const [view, want] of cases)
      if (first(view) !== want) throw new Error(`${first(view)} vs ${want}`)
  })

  test('an image needs alt text unless it is decorative', () => {
    const src = { asset: 'a.png' }
    expect(first({ type: 'image', src })).toBe('image needs alt text')
    expect(first({ type: 'image', src, alt: '' })).toBe('image needs alt text')
    expect(checkView({ type: 'image', src, alt: '', decorative: true })).toEqual([])
    expect(checkView({ type: 'image', src, decorative: true })).toEqual([])
  })
})

describe('views: images', () => {
  const img = (src: unknown) => ({ type: 'image', src, alt: 'x' })

  test("the plugin's own assets and blobs", () => {
    for (const src of [{ asset: 'a.png' }, { asset: 'img/dir/a.b.svg' }, { blob: 'shot-1' }])
      expect(checkView(img(src))).toEqual([])
    for (const src of [
      { asset: '/a.png' },
      { asset: '../a.png' },
      { asset: 'a/../../b.png' },
      { asset: 'a\\b.png' },
      { asset: 'https://example.com/a.png' },
      { asset: '' },
      { asset: 'a'.repeat(300) },
      { asset: 'a.png', blob: 'x' },
      { blob: '' },
      { url: 'a.png' },
      {},
      null,
      7,
    ])
      expect(first(img(src))).toBe('image: bad src')
  })

  test('a blob ref is an id, never an address or a path', () => {
    for (const blob of ['shot-1', 'A_b-9', 'x'.repeat(128)])
      expect(checkView(img({ blob }))).toEqual([])
    for (const blob of [
      'https://evil.example/x.png',
      'blob:https://app.example/1234',
      '../../other/x',
      'a/b',
      'a.png',
      'a b',
      'x'.repeat(129),
      7,
    ])
      expect(first(img({ blob }))).toBe('image: bad src')
  })

  test('an https image needs a net grant for its host', () => {
    const url = 'https://cdn.example.com/cat.png'
    expect(first(img(url))).toBe('image: no net grant for cdn.example.com')
    expect(checkView(img(url), { grants: ['net:cdn.example.com'] })).toEqual([])
    expect(checkView(img(url), { grants: ['read:messages', 'net:*.example.com'] })).toEqual([])
    expect(checkView(img(url), { grants: ['net:*'] })).toEqual([])
    expect(first(img('https://127.0.0.1/cat.png'), { grants: ['net:*.0.0.1'] })).toBe(
      'image: no net grant for 127.0.0.1'
    )
    expect(checkView(img('https://127.0.0.1/cat.png'), { grants: ['net:127.0.0.1'] })).toEqual([])
    expect(
      first(img(url), { grants: ['net:example.com', 'net:*.cdn.example.com.evil.example'] })
    ).toBe('image: no net grant for cdn.example.com')
  })

  test('no other address is an image', () => {
    for (const src of [
      'http://cdn.example.com/cat.png',
      'data:image/png;base64,AAAA',
      'blob:https://example.com/1',
      'javascript:alert(1)',
      '//cdn.example.com/cat.png',
      'cat.png',
      'asset:cat.png',
      'https://user@cdn.example.com/cat.png',
    ])
      expect(first(img(src), { grants: ['net:*'] })).toBe('image: bad src')
  })

  test('net grants cover hosts as the model says', () => {
    const net = vectors.cover.filter(c =>
      [...c.granted, ...c.requested].every(p => p.startsWith('net:'))
    )
    expect(net).toHaveLength(7)
    for (const c of net) {
      const got = c.requested.every(r => c.granted.some(g => netCovers(g.slice(4), r.slice(4))))
      if (got !== c.want) throw new Error(JSON.stringify(c))
    }
  })
})

describe('views: caps', () => {
  const nest = (n: number): unknown =>
    n === 1 ? text() : { type: 'stack', children: [nest(n - 1)] }
  const wide = (n: number) => ({
    type: 'list',
    items: Array.from({ length: n - 1 }, () => ({ type: 'divider' })),
  })

  test('32 levels deep', () => {
    expect(checkView(nest(VIEW_LIMITS.depth))).toEqual([])
    expect(first(nest(VIEW_LIMITS.depth + 1))).toContain('too deep')
  })

  test('2,000 nodes', () => {
    expect(checkView(wide(VIEW_LIMITS.nodes))).toEqual([])
    expect(checkView(wide(VIEW_LIMITS.nodes + 1))).toEqual(['too many nodes'])
  })

  test('100,000 characters', () => {
    const fill = (n: number) => ({
      type: 'stack',
      children: [text('a'.repeat(n - 5)), { type: 'badge', text: 'b'.repeat(5) }],
    })
    expect(checkView(fill(VIEW_LIMITS.chars))).toEqual([])
    expect(checkView(fill(VIEW_LIMITS.chars + 1))).toEqual(['too much text'])
  })

  test('a place or a paint counts by its size, so it cannot carry a megabyte past the cap', () => {
    const place = (id: string) => ({ type: 'place', account: 'a1', place: { kind: 'channel', id } })
    const paint = (color: string) => ({
      type: 'paint',
      label: 'Fill',
      value: { kind: 'solid', color },
      on: 'fill',
    })
    expect(checkView(place('c1'))).toEqual([])
    expect(checkView(place('x'.repeat(VIEW_LIMITS.chars)))).toEqual(['too much text'])
    expect(checkView(paint('x'.repeat(500_000)))).toEqual(['too much text'])
    expect(
      checkView({ type: 'list', items: Array.from({ length: 30 }, () => place('x'.repeat(4000))) })
    ).toEqual(['too much text'])
    const loop: Record<string, unknown> = { kind: 'channel' }
    loop.self = loop
    expect(checkView({ type: 'place', account: 'a1', place: loop })).toEqual(['too much text'])
  })

  test('a value whose parts are shared is counted only up to the cap', () => {
    let reads = 0
    let shared: Record<string, unknown> = {
      get leaf() {
        reads += 1
        return 'x'
      },
    }
    for (let i = 0; i < 40; i++) shared = { a: shared, b: shared }
    for (const view of [
      { type: 'place', account: 'a1', place: shared },
      { type: 'text', text: shared },
      { type: 'image', src: shared, alt: 'x' },
      { type: 'toggle', label: 'x', on: 'go', value: shared },
      {
        type: 'stack',
        children: [
          { type: 'text', text: 'x'.repeat(99_990) },
          { type: 'place', account: 'a1', place: shared },
        ],
      },
    ]) {
      reads = 0
      expect(checkView(view)).toEqual(['too much text'])
      expect(reads).toBeLessThan(VIEW_LIMITS.chars)
    }
  })

  test('only plain data is read: a typed array or a wrapped string is refused, not walked', () => {
    const bytes = new Uint8Array(10_000_000)
    const words = new String('x'.repeat(VIEW_LIMITS.chars * 2))
    for (const [view, error] of [
      [{ type: 'place', account: 'a1', place: bytes }, 'place: bad place'],
      [{ type: 'place', account: 'a1', place: { kind: 'channel', id: bytes } }, 'place: bad place'],
      [{ type: 'place', account: 'a1', place: { kind: 'channel', id: words } }, 'place: bad place'],
      [{ type: 'place', account: 'a1', place: [{ id: words }] }, 'place: bad place'],
      [
        { type: 'place', account: 'a1', place: { kind: 'channel', id: BigInt(1) } },
        'place: bad place',
      ],
      [{ type: 'paint', label: 'Fill', on: 'fill', value: new Map() }, 'paint: bad value'],
      [{ type: 'image', src: bytes, alt: 'x' }, 'image: bad src'],
      [{ type: 'image', src: words, alt: 'x' }, 'image: bad src'],
      [{ type: 'text', text: words }, 'text: bad text'],
      [{ type: 'stack', children: [bytes] }, 'children[0]: not a node'],
      [{ type: 'tabs', tabs: [bytes] }, 'tabs[0]: not a tab'],
      [
        { type: 'select', label: 'x', on: 'go', value: 'a', options: [bytes] },
        'select: bad options',
      ],
    ] as const) {
      const start = performance.now()
      expect(checkView(view)).toEqual([error])
      expect(performance.now() - start).toBeLessThan(1000)
    }
    expect(checkView({ type: 'place', account: 'a1', place: Object.create(null) })).toEqual([])
  })

  test('a list is never read further than the caps, whatever length it claims', () => {
    const huge: unknown[] = []
    huge.length = 2 ** 32 - 1
    const select = { type: 'select', label: 'x', on: 'go', value: 'a' }
    for (const [view, want] of [
      [{ type: 'stack', children: huge }, 'too many nodes'],
      [{ type: 'list', items: huge }, 'too many nodes'],
      [{ type: 'tabs', tabs: huge }, 'too many nodes'],
      [{ type: 'stack', children: [{ type: 'list', items: huge }] }, 'too many nodes'],
      [
        { type: 'tabs', tabs: [{ label: 'A', view: { type: 'row', children: huge } }] },
        'too many nodes',
      ],
      [{ ...select, options: huge }, 'select: bad options'],
      [{ type: 'text', text: 'x', options: huge }, 'text has no options'],
      [{ type: 'stack', children: [], menu: huge }, 'stack: bad menu'],
      [{ type: 'place', account: 'a1', place: { id: huge } }, 'too much text'],
      [{ type: 'paint', label: 'Fill', on: 'fill', value: { stops: huge } }, 'too much text'],
    ] as const) {
      const start = performance.now()
      expect(checkView(view)).toEqual([want])
      expect(performance.now() - start).toBeLessThan(1000)
    }
    const many = Array.from({ length: VIEW_LIMITS.nodes - 1 }, text)
    expect(checkView({ type: 'stack', children: many })).toEqual([])
    expect(checkView({ type: 'stack', children: [...many, text()] })).toEqual(['too many nodes'])
    const tabs = (views: unknown[]) => ({
      type: 'tabs',
      tabs: views.map(view => ({ label: 'A', view })),
    })
    expect(checkView(tabs(many))).toEqual([])
    expect(checkView(tabs([...many, text()]))).toEqual(['too many nodes'])
    const gaps: unknown[] = []
    gaps.length = VIEW_LIMITS.nodes - 1
    expect(checkView({ type: 'stack', children: gaps })).toHaveLength(VIEW_LIMITS.errors)
    gaps.length += 1
    expect(checkView({ type: 'stack', children: gaps })).toEqual(['too many nodes'])
    const option = { value: 'x'.repeat(1000), label: 'x'.repeat(1000) }
    expect(checkView({ ...select, options: Array(201).fill(option) })).toEqual([
      'select: bad options',
    ])
    expect(checkView({ ...select, options: Array(200).fill(option) })).toEqual(['too much text'])
  })

  test('a hole in a list is not an entry', () => {
    const holes = (...items: unknown[]) => {
      const list = [...items]
      list.length += 2
      return list
    }
    const select = { type: 'select', label: 'x', on: 'go', value: 'a' }
    expect(checkView({ type: 'stack', children: holes(text()) })).toEqual([
      'children[1]: not a node',
      'children[2]: not a node',
    ])
    expect(checkView({ type: 'list', items: holes() })).toEqual([
      'items[0]: not a node',
      'items[1]: not a node',
    ])
    expect(checkView({ type: 'tabs', tabs: holes({ label: 'A', view: text() }) })).toEqual([
      'tabs[1]: not a tab',
      'tabs[2]: not a tab',
    ])
    expect(checkView({ ...select, options: holes({ value: 'a', label: 'A' }) })).toEqual([
      'select: bad options',
    ])
    expect(checkView({ type: 'stack', children: [], menu: holes('roll') })).toEqual([
      'stack: bad menu',
    ])
  })

  test('a date in a place or a paint is not plain data', () => {
    expect(checkView({ type: 'place', account: 'a1', place: { at: new Date(0) } })).toEqual([
      'place: bad place',
    ])
    expect(
      checkView({
        type: 'paint',
        label: 'Fill',
        on: 'fill',
        value: { kind: 'solid', at: new Date(0) },
      })
    ).toEqual(['paint: bad value'])
    expect(checkView({ type: 'place', account: 'a1', place: { at: '1970-01-01' } })).toEqual([])
  })

  test('a view that loops back on itself is refused, not followed', () => {
    const loop: { type: string; children: unknown[] } = { type: 'stack', children: [] }
    loop.children.push(loop)
    expect(first(loop)).toContain('too deep')
  })

  test('at most 20 errors are listed', () => {
    const bad = { type: 'list', items: Array.from({ length: 50 }, () => ({ type: 'nope' })) }
    expect(checkView(bad)).toHaveLength(20)
  })

  test('the limits', () => {
    expect(VIEW_LIMITS).toEqual({
      depth: 32,
      nodes: 2000,
      chars: 100000,
      canvasWidth: 3840,
      canvasHeight: 2160,
      url: 2048,
      errors: 20,
    })
  })
})

describe('views: fields', () => {
  test('closed choices', () => {
    const cases: [object, string][] = [
      [{ type: 'stack', children: [], gap: 5 }, 'stack: bad gap'],
      [{ type: 'stack', children: [], gap: 1.5 }, 'stack: bad gap'],
      [{ type: 'row', children: [], align: 'middle' }, 'row: bad align'],
      [{ type: 'row', children: [], wrap: 'yes' }, 'row: bad wrap'],
      [{ type: 'row' }, 'row: bad children'],
      [{ type: 'row', children: {} }, 'row: bad children'],
      [{ type: 'text', text: 'x', style: 'huge' }, 'text: bad style'],
      [{ type: 'text', text: 7 }, 'text: bad text'],
      [{ type: 'text' }, 'text: bad text'],
      [{ type: 'badge', text: 'x', tone: 'loud' }, 'badge: bad tone'],
      [{ type: 'button', label: 'Go', on: 'go', variant: 'huge' }, 'button: bad variant'],
      [{ type: 'image', src: { asset: 'a.png' }, alt: 'x', fit: 'fill' }, 'image: bad fit'],
      [{ type: 'image', src: { asset: 'a.png' }, alt: 'x', w: -1 }, 'image: bad w'],
      [{ type: 'progress', value: 2 }, 'progress: bad value'],
      [{ type: 'icon', name: 'Dice 5', label: 'x' }, 'icon: bad name'],
      [{ type: 'button', label: 'Go', on: 'go', icon: '../x' }, 'button: bad icon'],
      [{ type: 'user', account: 'a1' }, 'user: bad username'],
      [{ type: 'place', account: 'a1', place: 'c1' }, 'place: bad place'],
      [{ type: 'list', items: 'x' }, 'list: bad items'],
      [{ type: 'tabs', tabs: [] }, 'tabs: bad tabs'],
      [
        { type: 'tabs', tabs: [{ label: 'A', view: text(), extra: 1 }] },
        'tabs[0]: tab has no extra',
      ],
      [{ type: 'code', text: 'x', lang: 7 }, 'code: bad lang'],
      [{ type: 'html', html: 7 }, 'html: bad html'],
      [{ type: 'color', label: 'Tint', value: 'red', on: 't' }, 'color: bad value'],
      [{ type: 'paint', label: 'Fill', value: 'red', on: 't' }, 'paint: bad value'],
    ]
    for (const [view, want] of cases)
      if (first(view) !== want) throw new Error(`${first(view)} vs ${want}`)
  })

  test('controls', () => {
    const cases: [object, string][] = [
      [{ type: 'toggle', label: 'x', value: 'on', on: 't' }, 'toggle: bad value'],
      [{ type: 'input', label: 'x', value: 7, on: 't' }, 'input: bad value'],
      [{ type: 'input', label: 'x', value: '', on: 't', max: 0 }, 'input: bad max'],
      [{ type: 'input', label: 'x', value: '', on: 't', multiline: 1 }, 'input: bad multiline'],
      [{ type: 'select', label: 'x', value: 'a', options: 'a', on: 't' }, 'select: bad options'],
      [
        { type: 'select', label: 'x', value: 'a', options: [{ value: 'a' }], on: 't' },
        'select: bad options',
      ],
      [
        {
          type: 'select',
          label: 'x',
          value: 'a',
          options: [{ value: 'a', label: 'A', icon: 'x' }],
          on: 't',
        },
        'select: bad options',
      ],
      [{ type: 'slider', label: 'x', value: 1, min: 2, max: 2, on: 't' }, 'slider: bad range'],
      [{ type: 'slider', label: 'x', value: 9, min: 0, max: 2, on: 't' }, 'slider: bad value'],
      [
        { type: 'slider', label: 'x', value: 1, min: 0, max: 2, step: 0, on: 't' },
        'slider: bad step',
      ],
      [{ type: 'slider', label: 'x', value: NaN, min: 0, max: 2, on: 't' }, 'slider: bad value'],
    ]
    for (const [view, want] of cases)
      if (first(view) !== want) throw new Error(`${first(view)} vs ${want}`)
  })

  test('handlers are named, and never with a reserved name', () => {
    const b = (on: unknown) => ({ type: 'button', label: 'Go', on })
    for (const on of ['go', 'dice.roll', 'a-b_c:1']) expect(checkView(b(on))).toEqual([])
    for (const on of [
      undefined,
      '',
      7,
      'a b',
      '__proto__',
      'constructor',
      'prototype',
      'x'.repeat(65),
      '() => 1',
    ])
      expect(first(b(on))).toBe('button: bad on')
    expect(first({ type: 'input', label: 'x', value: '', on: 't', submit: '__proto__' })).toBe(
      'input: bad submit'
    )
    expect(first({ type: 'stack', children: [], key: '__proto__' })).toBe('stack: bad key')
    expect(first({ type: 'stack', children: [], menu: ['ok', 'not ok'] })).toBe('stack: bad menu')
    expect(first({ type: 'stack', children: [], menu: 'roll' })).toBe('stack: bad menu')
  })

  test('a canvas is at most 3840 by 2160', () => {
    const c = (width: unknown, height: unknown) => ({
      type: 'canvas',
      key: 'b',
      label: 'Board',
      width,
      height,
    })
    expect(checkView(c(3840, 2160))).toEqual([])
    expect(checkView(c(1, 1))).toEqual([])
    for (const [w, h] of [
      [3841, 100],
      [100, 2161],
      [0, 100],
      [100, -1],
      [1.5, 100],
      ['100', 100],
      [NaN, 1],
    ])
      expect(first(c(w, h))).toBe('canvas: bad size')
    expect(first({ type: 'canvas', label: 'x', width: 1, height: 1 })).toBe('canvas: bad key')
  })

  test('a link inside the app needs nothing; one that leaves it needs ui:open', () => {
    const l = (url: unknown) => ({ type: 'link', text: 'x', url })
    for (const url of ['/channels/1', '/plugin/dice/board']) expect(checkView(l(url))).toEqual([])
    expect(first(l('https://app.invalid/channels/1'))).toBe('link: needs ui:open')
    expect(first(l('HTTPS://APP.INVALID/'))).toBe('link: needs ui:open')
    for (const url of ['https://example.com/', 'mailto:a@b.example']) {
      expect(checkView(l(url), { grants: ['ui:open'] })).toEqual([])
      expect(first(l(url))).toBe('link: needs ui:open')
      expect(first(l(url), { grants: ['net:*', 'ui:slots'] })).toBe('link: needs ui:open')
    }
  })

  test('a link is at most 2,048 characters of text that could be a link', () => {
    const l = (url: unknown) => ({ type: 'link', text: 'x', url })
    const grants = ['ui:open']
    for (const url of [
      7,
      '',
      'javascript:alert(1)',
      'http://example.com',
      '//example.com',
      '/..//evil.example/x',
      '/.//evil.example',
      '/a/..//evil.example',
      'x'.repeat(2049),
      '/a b',
    ])
      expect(first(l(url), { grants })).toBe('link: bad url')
    expect(first({ type: 'link', url: 'https://example.com/' }, { grants })).toBe('link: bad text')
  })
})
