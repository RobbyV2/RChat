import { CATALOG, VIEW_LIMITS } from './catalog'
import type { Node } from './types'

export interface Problem {
  where: string
  what: string
}

// What a view is checked against: the names the app declares, what it requires, and the rule
// checker (the message for a `when` that is not a rule, null for one that is).
export interface ViewContext {
  queries: readonly string[]
  actions: readonly string[]
  capabilities: readonly string[]
  plugin: boolean
  rule: (src: string) => string | null
}

export interface ViewPage {
  route: string
  view: Node
}

type Loose = Record<string, unknown>

const KNOWN = new Set<string>(CATALOG.map(r => r.c))
const CHILDREN = new Set(['stack', 'row', 'section', 'card', 'toolbar', 'dialog', 'scope'])
const ITEM = new Set(['list', 'tree', 'board', 'timeline'])
const ROUTE = /^\/([a-z0-9_-]+|:[a-z_]+)?(\/([a-z0-9_-]+|:[a-z_]+))*$/
const ASSET = /^assets\/[A-Za-z0-9_./-]{1,200}$/
const IMAGE_SRC =
  'An image src is a file of the package (assets/...), not a link; use bind for a file field'

const isObject = (v: unknown): v is Loose =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

const isAsset = (src: unknown): boolean =>
  typeof src === 'string' &&
  ASSET.test(src) &&
  src.split('/').every(part => part !== '' && part !== '.' && part !== '..')

const chars = (view: unknown): number => {
  try {
    return JSON.stringify(view)?.length ?? 0
  } catch {
    return Infinity
  }
}

// The pages of an app are untrusted data: anything that is not a view is a problem, never a throw.
export const validatePages = (pages: readonly ViewPage[], ctx: ViewContext): Problem[] => {
  const out: Problem[] = []
  const p = (where: string, what: string) => {
    out.push({ where, what })
  }
  const queries = new Set<unknown>(ctx.queries)
  const actions = new Set<unknown>(ctx.actions)
  const dialogs = new Set<string>()
  const opens: string[] = []

  const bind = (b: unknown, where: string) => {
    if (isObject(b) && 'query' in b && !queries.has(b.query)) p(where, `No query ${b.query}`)
  }
  const on = (o: unknown, where: string) => {
    if (!isObject(o)) return
    if ('action' in o && !actions.has(o.action)) p(where, `No action ${o.action}`)
    if (o.op === 'open' && typeof o.dialog === 'string') opens.push(o.dialog)
  }
  const parts = (n: Loose, c: string, where: string): unknown[] => {
    if (Array.isArray(n.children)) return n.children
    if (CHILDREN.has(c)) {
      p(where, `${c} needs children`)
      return []
    }
    if (c === 'tabs') {
      if (Array.isArray(n.tabs)) return n.tabs.map(t => (isObject(t) ? t.view : undefined))
      p(where, 'tabs needs tabs')
      return []
    }
    if (c === 'split') return [n.a, n.b]
    if ('item' in n || ITEM.has(c)) return n.empty ? [n.item, n.empty] : [n.item]
    return []
  }
  const walk = (n: unknown, where: string, depth: number, count: { n: number }) => {
    count.n++
    if (depth > VIEW_LIMITS.depth) return p(where, 'Nested too deeply')
    if (!isObject(n) || typeof n.c !== 'string') return p(where, 'Not a component')
    const c = n.c
    if (!KNOWN.has(c)) return p(where, `${c} is not a component`)
    if (c === 'dialog' && typeof n.name === 'string') dialogs.add(n.name)
    if (typeof n.when === 'string' && n.when) {
      const bad = ctx.rule(n.when)
      if (bad !== null) p(where, `when: ${bad}`)
    }
    bind(n.bind, where)
    if (c === 'diff') {
      bind(n.a, where)
      bind(n.b, where)
    }
    on(n.on, where)
    on(n.on_row, where)
    on(n.on_done, where)
    if (Array.isArray(n.menu))
      for (const m of n.menu) if (!actions.has(m)) p(where, `No action ${m} for the menu`)
    if (c === 'frame' && !ctx.capabilities.includes('app_frame'))
      p(where, 'The frame needs the app_frame capability')
    if (c === 'image' && n.src !== undefined && !isAsset(n.src)) p(where, IMAGE_SRC)
    if (c === 'image' && n.src === undefined && !n.bind) p(where, 'An image needs src or bind')
    if (c === 'plugin' && !ctx.plugin) p(where, 'A plugin surface needs requires.plugin')
    parts(n, c, where).forEach((k, i) => walk(k, `${where}/${i}`, depth + 1, count))
  }

  pages.forEach((pg: unknown, i) => {
    if (!isObject(pg) || typeof pg.route !== 'string') return p(`pages[${i}]`, 'Not a page')
    const where = `pages[${pg.route}]`
    const count = { n: 0 }
    walk(pg.view, where, 0, count)
    if (count.n > VIEW_LIMITS.nodes) p(where, `More than ${VIEW_LIMITS.nodes} parts`)
    if (chars(pg.view) > VIEW_LIMITS.chars) p(where, `More than ${VIEW_LIMITS.chars} characters`)
    if (!ROUTE.test(pg.route)) p(where, 'Routes look like /course/:course')
  })
  for (const name of opens)
    if (!dialogs.has(name)) p('pages', `Opens a dialog ${name} that no page has`)
  return out
}
