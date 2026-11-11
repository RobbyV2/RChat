// Test-only: the message view's reading of a message as it renders today, to check cues against
// it. It parses with the view's plugins and its own spoiler pass (`hideSpoilers` from
// `lib/spoiler_tree.ts`); `fx_view_reader.test.tsx` fails when it reads differently from the view.
import remarkGfm from 'remark-gfm'
import remarkParse from 'remark-parse'
import { unified } from 'unified'
import { markSpoilers } from '../spoilers'
import { hideSpoilers, type MdNode } from '../spoiler_tree'

const remarkSpoiler = () => (tree: unknown, file: { toString(): string }) =>
  hideSpoilers(tree as MdNode, String(file))

const SKIP = new Set([
  'code',
  'inlineCode',
  'blockquote',
  'html',
  'image',
  'imageReference',
  'definition',
])
const isSpoiler = (n: MdNode) =>
  (n.data as { hProperties?: Record<string, unknown> } | undefined)?.hProperties?.[
    'data-spoiler'
  ] !== undefined
const viewParser = unified().use(remarkParse).use(remarkGfm).use(remarkSpoiler)

// The prose the view shows (spoilers, code, quotes, HTML and images left out), one string.
export function viewProse(markdown: string): string {
  const marked = markSpoilers(markdown)
  const tree = viewParser.runSync(viewParser.parse(marked), marked) as MdNode
  const out: string[] = []
  const walk = (n: MdNode) => {
    if (SKIP.has(n.type) || isSpoiler(n)) return
    if (n.type === 'text') out.push(n.value ?? '')
    for (const c of n.children ?? []) walk(c)
    if (n.type === 'paragraph' || n.type === 'heading' || n.type === 'listItem') out.push('\n')
  }
  walk(tree)
  return out.join('')
}
