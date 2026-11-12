// Spoilers in a parsed message (the markdown renderer's tree). `markSpoilers` left a marker at
// each end of every spoiler in the source, so the hidden text is what lies between an opening
// and a closing marker in reading order, whatever markdown nested around the markers:
// - Text between the markers is wrapped where it is, so `**||a**||` hides `a` inside the bold
//   and `||a **b|| c**` hides `a` and `b` and shows `c`. The pieces of one spoiler carry the
//   same number and reveal together.
// - What can't be split is hidden whole when a spoiler touches it: code, images, raw HTML, and
//   a link whose target or title holds a marker, also when they come from its definition
//   (`[a][r]` with `[r]: url "title"`), or whose definition lies inside a spoiler.
// - What shows nothing where it stands is no piece: a definition, and a footnote's text, which
//   is hidden where it is shown. A footnote label that holds a marker is replaced by a plain
//   one, so the ids and links made from it say nothing.
// - Every marker must be found, in order. If not, the whole message is hidden.
import { CLOSE, OPEN } from './spoilers'

const START = OPEN[1]
const END = CLOSE[1]

// A marker, also one whose pipe a table took for a cell edge.
const MARK = new RegExp(`(<[${START}${END}]\\|?)`)

export interface MdNode {
  type: string
  value?: string
  children?: MdNode[]
  data?: unknown
  [field: string]: unknown
}

// Nodes whose children are inline content.
const INLINE = new Set([
  'paragraph',
  'heading',
  'tableCell',
  'emphasis',
  'strong',
  'delete',
  'link',
  'linkReference',
])

// The text a node holds outside its children, in source order.
const FIELDS: Record<string, string[]> = {
  text: ['value'],
  inlineCode: ['value'],
  html: ['value'],
  code: ['lang', 'meta', 'value'],
  image: ['alt', 'url', 'title'],
  imageReference: ['alt'],
  link: ['url', 'title'],
  definition: ['label', 'url', 'title'],
  footnoteReference: ['label'],
  footnoteDefinition: ['label'],
}

const fieldsOf = (node: MdNode) => {
  const full = node.referenceType === 'full'
  const label = full && (node.type === 'linkReference' || node.type === 'imageReference')
  return [...(FIELDS[node.type] ?? []), ...(label ? ['label'] : [])]
}

const marksIn = (text: unknown) =>
  typeof text === 'string' ? Array.from(text).filter(c => c === START || c === END) : []

const ownMarks = (node: MdNode) => fieldsOf(node).flatMap(f => marksIn(node[f]))

// Every marker in `node`, in source order (a link's text comes before its target).
const marksOf = (node: MdNode): string[] => {
  const inner = (node.children ?? []).flatMap(marksOf)
  return node.type === 'link' ? [...inner, ...ownMarks(node)] : [...ownMarks(node), ...inner]
}

interface Walk {
  open: boolean
  id: number
  seen: string[]
  // Names of the definitions whose target or title holds a marker, or that lie in a spoiler.
  refs: ReadonlySet<string>
}

// Names are compared the way the renderer does when it looks a definition up.
const nameOf = (node: MdNode) => String(node.identifier ?? '').toUpperCase()

const each = (node: MdNode, f: (node: MdNode) => void) => {
  f(node)
  node.children?.forEach(child => each(child, f))
}

// Each spoiler of `source` as [opening marker, closing marker] indices.
const spansOf = (source: string) => {
  const spans: [number, number][] = []
  let from = -1
  for (let i = 0; i < source.length; i += 1) {
    if (source[i] === START) from = i
    else if (source[i] === END && from >= 0) {
      spans.push([from, i])
      from = -1
    }
  }
  return spans
}

const startsInside = (node: MdNode, spans: [number, number][]) => {
  const at = (node.position as { start?: { offset?: number } } | undefined)?.start?.offset
  return at !== undefined && spans.some(([from, to]) => at > from && at < to)
}

// A reference takes its target and title from the first definition of its name.
const markedDefinitions = (tree: MdNode, source: string) => {
  const spans = spansOf(source)
  const marked = new Map<string, boolean>()
  each(tree, node => {
    if (node.type === 'definition' && !marked.has(nameOf(node)))
      marked.set(
        nameOf(node),
        marksIn(node.url).length + marksIn(node.title).length > 0 || startsInside(node, spans)
      )
  })
  return new Set([...marked].filter(([, yes]) => yes).map(([name]) => name))
}

const refersTo = (node: MdNode, refs: ReadonlySet<string>) =>
  (node.type === 'linkReference' || node.type === 'imageReference') && refs.has(nameOf(node))

