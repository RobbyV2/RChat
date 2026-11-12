import { expect, test } from 'bun:test'
import { CLOSE, OPEN } from '../spoilers'
import { hideSpoilers, type MdNode } from '../spoiler_tree'

type Fields = Record<string, unknown>

const text = (value: string): MdNode => ({ type: 'text', value })
const node = (type: string, children: MdNode[], fields: Fields = {}): MdNode => ({
  type,
  children,
  ...fields,
})
const leaf = (type: string, fields: Fields): MdNode => ({ type, ...fields })
const p = (...children: MdNode[]) => node('paragraph', children)
const root = (...children: MdNode[]) => node('root', children)

// The tree as a line: hidden parts as `{id:...}`, formatting as `type(...)`.
const read = (n: MdNode): string => {
  const props = (n.data as { hProperties?: Fields } | undefined)?.hProperties
  const inner = (n.children ?? []).map(read).join('')
  if (props && 'data-spoiler' in props) return `{${String(props['data-spoiler'])}:${inner}}`
  if (n.type === 'text') return n.value ?? ''
  if (n.type === 'root' || n.type === 'paragraph') return n.type === 'root' ? inner : `[${inner}]`
  const own = ['value', 'alt', 'url'].flatMap(k => (typeof n[k] === 'string' ? [n[k]] : []))
  return `${n.type}(${[inner, ...own].filter(Boolean).join(' ')})`
}

const hidden = (tree: MdNode, source: string) => {
  hideSpoilers(tree, source)
  return read(tree)
}

// Markdown sources as `markSpoilers` returns them, for the marker count.
const O = OPEN
const C = CLOSE

test('a spoiler among siblings is one hidden span', () => {
  const tree = root(p(text(`a ${O}b `), node('strong', [text('c')]), text(` d${C} e`)))
  expect(hidden(tree, `a ${O}b **c** d${C} e`)).toBe('[a {0:b strong(c) d} e]')
})

test('formatting that ends inside the spoiler hides its part where it is', () => {
  const kinds = ['strong', 'emphasis', 'delete', 'link']
  for (const kind of kinds) {
    const fields = kind === 'link' ? { url: 'u' } : {}
    const tree = root(p(node(kind, [text(`a ${O}secret`)], fields), text(` b${C} c`)))
    expect([kind, hidden(tree, `${O}${C}`)]).toEqual([
      kind,
      kind === 'link' ? '[link(a {0:secret} u){0: b} c]' : `[${kind}(a {0:secret}){0: b} c]`,
    ])
  }
})

test('formatting that starts inside the spoiler hides its part where it is', () => {
  for (const kind of ['strong', 'emphasis', 'delete']) {
    const tree = root(p(text(`a ${O}secret `), node(kind, [text(`b${C} c`)]), text(' d')))
    expect([kind, hidden(tree, `${O}${C}`)]).toEqual([kind, `[a {0:secret }${kind}({0:b} c) d]`])
  }
})

test('nested formatting, and two spoilers that cross different formatting', () => {
  const nested = root(p(node('emphasis', [node('strong', [text(`${O}x`)])]), text(`${C} y`)))
  expect(hidden(nested, `${O}${C}`)).toBe('[emphasis(strong({0:x})) y]')
  const two = root(
    p(
      text(`${O}a `),
      node('delete', [text(`b${C} c`)]),
      text(' '),
      node('strong', [text(`d ${O}e`)]),
      text(` f${C}`)
    )
  )
  expect(hidden(two, `${O}${C}${O}${C}`)).toBe('[{0:a }delete({0:b} c) strong(d {1:e}){1: f}]')
})

test('neighbouring spoilers stay apart', () => {
  const tree = root(p(text(`${O}a${C}${O}b${C}`)))
  expect(hidden(tree, `${O}${C}${O}${C}`)).toBe('[{0:a}{1:b}]')
})

test('a spoiler that runs over blocks hides the text of each block', () => {
  const tree = root(
    p(text(`${O}a`)),
    node('list', [node('listItem', [p(text('b'))]), node('listItem', [p(text(`c${C} d`))])])
  )
  expect(hidden(tree, `${O}${C}`)).toBe('[{0:a}]list(listItem([{0:b}])listItem([{0:c} d]))')
})