const holdsRef = (node: MdNode, refs: ReadonlySet<string>): boolean =>
  refersTo(node, refs) || (node.children ?? []).some(child => holdsRef(child, refs))

const FOOTNOTES = new Set(['footnoteReference', 'footnoteDefinition'])

// Footnote labels that hold a marker become `spoiler-1`, `spoiler-2`, ... (skipping names in use).
const plainFootnotes = (tree: MdNode) => {
  const used = new Set<string>()
  each(tree, node => {
    if (FOOTNOTES.has(node.type)) used.add(nameOf(node))
  })
  const plain = new Map<string, string>()
  let n = 0
  each(tree, node => {
    if (!FOOTNOTES.has(node.type)) return
    const name = nameOf(node)
    if (!marksIn(node.label).length && !marksIn(node.identifier).length) return
    if (!plain.has(name)) {
      do n += 1
      while (used.has(`SPOILER-${n}`))
      plain.set(name, `spoiler-${n}`)
    }
    node.identifier = node.label = plain.get(name)
  })
}

const wrap = (tag: 'span' | 'div', id: number | string, children: MdNode[]): MdNode => ({
  type: tag === 'span' ? 'emphasis' : 'blockquote',
  data: { hName: tag, hProperties: { 'data-spoiler': String(id) } },
  children,
})

const step = (st: Walk, mark: string) => {
  st.seen.push(mark)
  st.open = mark === START
  if (st.open) st.id += 1
}

const hideIn = (node: MdNode, st: Walk) => {
  const { children } = node
  if (!children) return
  const inline = INLINE.has(node.type)
  const out: MdNode[] = []
  let group: { id: number | string; nodes: MdNode[] } | null = null
  const flush = () => {
    if (group) out.push(wrap(inline ? 'span' : 'div', group.id, group.nodes))
    group = null
  }
  const hide = (child: MdNode, id: number | string) => {
    if (group && group.id !== id) flush()
    group ??= { id, nodes: [] }
    group.nodes.push(child)
  }
  const show = (child: MdNode) => {
    flush()
    out.push(child)
  }
  for (const child of children) {
    if (child.type === 'text' && inline) {
      for (const piece of (child.value ?? '').split(MARK)) {
        if (!piece) continue
        if (!MARK.test(piece)) {
          const text = { type: 'text', value: piece }
          if (st.open) hide(text, st.id)
          else show(text)
          continue
        }
        if (piece[1] === END) flush()
        step(st, piece[1])
      }
      continue
    }
    if (child.type === 'definition' || child.type === 'footnoteDefinition') {
      flush()
      ownMarks(child).forEach(mark => step(st, mark))
      hideIn(child, st)
      out.push(child)
      continue
    }
    const marks = marksOf(child)
    const referred = refersTo(child, st.refs)
    const walk = !inline || marks.length > 0 || holdsRef(child, st.refs)
    if (child.children && !ownMarks(child).length && !referred && walk) {
      flush()
      hideIn(child, st)
      out.push(child)
      continue
    }
    const id = st.open ? st.id : marks.length ? st.id + 1 : `ref:${String(child.identifier)}`
    const touched = st.open || marks.length > 0 || referred
    marks.forEach(mark => step(st, mark))
    if (touched) hide(child, id)
    else show(child)
  }
  flush()
  node.children = out
}

// Nodes whose `title` is shown as a tooltip.
const TITLED = new Set(['link', 'definition'])

// Markers left in fields become the `||` that was written. A title loses them: its link is
// hidden whole, and once revealed the tooltip reads as text.
const unmark = (node: MdNode) => {
  for (const key of Object.keys(node)) {
    const text = node[key]
    if (key !== 'type' && typeof text === 'string' && MARK.test(text))
      node[key] = text.replace(
        new RegExp(MARK, 'g'),
        key === 'title' && TITLED.has(node.type) ? '' : '||'
      )
  }
  node.children?.forEach(unmark)
}

// Hides the spoilers of `tree`, parsed from `source` (the text `markSpoilers` returned).
export const hideSpoilers = (tree: MdNode, source: string) => {
  const spoilers = Array.from(source).filter(c => c === START).length
  if (!spoilers) return
  const st: Walk = { open: false, id: -1, seen: [], refs: markedDefinitions(tree, source) }
  hideIn(tree, st)
  const paired =
    st.seen.length === spoilers * 2 && st.seen.every((mark, i) => mark === (i % 2 ? END : START))
  if (!paired) tree.children = [wrap('div', 'all', tree.children ?? [])]
  plainFootnotes(tree)
  unmark(tree)
}