test('what can not be split is hidden whole when a spoiler touches it', () => {
  const code = root(p(text(`${O}a `), leaf('inlineCode', { value: 'b' }), text(` c${C}`)))
  expect(hidden(code, `${O}${C}`)).toBe('[{0:a inlineCode(b) c}]')
  const image = root(p(leaf('image', { alt: `${O}alt${C}`, url: 'u' }), text(' t')))
  expect(hidden(image, `${O}${C}`)).toBe('[{0:image(||alt|| u)} t]')
  const target = root(p(text(O), node('link', [text('a')], { url: `u/${C}y` }), text(' z')))
  expect(hidden(target, `${O}${C}`)).toBe('[{0:link(a u/||y)} z]')
  const html = root(leaf('html', { value: `<div>${O}secret${C}</div>` }))
  expect(hidden(html, `${O}${C}`)).toBe('{0:html(<div>||secret||</div>)}')
  const block = root(
    node('list', [node('listItem', [p(text('item')), leaf('code', { value: `${O}secret${C}` })])])
  )
  expect(hidden(block, `${O}${C}`)).toBe('list(listItem([item]{0:code(||secret||)}))')
})

test('a reference whose definition holds a marker is hidden whole', () => {
  const ref = (fields: Fields = {}) =>
    node('linkReference', [text('a')], { identifier: 'r', referenceType: 'full', ...fields })
  const image = leaf('imageReference', { identifier: 'r', referenceType: 'full', alt: 'i' })
  const title = () => leaf('definition', { identifier: 'r', url: 'u', title: `${O}secret${C}` })
  expect(hidden(root(p(ref(), text(' b ')), p(image), title()), `${O}${C}`)).toBe(
    '[{ref:r:linkReference(a)} b ][{ref:r:imageReference(i)}]definition(u)'
  )
  const target = leaf('definition', { identifier: 'r', url: `u/${O}secret${C}` })
  expect(hidden(root(target, p(ref(), text(' b'))), `${O}${C}`)).toBe(
    'definition(u/||secret||)[{ref:r:linkReference(a)} b]'
  )
  // Only the definition that is used counts: the first of a name.
  const clean = leaf('definition', { identifier: 'r', url: 'u' })
  expect(hidden(root(p(ref()), clean, title()), `${O}${C}`)).toBe(
    '[linkReference(a)]definition(u)definition(u)'
  )
  // Inside a spoiler it is one of its pieces.
  const inside = root(p(text(`${O}x `), ref(), text(` y${C}`)), title())
  expect(hidden(inside, `${O}${C}${O}${C}`)).toBe('[{0:x linkReference(a) y}]definition(u)')
})

test('a definition is never a hidden piece: it shows nothing', () => {
  const tree = root(
    p(text(`${O}a`)),
    leaf('definition', { identifier: 'r', url: 'u', title: `b${C} ${O}c${C}` }),
    p(text('d'))
  )
  expect(hidden(tree, `${O}${C}${O}${C}`)).toBe('[{0:a}]definition(u)[d]')
})

test('a footnote whose label holds a marker gets a plain label and keeps its text', () => {
  const label = `${O}x${C}`
  const call = leaf('footnoteReference', { identifier: label, label })
  const note = node('footnoteDefinition', [p(text(`note ${O}secret${C}`))], {
    identifier: label,
    label,
  })
  const other = leaf('footnoteReference', { identifier: 'spoiler-1', label: 'spoiler-1' })
  const tree = root(p(text('a'), call, text(' b'), other), note)
  expect(hidden(tree, `${O}${C}${O}${C}${O}${C}`)).toBe(
    '[a{0:footnoteReference()} bfootnoteReference()]footnoteDefinition([note {2:secret}])'
  )
  expect([call.identifier, call.label, note.identifier, note.label]).toEqual([
    'spoiler-2',
    'spoiler-2',
    'spoiler-2',
    'spoiler-2',
  ])
})

test('a marker that a table cut at its pipe still counts', () => {
  const cell = (...c: MdNode[]) => node('tableCell', c)
  const tree = root(
    node('table', [
      node('tableRow', [cell(text(`x <${O[1]}`)), cell(text(`secret<${C[1]}`)), cell(text('y'))]),
    ])
  )
  expect(hidden(tree, `${O}${C}`)).toBe(
    'table(tableRow(tableCell(x )tableCell({0:secret})tableCell(y)))'
  )
})

test('a message with no spoiler is left alone', () => {
  const tree = root(p(text('a || b'), node('strong', [text('c')])))
  expect(hidden(tree, 'a || b **c**')).toBe('[a || bstrong(c)]')
})

test('when a marker is missing the whole message is hidden', () => {
  const lost = root(p(text('a '), node('strong', [text('secret')]), text(`${C} b`)))
  expect(hidden(lost, `${O}${C}`)).toBe('{all:[a strong(secret) b]}')
  const twice = root(p(text(`${O}a${C} b ${O}c${C}`)))
  expect(hidden(twice, `${O}${C}`)).toBe('{all:[{0:a} b {1:c}]}')
  const order = root(p(text(`${C}a${O} secret`)))
  expect(hidden(order, `${O}${C}`)).toBe('{all:[a{0: secret}]}')
})
